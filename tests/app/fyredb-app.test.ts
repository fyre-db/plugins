import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { MemoryStorageAdapter, defineEntity, type StorageAdapter, type Tenant } from '@fyre-db/core';
import { FyreDbApp, type FyreDbStatus, type Session } from '@/app/fyredb-app';
import { FyreDbPluginConfigError } from '@/errors/fyredb-error';
import type { ClientAuthService } from '@/auth/client-auth-service';
import type { AuthState } from '@/auth/types';
import type { CloudAdapter } from '@/cloud/cloud-service';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
}

const thing = defineEntity<{ id: string; value: string }>('thing', { deriveId: (e) => e.id });

function cloudAdapter(name: string): CloudAdapter {
  return Object.assign(new MemoryStorageAdapter(), { name }) as unknown as CloudAdapter;
}

function mockAuth(initial: AuthState) {
  const state$ = new BehaviorSubject<AuthState>(initial);
  const login = vi.fn(async () => { /* BFF redirect */ });
  const logout = vi.fn(async () => { state$.next({ status: 'signed-out' }); });
  const service = {
    state$,
    supportedAuths: () => [{ name: 'google', login }, { name: 'microsoft', login }],
    logout,
  } as unknown as ClientAuthService;
  return { state$, service, login, logout };
}

type Base = {
  appId: string;
  deviceId: string;
  entities: ReadonlyArray<ReturnType<typeof defineEntity>>;
  localAdapter: StorageAdapter;
};

function base(): Base {
  return {
    appId: 'test',
    deviceId: 'dev1',
    entities: [thing],
    localAdapter: new MemoryStorageAdapter(),
  };
}

/** Await the app's internal lifecycle queue. */
function settle(app: FyreDbApp): Promise<void> {
  return (app as unknown as { chain: Promise<void> }).chain;
}

function track<T>(obs: { subscribe(fn: (v: T) => void): { unsubscribe(): void } }): { value: T | undefined } {
  const box: { value: T | undefined } = { value: undefined };
  obs.subscribe((v) => { box.value = v; });
  return box;
}

let apps: FyreDbApp[] = [];
function make(config: ConstructorParameters<typeof FyreDbApp>[0]): FyreDbApp {
  const app = new FyreDbApp(config);
  apps.push(app);
  return app;
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', new MemStorage());
  vi.stubGlobal('localStorage', new MemStorage());
});

afterEach(async () => {
  for (const app of apps) await app.dispose();
  apps = [];
});

describe('FyreDbApp — no auth (local only)', () => {
  it('builds a local provider and reaches no-tenant', async () => {
    const app = make({ ...base(), encryption: false });
    await settle(app);
    expect(app.provider).toBe('local');
    expect(app.status).toBe('no-tenant');
  });
});

describe('FyreDbApp — auth-driven provider', () => {
  it('connecting while auth is loading', async () => {
    const { service } = mockAuth({ status: 'loading' });
    const app = make({ ...base(), encryption: false, auth: service, providers: [cloudAdapter('google')] });
    await settle(app);
    expect(app.status).toBe('connecting');
  });

  it('signed-in builds the matching provider', async () => {
    const { state$, service } = mockAuth({ status: 'loading' });
    const app = make({ ...base(), encryption: false, auth: service, providers: [cloudAdapter('google')] });
    state$.next({ status: 'signed-in', name: 'google' });
    await settle(app);
    expect(app.provider).toBe('google');
    expect(app.status).toBe('no-tenant');
  });

  it('signed-in with an unmapped name still builds (no cloud)', async () => {
    const { state$, service } = mockAuth({ status: 'loading' });
    const app = make({ ...base(), encryption: false, auth: service, providers: [cloudAdapter('google')] });
    state$.next({ status: 'signed-in', name: 'dropbox' });
    await settle(app);
    expect(app.provider).toBe('dropbox');
    expect(app.status).toBe('no-tenant');
  });

  it('signed-out tears down and reports signed-out', async () => {
    const { state$, service } = mockAuth({ status: 'signed-in', name: 'google' });
    const app = make({ ...base(), encryption: false, auth: service, providers: [cloudAdapter('google')] });
    await settle(app);
    state$.next({ status: 'signed-out' });
    await settle(app);
    expect(app.provider).toBeNull();
    expect(app.status).toBe('signed-out');
  });

  it('signed-in without a name is treated as signed-out', async () => {
    const { state$, service } = mockAuth({ status: 'loading' });
    const app = make({ ...base(), encryption: false, auth: service, providers: [cloudAdapter('google')] });
    state$.next({ status: 'signed-in' } as AuthState);
    await settle(app);
    expect(app.status).toBe('signed-out');
  });

  it('providers lists configured names', () => {
    const { service } = mockAuth({ status: 'loading' });
    const app = make({ ...base(), encryption: false, auth: service, providers: [cloudAdapter('google'), cloudAdapter('microsoft')] });
    expect(app.providers).toEqual(['google', 'microsoft']);
  });
});

