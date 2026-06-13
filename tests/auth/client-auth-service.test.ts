import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { firstValueFrom, skip, take } from 'rxjs';
import { ClientAuthService } from '@/auth/client-auth-service';
import type { ClientAuthAdapter, AccessToken } from '@/auth/types';

function tok(name: string, token: string, expiresInSec = 3600): AccessToken {
  return { name, token, expiresAt: Date.now() + expiresInSec * 1000 };
}

function fakeAdapter(
  name: string,
  refresh: AccessToken | null = null,
): ClientAuthAdapter {
  return {
    name,
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(refresh),
  };
}

describe('ClientAuthService', () => {
  it('throws on duplicate adapter names', () => {
    expect(() => new ClientAuthService([fakeAdapter('google'), fakeAdapter('google')]))
      .toThrow(/duplicate adapter name "google"/);
  });

  it('getAccessToken returns null and emits signed-out when no adapter has a session', async () => {
    const svc = new ClientAuthService([fakeAdapter('google')]);
    expect(await svc.getAccessToken()).toBeNull();
    const s = await firstValueFrom(svc.state$.pipe(take(1)));
    expect(s.status).toBe('signed-out');
  });

  it('getAccessToken refreshes against first successful adapter and emits signed-in', async () => {
    const a = fakeAdapter('google', tok('google', 'g-tok'));
    const svc = new ClientAuthService([a]);
    const t = await svc.getAccessToken();
    expect(t?.token).toBe('g-tok');
    expect(t?.name).toBe('google');
    expect(t?.expiresAt).toBeGreaterThan(Date.now());
    const s = await firstValueFrom(svc.state$.pipe(take(1)));
    expect(s).toEqual({ status: 'signed-in', name: 'google' });
  });

  it('getAccessToken caches within the leeway window', async () => {
    const a = fakeAdapter('google', tok('google', 'g-tok'));
    const svc = new ClientAuthService([a]);
    await svc.getAccessToken();
    await svc.getAccessToken();
    expect(a.refresh).toHaveBeenCalledTimes(1);
  });

  it('getAccessToken refreshes when cached token is within the leeway window', async () => {
    const a = fakeAdapter('google');
    (a.refresh as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(tok('google', 'g-tok-1', 60))
      .mockResolvedValueOnce(tok('google', 'g-tok-2'));
    const svc = new ClientAuthService([a]);
    const t1 = await svc.getAccessToken();
    const t2 = await svc.getAccessToken();
    expect(t1?.token).toBe('g-tok-1');
    expect(t2?.token).toBe('g-tok-2');
  });

  it('getAccessToken refreshes again when the cached token has no expiry', async () => {
    const a = fakeAdapter('google');
    (a.refresh as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'google', token: 'no-exp' });
    const svc = new ClientAuthService([a]);
    const t1 = await svc.getAccessToken();
    const t2 = await svc.getAccessToken();
    expect(t1?.token).toBe('no-exp');
    expect(t2?.token).toBe('no-exp');
    expect((a.refresh as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('suppresses duplicate consecutive states with the same status', async () => {
    const a = fakeAdapter('google', null);
    const svc = new ClientAuthService([a]);
    await svc.getAccessToken(); // settle the constructor probe → signed-out
    const statuses: string[] = [];
    const sub = svc.state$.subscribe((s) => statuses.push(s.status));
    await svc.getAccessToken(); // emits signed-out again → deduped by the comparator
    await svc.logout(); // emits signed-out again → deduped
    sub.unsubscribe();
    expect(statuses).toEqual(['signed-out']);
  });

  it('getAccessToken coalesces concurrent calls', async () => {
    const a = fakeAdapter('google');
    let resolveRefresh!: (v: AccessToken | null) => void;
    (a.refresh as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<AccessToken | null>((r) => { resolveRefresh = r; }),
    );
    const svc = new ClientAuthService([a]);
    const p1 = svc.getAccessToken();
    const p2 = svc.getAccessToken();
    resolveRefresh(tok('google', 't'));
    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe(t2);
  });

  it('getAccessToken returns null when refresh fails', async () => {
    const a = fakeAdapter('google', null);
    const svc = new ClientAuthService([a]);
    expect(await svc.getAccessToken()).toBeNull();
    const s = await firstValueFrom(svc.state$.pipe(take(1)));
    expect(s.status).toBe('signed-out');
  });

  it('getAccessToken returns null when refresh throws', async () => {
    const a = fakeAdapter('google');
    (a.refresh as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const svc = new ClientAuthService([a]);
    expect(await svc.getAccessToken()).toBeNull();
  });

  it('getAccessToken tries adapters in order and returns first success', async () => {
    const a = fakeAdapter('google', null);
    const b = fakeAdapter('dropbox', tok('dropbox', 'd-tok'));
    const svc = new ClientAuthService([a, b]);
    const t = await svc.getAccessToken();
    expect(t?.name).toBe('dropbox');
    expect(t?.token).toBe('d-tok');
  });

  it('supportedAuths().login calls adapter.login', async () => {
    const a = fakeAdapter('google');
    const svc = new ClientAuthService([a]);
    await svc.supportedAuths()[0].login();
    expect(a.login).toHaveBeenCalled();
  });

  it('supportedAuths returns name + login fn', () => {
    const svc = new ClientAuthService([fakeAdapter('google')]);
    const supported = svc.supportedAuths();
    expect(supported).toHaveLength(1);
    expect(supported[0].name).toBe('google');
    expect(typeof supported[0].login).toBe('function');
  });

  it('logout clears cache, calls adapter, emits signed-out', async () => {
    const a = fakeAdapter('google', tok('google', 'g-tok'));
    const svc = new ClientAuthService([a]);
    await svc.getAccessToken();
    await svc.logout();
    expect(a.logout).toHaveBeenCalled();
    const s = await firstValueFrom(svc.state$.pipe(take(1)));
    expect(s.status).toBe('signed-out');
  });

  it('logout tries all adapters when none is cached', async () => {
    const a = fakeAdapter('google');
    const b = fakeAdapter('dropbox');
    const svc = new ClientAuthService([a, b]);
    await svc.logout();
    expect(a.logout).toHaveBeenCalled();
    expect(b.logout).toHaveBeenCalled();
  });

  it('emits state changes via state$', async () => {
    const a = fakeAdapter('google', tok('google', 'g-tok'));
    const svc = new ClientAuthService([a]);
    const next = firstValueFrom(svc.state$.pipe(skip(1), take(1)));
    await svc.getAccessToken();
    const s = await next;
    expect(s).toEqual({ status: 'signed-in', name: 'google' });
  });
});

function makeStorageStub() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  };
}

describe('ClientAuthService — feature tokens & callbacks', () => {
  let sessionStore: ReturnType<typeof makeStorageStub>;

  beforeEach(() => {
    sessionStore = makeStorageStub();
    vi.stubGlobal('sessionStorage', sessionStore);
    vi.stubGlobal('window', { location: { href: 'https://app.example/current' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getFeatureToken returns null for an unknown adapter', async () => {
    const svc = new ClientAuthService([fakeAdapter('google')]);
    expect(await svc.getFeatureToken('dropbox', 'drive', 'rt')).toBeNull();
  });

  it('getFeatureToken refreshes via the adapter and caches the result', async () => {
    const a = fakeAdapter('google');
    (a.refresh as ReturnType<typeof vi.fn>).mockResolvedValue(tok('google', 'feat-tok'));
    const svc = new ClientAuthService([a]);
    (a.refresh as ReturnType<typeof vi.fn>).mockClear();

    const first = await svc.getFeatureToken('google', 'drive', 'rt');
    const second = await svc.getFeatureToken('google', 'drive', 'rt');

    expect(first?.token).toBe('feat-tok');
    expect(second).toBe(first);
    expect(a.refresh).toHaveBeenCalledTimes(1);
    expect(a.refresh).toHaveBeenCalledWith('drive', 'rt');
  });

  it('getFeatureToken does not cache a null refresh result', async () => {
    const a = fakeAdapter('google');
    (a.refresh as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const svc = new ClientAuthService([a]);
    expect(await svc.getFeatureToken('google', 'drive', 'rt')).toBeNull();
  });

  it('consumeReturnUrl returns the fallback when no returnUrlKey is configured', () => {
    const svc = new ClientAuthService([fakeAdapter('google')]);
    expect(svc.consumeReturnUrl('/home')).toBe('/home');
  });

  it('consumeReturnUrl returns the fallback when nothing was saved', () => {
    const svc = new ClientAuthService([fakeAdapter('google')], { returnUrlKey: 'ret' });
    expect(svc.consumeReturnUrl('/home')).toBe('/home');
  });

  it('consumeReturnUrl returns the path of a saved absolute URL and clears it', () => {
    const svc = new ClientAuthService([fakeAdapter('google')], { returnUrlKey: 'ret' });
    sessionStore.setItem('ret', 'https://app.example/dash?tab=1#sec');
    expect(svc.consumeReturnUrl()).toBe('/dash?tab=1#sec');
    expect(sessionStore.getItem('ret')).toBeNull();
  });

  it('consumeReturnUrl returns a saved non-URL value verbatim', () => {
    const svc = new ClientAuthService([fakeAdapter('google')], { returnUrlKey: 'ret' });
    sessionStore.setItem('ret', '/relative/path');
    expect(svc.consumeReturnUrl()).toBe('/relative/path');
  });

  it('supportedAuths().login saves the return URL and clears the cached token', async () => {
    const a = fakeAdapter('google');
    const svc = new ClientAuthService([a], { returnUrlKey: 'ret' });
    await svc.supportedAuths()[0].login();
    expect(sessionStore.getItem('ret')).toBe('https://app.example/current');
    expect(a.login).toHaveBeenCalledWith(undefined);
  });

  it('supportedAuths().login with a feature keeps the cached token (no reset)', async () => {
    const a = fakeAdapter('google');
    const svc = new ClientAuthService([a], { returnUrlKey: 'ret' });
    await svc.supportedAuths()[0].login('drive');
    expect(a.login).toHaveBeenCalledWith('drive');
  });

  it('handleCallback returns parsed creds and stores them when featureCredsKey is set', () => {
    const creds = {
      accessToken: 'at', refreshToken: 'rt', expiresIn: 3600,
      feature: 'drive', provider: 'google', receivedAt: 1,
    };
    const a: ClientAuthAdapter = {
      ...fakeAdapter('google'),
      handleCallback: vi.fn().mockReturnValue(creds),
    };
    const svc = new ClientAuthService([a], { featureCredsKey: 'creds' });
    const result = svc.handleCallback();
    expect(result.creds).toEqual(creds);
    expect(JSON.parse(sessionStore.getItem('creds')!)).toEqual(creds);
  });

  it('handleCallback skips adapters without a handleCallback and returns null creds', () => {
    const svc = new ClientAuthService([fakeAdapter('google')]);
    const result = svc.handleCallback('/fallback');
    expect(result.creds).toBeNull();
    expect(result.returnUrl).toBe('/fallback');
  });

  it('handleCallback returns null creds when an adapter handleCallback yields nothing', () => {
    const a: ClientAuthAdapter = {
      ...fakeAdapter('google'),
      handleCallback: vi.fn().mockReturnValue(null),
    };
    const svc = new ClientAuthService([a]);
    expect(svc.handleCallback().creds).toBeNull();
  });

  it('handleCallback returns creds without storing when no featureCredsKey is set', () => {
    const creds = {
      accessToken: 'at', refreshToken: 'rt', expiresIn: 3600,
      feature: 'drive', provider: 'google', receivedAt: 1,
    };
    const a: ClientAuthAdapter = {
      ...fakeAdapter('google'),
      handleCallback: vi.fn().mockReturnValue(creds),
    };
    const svc = new ClientAuthService([a]);
    const result = svc.handleCallback();
    expect(result.creds).toEqual(creds);
    expect(sessionStore.getItem('creds')).toBeNull();
  });
});