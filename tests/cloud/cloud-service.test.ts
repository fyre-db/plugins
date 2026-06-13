import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { CloudService, type CloudAdapter } from '@/cloud/cloud-service';
import type { ClientAuthService } from '@/auth/client-auth-service';
import type { AuthState } from '@/auth/types';
import { FyreDbPluginConfigError } from '@/errors/fyredb-error';

function mockAdapter(name: string): CloudAdapter {
  return {
    name,
    read: vi.fn(async () => null),
    write: vi.fn(async () => {}),
    delete: vi.fn(async () => false),
  } as unknown as CloudAdapter;
}

function mockAuth(initial: AuthState = { status: 'loading' }) {
  const state$ = new BehaviorSubject<AuthState>(initial);
  return { state$, service: { state$ } as unknown as ClientAuthService };
}

describe('CloudService', () => {
  it('throws FyreDbPluginConfigError on duplicate adapter names', () => {
    const { service } = mockAuth();
    const a = mockAdapter('google');
    const b = mockAdapter('google');
    expect(() => new CloudService([a, b], service)).toThrow(FyreDbPluginConfigError);
  });

  it('active$ emits null initially when state is loading', async () => {
    const { service } = mockAuth({ status: 'loading' });
    const cs = new CloudService([mockAdapter('google')], service);
    const val = await firstValueFrom(cs.active$);
    expect(val).toBeNull();
    cs.dispose();
  });

  it('active$ emits matching adapter when state transitions to signed-in', async () => {
    const google = mockAdapter('google');
    const { state$, service } = mockAuth({ status: 'loading' });
    const cs = new CloudService([google], service);

    state$.next({ status: 'signed-in', name: 'google' });

    const val = await firstValueFrom(cs.active$);
    expect(val).toBe(google);
    cs.dispose();
  });

  it('active$ emits null when signed-in name has no registered adapter', async () => {
    const { state$, service } = mockAuth({ status: 'loading' });
    const cs = new CloudService([mockAdapter('google')], service);

    state$.next({ status: 'signed-in', name: 'dropbox' });

    expect(cs.active).toBeNull();
    cs.dispose();
  });

  it('active$ emits null when signed-in state has no name', async () => {
    const google = mockAdapter('google');
    const { state$, service } = mockAuth({ status: 'signed-in', name: 'google' });
    const cs = new CloudService([google], service);

    state$.next({ status: 'signed-in' } as AuthState);

    expect(cs.active).toBeNull();
    cs.dispose();
  });

  it('active$ emits null when state transitions to signed-out', async () => {
    const { state$, service } = mockAuth({ status: 'signed-in', name: 'google' });
    const cs = new CloudService([mockAdapter('google')], service);

    state$.next({ status: 'signed-out' });

    const val = await firstValueFrom(cs.active$);
    expect(val).toBeNull();
    cs.dispose();
  });

  it('active returns current value synchronously', () => {
    const google = mockAdapter('google');
    const { state$, service } = mockAuth({ status: 'loading' });
    const cs = new CloudService([google], service);

    expect(cs.active).toBeNull();

    state$.next({ status: 'signed-in', name: 'google' });
    expect(cs.active).toBe(google);
    cs.dispose();
  });

  it('supported returns adapter names', () => {
    const { service } = mockAuth();
    const cs = new CloudService([mockAdapter('google'), mockAdapter('dropbox')], service);
    expect(cs.supported).toEqual(['google', 'dropbox']);
    cs.dispose();
  });

  it('resolve returns adapter by name', () => {
    const google = mockAdapter('google');
    const { service } = mockAuth();
    const cs = new CloudService([google], service);
    expect(cs.resolve('google')).toBe(google);
    cs.dispose();
  });

  it('resolve returns undefined for unknown name', () => {
    const { service } = mockAuth();
    const cs = new CloudService([mockAdapter('google')], service);
    expect(cs.resolve('dropbox')).toBeUndefined();
    cs.dispose();
  });

  it('dispose stops reacting to auth changes', () => {
    const google = mockAdapter('google');
    const { state$, service } = mockAuth({ status: 'loading' });
    const cs = new CloudService([google], service);

    cs.dispose();

    state$.next({ status: 'signed-in', name: 'google' });
    expect(cs.active).toBeNull();
  });
});
