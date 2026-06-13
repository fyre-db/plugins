import { describe, it, expect, vi } from 'vitest';
import { ServerAuthService } from '@/auth/server-auth-service';
import type { ServerAuthAdapter } from '@/auth/types';
import { generateState, encodeRefreshCookie } from '@/auth/oauth-utils';

const DEFAULT_OPTS = {
  basePath: '/api/auth',
  refreshCookieName: 'refresh',
  csrfCookieName: 'csrf',
  loginRedirectPath: '/',
  featureRedirectPath: '/feature-callback',
  errorRedirectPath: '/error',
} as const;

function mockAdapter(name = 'google'): ServerAuthAdapter {
  return {
    name,
    scopes: { login: ['openid'], gmail: ['mail.read'] },
    login: vi.fn((_state, _feature) => `https://auth.example.com/auth?state=${_state}`),
    exchangeCode: vi.fn(async () => ({ accessToken: 'at', expiresIn: 3600, refreshToken: 'rt' })),
    refresh: vi.fn(async () => ({ accessToken: 'at2', expiresIn: 3600 })),
    logout: vi.fn(async () => {}),
  };
}

function callbackRequest(provider: string, feature: string, code = 'authcode') {
  const { state, csrf } = generateState(provider, feature);
  return {
    req: new Request(`https://example.com/api/auth/callback?state=${state}&code=${code}`, {
      headers: { Cookie: `csrf=${csrf}` },
    }),
    state,
    csrf,
  };
}

