import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { BffClientAdapter } from '@/auth/bff-client-adapter';

const PREFIX = '/api/auth';
const REFRESH_URL = `${PREFIX}/refresh`;
const LOGOUT_URL = `${PREFIX}/logout`;
const LOGIN_URL = `${PREFIX}/login?provider=google`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function newAdapter() {
  return new BffClientAdapter({ name: 'google', label: 'Google', prefix: PREFIX });
}

describe('BffClientAdapter', () => {
  let mockFetch: Mock;
  let mockLocation: { href: string };

  beforeEach(() => {
    mockFetch = vi.fn();
    mockLocation = { href: '' };
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('window', { location: mockLocation });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes name', () => {
    const a = newAdapter();
    expect(a.name).toBe('google');
  });

  it('refresh posts to /refresh and returns a tagged AccessToken', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: 'tok-1', expires_in: 3600, name: 'google' }),
    );
    const a = newAdapter();
    const r = await a.refresh();
    expect(mockFetch).toHaveBeenCalledWith(REFRESH_URL, { method: 'POST', credentials: 'include' });
    expect(r).toEqual({
      name: 'google',
      token: 'tok-1',
      expiresAt: expect.any(Number),
    });
    expect(r?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('refresh returns null on non-2xx response', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await newAdapter().refresh()).toBeNull();
  });

  it('refresh returns null on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('network'));
    expect(await newAdapter().refresh()).toBeNull();
  });

  it('refresh returns null on malformed JSON body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }));
    expect(await newAdapter().refresh()).toBeNull();
  });

  it('logout posts to /logout', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await newAdapter().logout();
    expect(mockFetch).toHaveBeenCalledWith(LOGOUT_URL, { method: 'POST', credentials: 'include' });
  });

  it('logout swallows network errors', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('network'));
    await expect(newAdapter().logout()).resolves.toBeUndefined();
  });

  it('login navigates to /login?provider=…', () => {
    void newAdapter().login();
    expect(mockLocation.href).toBe(LOGIN_URL);
  });

  it('strips a trailing slash from prefix', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: 'tok-1', expires_in: 3600, name: 'google' }),
    );
    const a = new BffClientAdapter({ name: 'google', label: 'Google', prefix: '/api/auth/' });
    await a.refresh();
    expect(mockFetch).toHaveBeenCalledWith(REFRESH_URL, { method: 'POST', credentials: 'include' });
  });

  it('login URL includes provider query param', () => {
    void newAdapter().login();
    expect(mockLocation.href).toBe(LOGIN_URL);
  });

  it('login with a feature appends the feature query param', () => {
    void newAdapter().login('drive');
    expect(mockLocation.href).toBe(`${LOGIN_URL}&feature=drive`);
  });

  it('refresh with a feature posts the refresh token in the body', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: 'feat-at', expires_in: 1800, name: 'google' }),
    );
    const r = await newAdapter().refresh('drive', 'rt-feature');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${REFRESH_URL}?provider=google&feature=drive`);
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ refresh_token: 'rt-feature' });
    expect(r?.token).toBe('feat-at');
  });

  it('refresh falls back to adapter name when response omits name', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }));
    const r = await newAdapter().refresh();
    expect(r?.name).toBe('google');
  });

  it('refresh parses the profile from the response and stamps the resolved name', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'tok',
        expires_in: 3600,
        name: 'google',
        profile: { userId: 'u-1', email: 'a@b.com', name: 'Ada', picture: 'http://pic' },
      }),
    );
    const r = await newAdapter().refresh();
    expect(r?.profile).toEqual({ provider: 'google', userId: 'u-1', email: 'a@b.com', name: 'Ada', picture: 'http://pic' });
  });

  it('refresh omits the profile when the payload lacks a userId', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: 'tok', expires_in: 3600, name: 'google', profile: { email: 'a@b.com' } }),
    );
    const r = await newAdapter().refresh();
    expect(r?.profile).toBeUndefined();
  });

  it('handleCallback parses tokens from the URL hash and clears it', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: {
        hash: '#access_token=at&refresh_token=rt&expires_in=1200&feature=drive&provider=google',
        pathname: '/callback',
      },
      history: { replaceState },
    });
    const creds = newAdapter().handleCallback();
    expect(creds).toMatchObject({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: 1200,
      feature: 'drive',
      provider: 'google',
    });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/callback');
  });

  it('handleCallback parses the profile from the hash when present', () => {
    vi.stubGlobal('window', {
      location: {
        hash: '#access_token=at&refresh_token=rt&feature=drive&provider=google&user_id=u-1&email=a%40b.com&name=Ada&picture=http%3A%2F%2Fpic',
        pathname: '/callback',
      },
      history: { replaceState: vi.fn() },
    });
    const creds = newAdapter().handleCallback();
    expect(creds?.profile).toEqual({ provider: 'google', userId: 'u-1', email: 'a@b.com', name: 'Ada', picture: 'http://pic' });
  });

  it('handleCallback leaves the profile undefined when identity params are absent', () => {
    vi.stubGlobal('window', {
      location: {
        hash: '#access_token=at&refresh_token=rt&feature=drive&provider=google',
        pathname: '/callback',
      },
      history: { replaceState: vi.fn() },
    });
    const creds = newAdapter().handleCallback();
    expect(creds?.profile).toBeUndefined();
  });

  it('handleCallback defaults expiresIn to 3600 when absent', () => {
    vi.stubGlobal('window', {
      location: {
        hash: '#access_token=at&refresh_token=rt&feature=drive&provider=google',
        pathname: '/callback',
      },
      history: { replaceState: vi.fn() },
    });
    const creds = newAdapter().handleCallback();
    expect(creds?.expiresIn).toBe(3600);
  });

  it('handleCallback returns null when the hash is empty', () => {
    vi.stubGlobal('window', { location: { hash: '', pathname: '/callback' }, history: { replaceState: vi.fn() } });
    expect(newAdapter().handleCallback()).toBeNull();
  });

  it('handleCallback returns null when required params are missing', () => {
    vi.stubGlobal('window', {
      location: { hash: '#access_token=at', pathname: '/callback' },
      history: { replaceState: vi.fn() },
    });
    expect(newAdapter().handleCallback()).toBeNull();
  });
});