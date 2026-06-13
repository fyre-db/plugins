import { describe, it, expect } from 'vitest';
import {
  generateState,
  parseState,
  jsonResponse,
  errorResponse,
  setCookieHeader,
  clearCookieHeader,
  getCookie,
  isSafeReturnUrl,
  encodeRefreshCookie,
  decodeRefreshCookie,
} from '@/auth/oauth-utils';

describe('generateState / parseState', () => {
  it('returns base64 state and a uuid csrf', () => {
    const result = generateState('google', 'login');
    expect(result.state).toBeTruthy();
    expect(result.csrf).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('round-trips through parseState', () => {
    const { state, csrf } = generateState('google', 'link');
    const parsed = parseState(state);
    expect(parsed).toEqual({ provider: 'google', feature: 'link', csrf });
  });
});

describe('parseState', () => {
  it('decodes a known base64 state', () => {
    const payload = { provider: 'github', feature: 'signup', csrf: 'abc-123' };
    const encoded = btoa(JSON.stringify(payload));
    expect(parseState(encoded)).toEqual(payload);
  });
});

describe('jsonResponse', () => {
  it('returns 200 with application/json by default', async () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('respects custom status and extra headers', async () => {
    const res = jsonResponse({ n: 1 }, 201, { 'X-Custom': 'yes' });
    expect(res.status).toBe(201);
    expect(res.headers.get('X-Custom')).toBe('yes');
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });
});

describe('errorResponse', () => {
  it('returns error JSON with given status', async () => {
    const res = errorResponse('not found', 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('defaults to 400', () => {
    const res = errorResponse('bad');
    expect(res.status).toBe(400);
  });
});

describe('setCookieHeader', () => {
  it('includes all required attributes', () => {
    const header = setCookieHeader('token', 'abc123', 3600);
    expect(header).toContain('token=abc123');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=3600');
  });
});

describe('clearCookieHeader', () => {
  it('sets Max-Age=0 to expire the cookie', () => {
    const header = clearCookieHeader('token');
    expect(header).toContain('token=');
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
  });
});

describe('getCookie', () => {
  function requestWithCookies(cookies: string): Request {
    return new Request('http://localhost', { headers: { Cookie: cookies } });
  }

  it('finds a cookie by name', () => {
    expect(getCookie(requestWithCookies('token=abc; other=xyz'), 'token')).toBe('abc');
  });

  it('returns undefined when the cookie is missing', () => {
    expect(getCookie(requestWithCookies('other=xyz'), 'token')).toBeUndefined();
  });

  it('returns undefined when there is no Cookie header', () => {
    const req = new Request('http://localhost');
    expect(getCookie(req, 'token')).toBeUndefined();
  });

  it('handles multiple cookies with similar prefixes', () => {
    expect(getCookie(requestWithCookies('token_v2=old; token=new'), 'token')).toBe('new');
  });
});

describe('isSafeReturnUrl', () => {
  it('accepts a simple path', () => {
    expect(isSafeReturnUrl('/foo')).toBe(true);
  });

  it('accepts a nested path', () => {
    expect(isSafeReturnUrl('/foo/bar?q=1')).toBe(true);
  });

  it('rejects protocol-relative URLs', () => {
    expect(isSafeReturnUrl('//evil.com')).toBe(false);
  });

  it('rejects backslash-relative URLs', () => {
    expect(isSafeReturnUrl('/\\evil')).toBe(false);
  });

  it('rejects javascript: URIs', () => {
    expect(isSafeReturnUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isSafeReturnUrl('')).toBe(false);
  });
});

describe('encodeRefreshCookie / decodeRefreshCookie', () => {
  it('round-trips name and token', () => {
    const encoded = encodeRefreshCookie('refresh_google', 'tok_xyz');
    const decoded = decodeRefreshCookie(encoded);
    expect(decoded).toEqual({ name: 'refresh_google', token: 'tok_xyz' });
  });

  it('produces a base64 string', () => {
    const encoded = encodeRefreshCookie('n', 't');
    // base64 should not contain characters outside the alphabet
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