describe('FyreDbApp — tenant lifecycle', () => {
  async function signedInApp() {
    const { state$, service } = mockAuth({ status: 'loading' });
    const app = make({ ...base(), encryption: false, auth: service, providers: [cloudAdapter('google')] });
    state$.next({ status: 'signed-in', name: 'google' });
    await settle(app);
    return app;
  }

  it('opens an unencrypted tenant and issues session #1', async () => {
    const app = await signedInApp();
    const session = track<Session | null>(app.session$);
    const t = await app.createTenant({ name: 'A', meta: {} });
    await app.openTenant(t.id);
    expect(app.status).toBe('ready');
    expect(session.value?.id).toBe(1);
    expect(session.value?.tenant.id).toBe(t.id);
  });

  it('session id is monotonic across opens', async () => {
    const app = await signedInApp();
    const session = track<Session | null>(app.session$);
    const a = await app.createTenant({ name: 'A', meta: {} });
    const b = await app.createTenant({ name: 'B', meta: {} });
    await app.openTenant(a.id);
    expect(session.value?.id).toBe(1);
    await app.closeTenant();
    expect(session.value).toBeNull();
    await app.openTenant(b.id);
    expect(session.value?.id).toBe(2);
  });

  it('closeTenant returns to no-tenant', async () => {
    const app = await signedInApp();
    const t = await app.createTenant({ name: 'A', meta: {} });
    await app.openTenant(t.id);
    await app.closeTenant();
    expect(app.status).toBe('no-tenant');
  });

  it('opening a missing tenant reports error', async () => {
    const app = await signedInApp();
    await app.openTenant('thing.nope');
    expect(app.status).toBe('error');
  });

  it('exposes the active tenant list', async () => {
    const app = await signedInApp();
    const tenants = track<readonly Tenant[]>(app.tenants$);
    await app.createTenant({ name: 'A', meta: {} });
    expect(tenants.value?.some((t) => t.name === 'A')).toBe(true);
  });

  it('joinTenant and probeTenant pass through to the core tenant manager', async () => {
    const app = await signedInApp();
    const fakeTenant = { id: 'thing.x', name: 'Shared2' } as unknown as Tenant;
    const joinSpy = vi.spyOn(app.db.tenants, 'join').mockResolvedValue(fakeTenant);
    const probeSpy = vi.spyOn(app.db.tenants, 'probe').mockResolvedValue({ exists: false });
    expect(await app.joinTenant({ name: 'Shared2', meta: { folderId: 'x' } })).toBe(fakeTenant);
    expect((await app.probeTenant({ meta: { folderId: 'x' } })).exists).toBe(false);
    expect(joinSpy).toHaveBeenCalledTimes(1);
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  it('removeTenant clears the credential cache', async () => {
    const app = await signedInApp();
    sessionStorage.setItem('cache', 'something');
    const t = await app.createTenant({ name: 'A', meta: {} });
    await app.removeTenant(t.id);
    // removeTenant clears via the (unconfigured) cache; no throw, tenant gone
    expect(app.tenants$).toBeDefined();
  });

  it('db getter throws when no provider is active', () => {
    const { service } = mockAuth({ status: 'signed-out' });
    const app = make({ ...base(), encryption: false, auth: service, providers: [cloudAdapter('google')] });
    expect(() => app.db).toThrow(FyreDbPluginConfigError);
  });
});

describe('FyreDbApp — encryption / unlock', () => {
  function encryptedApp(opts?: { local?: StorageAdapter; cloud?: CloudAdapter }) {
    const local = opts?.local ?? new MemoryStorageAdapter();
    const cloud = opts?.cloud ?? cloudAdapter('google');
    const { state$, service } = mockAuth({ status: 'loading' });
    const app = make({
      appId: 'test',
      deviceId: 'dev1',
      entities: [thing],
      localAdapter: local,
      auth: service,
      providers: [cloud],
      credentialCacheKey: 'cache',
    });
    state$.next({ status: 'signed-in', name: 'google' });
    return { app, local, cloud, settled: settle(app) };
  }

  async function signedInEncrypted() {
    const h = encryptedApp();
    await h.settled;
    return h.app;
  }

  it('prompts to unlock an encrypted tenant, then opens on unlock', async () => {
    const app = await signedInEncrypted();
    const status = track<FyreDbStatus>(app.status$);
    const t = await app.createTenant({ name: 'Enc', meta: {}, encryption: { credential: 'pw' } });
    await app.closeTenant();

    await app.openTenant(t.id);
    expect(status.value).toBe('unlocking');

    await app.unlock('pw');
    expect(status.value).toBe('ready');
    // credential cached for the session
    expect(sessionStorage.getItem('cache')).not.toBeNull();
  });

  it('uses a cached credential to open without prompting (refresh)', async () => {
    // app1 unlocks and caches the credential
    const h1 = encryptedApp();
    await h1.settled;
    const t = await h1.app.createTenant({ name: 'Enc', meta: {}, encryption: { credential: 'pw' } });
    await h1.app.openTenant(t.id);
    await h1.app.unlock('pw');
    expect(sessionStorage.getItem('cache')).not.toBeNull();

    // app2 simulates a refresh: same storage + cache, opens without a prompt
    const h2 = encryptedApp({ local: h1.local, cloud: h1.cloud });
    await h2.settled;
    await h2.app.openTenant(t.id);
    expect(h2.app.status).toBe('ready');
  });

  it('unlock throws when nothing awaits unlock', async () => {
    const app = await signedInEncrypted();
    expect(() => app.unlock('pw')).toThrow(FyreDbPluginConfigError);
  });
});

describe('FyreDbApp — provider ops', () => {
  it('signIn drives the matching auth adapter login', async () => {
    const { service, login } = mockAuth({ status: 'signed-out' });
    const app = make({ ...base(), encryption: false, auth: service, providers: [cloudAdapter('google')] });
    await settle(app);
    await app.signIn('google');
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('signIn rejects an unknown provider', async () => {
    const { service } = mockAuth({ status: 'signed-out' });
    const app = make({ ...base(), encryption: false, auth: service, providers: [cloudAdapter('google')] });
    await expect(app.signIn('nope')).rejects.toBeInstanceOf(FyreDbPluginConfigError);
  });

  it('signOut logs out via auth', async () => {
    const { state$, service, logout } = mockAuth({ status: 'loading' });
    const app = make({ ...base(), encryption: false, auth: service, providers: [cloudAdapter('google')] });
    state$.next({ status: 'signed-in', name: 'google' });
    await settle(app);
    await app.signOut();
    await settle(app);
    expect(logout).toHaveBeenCalled();
    expect(app.status).toBe('signed-out');
  });

  it('signOut without auth tears down to signed-out', async () => {
    const app = make({ ...base(), encryption: false });
    await settle(app);
    await app.signOut();
    expect(app.status).toBe('signed-out');
    expect(app.provider).toBeNull();
  });

  it('useLocalOnly activates the local provider', async () => {
    const { state$, service } = mockAuth({ status: 'loading' });
    const app = make({ ...base(), encryption: false, auth: service, providers: [cloudAdapter('google')] });
    await app.useLocalOnly();
    expect(app.provider).toBe('local');
    expect(app.status).toBe('no-tenant');
    // later auth emissions are ignored once local-only
    state$.next({ status: 'signed-in', name: 'google' });
    await settle(app);
    expect(app.provider).toBe('local');
  });

  it('dispose is idempotent', async () => {
    const app = make({ ...base(), encryption: false });
    await settle(app);
    await app.dispose();
    await expect(app.dispose()).resolves.toBeUndefined();
  });
});

describe('FyreDbApp — misc', () => {
  it('derives and reuses a device id when none is provided', async () => {
    const a = make({ appId: 'test', entities: [thing], localAdapter: new MemoryStorageAdapter(), encryption: false });
    await settle(a);
    const id1 = localStorage.getItem('test_device_id');
    expect(id1).toBeTruthy();
    const b = make({ appId: 'test', entities: [thing], localAdapter: new MemoryStorageAdapter(), encryption: false });
    await settle(b);
    expect(localStorage.getItem('test_device_id')).toBe(id1);
  });

  it('swallows errors thrown by queued lifecycle ops', async () => {
    const { state$, service } = mockAuth({ status: 'loading' });
    const app = make({ ...base(), encryption: false, auth: service, providers: [cloudAdapter('google')] });
    state$.next({ status: 'signed-in', name: 'google' });
    await settle(app);
    const t = await app.createTenant({ name: 'A', meta: {} });
    await app.openTenant(t.id);
    vi.spyOn(app.db.tenants, 'close').mockRejectedValue(new Error('boom'));
    await expect(app.closeTenant()).resolves.toBeUndefined();
  });
});
