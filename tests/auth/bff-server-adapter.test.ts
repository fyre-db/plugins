import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BffServerAdapter, type BffServerAdapterConfig } from '@/auth/bff-server-adapter';
import { FyreDbPluginConfigError } from '@/errors/fyredb-error';

const baseConfig: BffServerAdapterConfig = {
  name: 'google',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  callbackUrl: 'https://example.com/callback',
  endpoints: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
  },
  scopes: {
    login: ['openid', 'email'],
    drive: ['https://www.googleapis.com/auth/drive.file'],
  },
};

describe('BffServerAdapter', () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('exposes name and scopes from config', () => {
    const adapter = new BffServerAdapter(baseConfig);
    expect(adapter.name).toBe('google');
    expect(adapter.scopes).toEqual(baseConfig.scopes);
  });

  it('login() returns a URL with correct query params', () => {
    const adapter = new BffServerAdapter(baseConfig);
    const result = adapter.login('my-state', 'login');
    const url = new URL(result);

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('state')).toBe('my-state');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('login() throws FyreDbPluginConfigError for unknown feature', () => {
    const adapter = new BffServerAdapter(baseConfig);
    expect(() => adapter.login('state', 'unknown-feature')).toThrow(FyreDbPluginConfigError);
  });

  it('exchangeCode() posts to tokenUrl and returns tokens', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'at-123',
        refresh_token: 'rt-456',
        expires_in: 3600,
      }),
    });

    const adapter = new BffServerAdapter(baseConfig);
    const result = await adapter.exchangeCode('auth-code');

    expect(result).toEqual({
      accessToken: 'at-123',
      refreshToken: 'rt-456',
      expiresIn: 3600,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe('https://example.com/callback');
    expect(body.get('client_id')).toBe('test-client-id');
    expect(body.get('client_secret')).toBe('test-client-secret');
  });

  it('refresh() posts to tokenUrl with grant_type=refresh_token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'at-new',
        refresh_token: 'rt-new',
        expires_in: 3600,
      }),
    });

    const adapter = new BffServerAdapter(baseConfig);
    const result = await adapter.refresh('rt-old');

    expect(result).toEqual({
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      expiresIn: 3600,
    });

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
    expect(body.get('refresh_token')).toBe('rt-old');
    expect(body.get('grant_type')).toBe('refresh_token');
  });

  it('logout() posts to revokeUrl', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const adapter = new BffServerAdapter(baseConfig);
    await adapter.logout('rt-123');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/revoke',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
    expect(body.get('token')).toBe('rt-123');
  });

  it('logout() is no-op when revokeUrl is empty', async () => {
    const config: BffServerAdapterConfig = {
      ...baseConfig,
      endpoints: { authUrl: 'https://auth.example.com', tokenUrl: 'https://token.example.com', revokeUrl: '' },
    };
    const adapter = new BffServerAdapter(config);
    await adapter.logout('rt-123');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('tokenRequest throws Error on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve('invalid_grant'),
    });

    const adapter = new BffServerAdapter(baseConfig);
    await expect(adapter.exchangeCode('bad-code')).rejects.toThrow('Token request failed: 400');
  });

  it('tokenRequest falls back to "(no body)" when reading the error body fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('stream error')),
    });

    const adapter = new BffServerAdapter(baseConfig);
    await expect(adapter.exchangeCode('bad-code')).rejects.toThrow('Token request failed: 500 (no body)');
  });

  it('tokenRequest handles an empty error body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve(''),
    });

    const adapter = new BffServerAdapter(baseConfig);
    await expect(adapter.exchangeCode('bad-code')).rejects.toThrow('Token request failed: 401');
  });
});