function refreshRequest(provider: string, token: string, body?: Record<string, unknown>, query = '') {
  const cookie = encodeRefreshCookie(provider, token);
  return new Request(`https://example.com/api/auth/refresh${query}`, {
    method: 'POST',
    headers: {
      Cookie: `refresh=${cookie}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('ServerAuthService', () => {
  // ─── constructor ─────────────────────────────────────────

  it('throws on duplicate adapter names', () => {
    expect(() => new ServerAuthService([mockAdapter('g'), mockAdapter('g')], DEFAULT_OPTS)).toThrow(
      /duplicate adapter name "g"/,
    );
  });

  // ─── routing / 404 ──────────────────────────────────────

  it('returns 404 for paths outside basePath', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const res = await svc.fetch(new Request('https://example.com/other'));
    expect(res.status).toBe(404);
  });

  it('returns 404 for basePath root (no sub-route)', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const res = await svc.fetch(new Request('https://example.com/api/auth'));
    expect(res.status).toBe(404);
  });

  it('returns 404 for unrecognised sub-route', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const res = await svc.fetch(new Request('https://example.com/api/auth/unknown'));
    expect(res.status).toBe(404);
  });

  // ─── GET /login ──────────────────────────────────────────

  it('login: redirects to auth URL with CSRF cookie', async () => {
    const adapter = mockAdapter();
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const res = await svc.fetch(new Request('https://example.com/api/auth/login?provider=google'));

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('https://auth.example.com/auth');
    expect(res.headers.get('Set-Cookie')).toContain('csrf=');
    expect(adapter.login).toHaveBeenCalledOnce();
  });

  it('login: returns 404 when provider param is missing', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const res = await svc.fetch(new Request('https://example.com/api/auth/login'));
    expect(res.status).toBe(404);
  });

  it('login: returns 404 when provider is unknown', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const res = await svc.fetch(new Request('https://example.com/api/auth/login?provider=unknown'));
    expect(res.status).toBe(404);
  });

  it('login: returns 400 for unknown feature', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const res = await svc.fetch(
      new Request('https://example.com/api/auth/login?provider=google&feature=nope'),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Unknown feature');
  });

  it('login: accepts a valid feature scope', async () => {
    const adapter = mockAdapter();
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const res = await svc.fetch(
      new Request('https://example.com/api/auth/login?provider=google&feature=gmail'),
    );
    expect(res.status).toBe(302);
    expect(adapter.login).toHaveBeenCalledWith(expect.any(String), 'gmail');
  });

  // ─── GET /callback (login flow) ─────────────────────────

  it('callback: exchanges code and sets refresh cookie for login flow', async () => {
    const adapter = mockAdapter();
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const { req } = callbackRequest('google', 'login');

    const res = await svc.fetch(req);

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');
    const cookies = res.headers.getSetCookie();
    expect(cookies.some(c => c.startsWith('refresh='))).toBe(true);
    expect(cookies.some(c => c.startsWith('csrf=') && c.includes('Max-Age=0'))).toBe(true);
    expect(adapter.exchangeCode).toHaveBeenCalledWith('authcode');
  });

  it('callback: returns 404 when error param is present', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const res = await svc.fetch(
      new Request('https://example.com/api/auth/callback?error=access_denied&state=x&code=y'),
    );
    expect(res.status).toBe(404);
  });

  it('callback: returns 404 when code is missing', async () => {
    const { state } = generateState('google', 'login');
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const res = await svc.fetch(
      new Request(`https://example.com/api/auth/callback?state=${state}`),
    );
    expect(res.status).toBe(404);
  });

  it('callback: returns 404 when state is missing', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const res = await svc.fetch(new Request('https://example.com/api/auth/callback?code=abc'));
    expect(res.status).toBe(404);
  });

  it('callback: returns 404 when state is invalid base64 / unparseable', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const res = await svc.fetch(
      new Request('https://example.com/api/auth/callback?state=%%%bad&code=abc'),
    );
    expect(res.status).toBe(404);
  });

  it('callback: returns 404 when adapter not found for state.provider', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const { state, csrf } = generateState('unknown-provider', 'login');
    const res = await svc.fetch(
      new Request(`https://example.com/api/auth/callback?state=${state}&code=abc`, {
        headers: { Cookie: `csrf=${csrf}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('callback: redirects to errorRedirectPath on CSRF mismatch', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const { state } = generateState('google', 'login');
    const res = await svc.fetch(
      new Request(`https://example.com/api/auth/callback?state=${state}&code=abc`, {
        headers: { Cookie: 'csrf=wrong-value' },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/error');
  });

  it('callback: redirects to errorRedirectPath when no CSRF cookie', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const { state } = generateState('google', 'login');
    const res = await svc.fetch(
      new Request(`https://example.com/api/auth/callback?state=${state}&code=abc`),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/error');
  });

  it('callback: redirects to errorRedirectPath when exchangeCode throws', async () => {
    const adapter = mockAdapter();
    adapter.exchangeCode = vi.fn(async () => {
      throw new Error('exchange failed');
    });
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const { req } = callbackRequest('google', 'login');

    const res = await svc.fetch(req);

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/error');
  });

  it('callback: redirects to errorRedirectPath when result has no refreshToken', async () => {
    const adapter = mockAdapter();
    adapter.exchangeCode = vi.fn(async () => ({ accessToken: 'at', expiresIn: 3600 }));
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const { req } = callbackRequest('google', 'login');

    const res = await svc.fetch(req);

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/error');
  });

  // ─── GET /callback (feature flow) ───────────────────────

  it('callback: feature flow redirects to featureRedirectPath with hash params', async () => {
    const adapter = mockAdapter();
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const { req } = callbackRequest('google', 'gmail');

    const res = await svc.fetch(req);

    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toMatch(/^\/feature-callback#/);
    expect(location).toContain('access_token=at');
    expect(location).toContain('refresh_token=rt');
    expect(location).toContain('expires_in=3600');
    expect(location).toContain('feature=gmail');
    expect(location).toContain('provider=google');
    // CSRF cookie should be cleared
    const cookies = res.headers.getSetCookie();
    expect(cookies.some(c => c.startsWith('csrf=') && c.includes('Max-Age=0'))).toBe(true);
    // Should NOT set a refresh cookie for feature flow
    expect(cookies.some(c => c.startsWith('refresh='))).toBe(false);
  });

  // ─── POST /refresh (login) ──────────────────────────────

  it('refresh: returns new access token for login refresh', async () => {
    const adapter = mockAdapter();
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const req = refreshRequest('google', 'rt123');

    const res = await svc.fetch(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.access_token).toBe('at2');
    expect(body.expires_in).toBe(3600);
    expect(body.name).toBe('google');
    expect(adapter.refresh).toHaveBeenCalledWith('rt123');
  });

  it('refresh: updates cookie when refreshToken is rotated', async () => {
    const adapter = mockAdapter();
    adapter.refresh = vi.fn(async () => ({ accessToken: 'at2', expiresIn: 3600, refreshToken: 'rt-new' }));
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const req = refreshRequest('google', 'rt-old');

    const res = await svc.fetch(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('refresh=');
  });

  it('refresh: does not set cookie when refreshToken is unchanged', async () => {
    const adapter = mockAdapter();
    adapter.refresh = vi.fn(async () => ({ accessToken: 'at2', expiresIn: 3600, refreshToken: 'rt123' }));
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const req = refreshRequest('google', 'rt123');

    const res = await svc.fetch(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('refresh: returns 401 when no refresh cookie', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const res = await svc.fetch(
      new Request('https://example.com/api/auth/refresh', { method: 'POST' }),
    );
    expect(res.status).toBe(401);
  });

  it('refresh: returns 401 when login refresh throws', async () => {
    const adapter = mockAdapter();
    adapter.refresh = vi.fn(async () => {
      throw new Error('token expired');
    });
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const req = refreshRequest('google', 'rt123');

    const res = await svc.fetch(req);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Refresh failed');
  });

  // ─── POST /refresh (feature) ────────────────────────────

  it('refresh: feature refresh uses body token and returns full payload', async () => {
    const adapter = mockAdapter();
    adapter.refresh = vi.fn(async () => ({ accessToken: 'feat-at', expiresIn: 1800, refreshToken: 'feat-rt-new' }));
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const req = refreshRequest('google', 'login-rt', { refresh_token: 'feat-rt' }, '?feature=gmail&provider=google');

    const res = await svc.fetch(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.access_token).toBe('feat-at');
    expect(body.refresh_token).toBe('feat-rt-new');
    expect(body.feature).toBe('gmail');
    expect(body.name).toBe('google');
    expect(adapter.refresh).toHaveBeenCalledWith('feat-rt');
  });

  it('refresh: feature refresh falls back to original token when adapter returns none', async () => {
    const adapter = mockAdapter();
    adapter.refresh = vi.fn(async () => ({ accessToken: 'feat-at', expiresIn: 1800 }));
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const req = refreshRequest('google', 'login-rt', { refresh_token: 'feat-rt' }, '?feature=gmail&provider=google');

    const res = await svc.fetch(req);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.refresh_token).toBe('feat-rt');
  });

  it('refresh: returns 400 when feature is set but provider is missing', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const req = refreshRequest('google', 'rt', { refresh_token: 'x' }, '?feature=gmail');

    const res = await svc.fetch(req);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Unknown provider');
  });

  it('refresh: returns 400 when feature provider is unknown', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const req = refreshRequest('google', 'rt', { refresh_token: 'x' }, '?feature=gmail&provider=nope');

    const res = await svc.fetch(req);

    expect(res.status).toBe(400);
  });

  it('refresh: returns 400 when body is not valid JSON', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const cookie = encodeRefreshCookie('google', 'rt');
    const req = new Request('https://example.com/api/auth/refresh?feature=gmail&provider=google', {
      method: 'POST',
      headers: { Cookie: `refresh=${cookie}` },
      body: 'not-json',
    });

    const res = await svc.fetch(req);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid request body');
  });

  it('refresh: returns 400 when body is missing refresh_token', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const req = refreshRequest('google', 'rt', { other: 'value' }, '?feature=gmail&provider=google');

    const res = await svc.fetch(req);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Missing refresh_token');
  });

  it('refresh: returns 401 when feature refresh throws', async () => {
    const adapter = mockAdapter();
    adapter.refresh = vi.fn(async () => {
      throw new Error('revoked');
    });
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const req = refreshRequest('google', 'rt', { refresh_token: 'feat-rt' }, '?feature=gmail&provider=google');

    const res = await svc.fetch(req);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Feature refresh failed');
  });

  // ─── POST /logout ────────────────────────────────────────

  it('logout: calls adapter.logout and clears refresh cookie', async () => {
    const adapter = mockAdapter();
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const cookie = encodeRefreshCookie('google', 'rt-tok');
    const req = new Request('https://example.com/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `refresh=${cookie}` },
    });

    const res = await svc.fetch(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(adapter.logout).toHaveBeenCalledWith('rt-tok');
  });

  it('logout: succeeds even without a refresh cookie', async () => {
    const adapter = mockAdapter();
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const req = new Request('https://example.com/api/auth/logout', { method: 'POST' });

    const res = await svc.fetch(req);

    expect(res.status).toBe(200);
    expect(adapter.logout).not.toHaveBeenCalled();
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('logout: swallows adapter errors', async () => {
    const adapter = mockAdapter();
    adapter.logout = vi.fn(async () => {
      throw new Error('revoke failed');
    });
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const cookie = encodeRefreshCookie('google', 'rt-tok');
    const req = new Request('https://example.com/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `refresh=${cookie}` },
    });

    const res = await svc.fetch(req);

    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });

  // ─── edge cases ──────────────────────────────────────────

  it('works with trailing slash on basePath option', async () => {
    const svc = new ServerAuthService([mockAdapter()], { ...DEFAULT_OPTS, basePath: '/api/auth/' });
    const res = await svc.fetch(new Request('https://example.com/api/auth/login?provider=google'));
    expect(res.status).toBe(302);
  });

  it('returns 404 for wrong HTTP method on /login (POST)', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const res = await svc.fetch(
      new Request('https://example.com/api/auth/login?provider=google', { method: 'POST' }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for wrong HTTP method on /refresh (GET)', async () => {
    const svc = new ServerAuthService([mockAdapter()], DEFAULT_OPTS);
    const res = await svc.fetch(new Request('https://example.com/api/auth/refresh'));
    expect(res.status).toBe(404);
  });

  it('routes correctly when basePath is empty', async () => {
    const svc = new ServerAuthService([mockAdapter()], { ...DEFAULT_OPTS, basePath: '' });
    const res = await svc.fetch(new Request('https://example.com/login?provider=google'));
    expect(res.status).toBe(302);
  });

  it('logout: ignores a cookie whose provider is unknown', async () => {
    const adapter = mockAdapter();
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const cookie = encodeRefreshCookie('unknown-provider', 'rt-tok');
    const req = new Request('https://example.com/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `refresh=${cookie}` },
    });

    const res = await svc.fetch(req);

    expect(res.status).toBe(200);
    expect(adapter.logout).not.toHaveBeenCalled();
  });

  it('logout: ignores an undecodable refresh cookie', async () => {
    const adapter = mockAdapter();
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const req = new Request('https://example.com/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: 'refresh=%%%not-decodable%%%' },
    });

    const res = await svc.fetch(req);

    expect(res.status).toBe(200);
    expect(adapter.logout).not.toHaveBeenCalled();
  });

  it('refresh: handles a non-Error thrown during feature refresh', async () => {
    const adapter = mockAdapter();
    adapter.refresh = vi.fn(async () => {
      throw 'string failure';
    });
    const svc = new ServerAuthService([adapter], DEFAULT_OPTS);
    const req = refreshRequest('google', 'rt', { refresh_token: 'feat-rt' }, '?feature=gmail&provider=google');

    const res = await svc.fetch(req);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Feature refresh failed');
  });
});