import { BehaviorSubject, Subject, type Observable, type Subscription } from 'rxjs';
import {
  FyreDb,
  TenantError,
  type Tenant,
  type CreateTenantOptions,
  type JoinTenantOptions,
  type ProbeResult,
  type EntityDefinition,
  type BlobMigration,
  type StorageAdapter,
  type EncryptionService,
  type FyreDbError,
} from '@fyre-db/core';
import { LocalStorageAdapter } from '@/providers/local';
import { Pbkdf2EncryptionService } from '@/encryption';
import { AesGcmEncryptionStrategy } from '@/encryption';
import type { ClientAuthService } from '@/auth/client-auth-service';
import type { AuthState } from '@/auth/types';
import type { CloudAdapter } from '@/cloud/cloud-service';
import { FyreDbPluginConfigError } from '@/errors/fyredb-error';
import { CredentialCache } from './credential-cache';
import { log } from '@/log';

/** The unified lifecycle state the UI renders from. */
export type FyreDbStatus =
  | 'connecting'
  | 'signed-out'
  | 'no-tenant'
  | 'opening'
  | 'unlocking'
  | 'ready'
  | 'error';

/** A single open tenant. `id` is bumped on every open — the services rebuild key. */
export type Session = {
  readonly id: number;
  readonly tenant: Tenant;
};

export type FyreDbAppConfig = {
  readonly appId: string;
  readonly deviceId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly entities: ReadonlyArray<EntityDefinition<any>>;
  readonly migrations?: ReadonlyArray<BlobMigration>;
  readonly localAdapter?: StorageAdapter;
  /** Pass `false` to disable default encryption. */
  readonly encryption?: EncryptionService | false;
  /** Optional — local-only apps omit it. */
  readonly auth?: ClientAuthService;
  /** Named cloud adapters; `name` matches the auth adapter name. */
  readonly providers?: readonly CloudAdapter[];
  /** sessionStorage key for caching unlock credentials across refreshes. */
  readonly credentialCacheKey?: string;
};

const LOCAL_PROVIDER = 'local';

function getOrCreateDeviceId(appId: string): string {
  const key = `${appId}_device_id`;
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

/**
 * Single long-lived handle that owns the two runtime axes — the active
 * **provider** (which storage adapter + login) and the active **tenant** —
 * behind one stable identity. Wraps a core `FyreDb`, rebuilding it on provider
 * change and issuing a fresh `session` per tenant open. Pure TS: the React
 * layer only observes its state.
 */
export class FyreDbApp {
  private readonly appId: string;
  private readonly deviceId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly entities: ReadonlyArray<EntityDefinition<any>>;
  private readonly migrations?: ReadonlyArray<BlobMigration>;
  private readonly localAdapter: StorageAdapter;
  private readonly encryptionService?: EncryptionService;
  private readonly authService?: ClientAuthService;
  private readonly cloudByName: ReadonlyMap<string, CloudAdapter>;
  private readonly credentialCache: CredentialCache;

  private dbInstance: FyreDb | null = null;
  private dbSubs: Subscription[] = [];
  private authSub: Subscription | null = null;
  private currentProvider: string | null = null;
  private pendingUnlockTenant: string | null = null;
  private localOnly = false;
  private sessionCounter = 0;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  private readonly status$$ = new BehaviorSubject<FyreDbStatus>('connecting');
  private readonly provider$$ = new BehaviorSubject<string | null>(null);
  private readonly tenant$$ = new BehaviorSubject<Tenant | undefined>(undefined);
  private readonly tenants$$ = new BehaviorSubject<readonly Tenant[]>([]);
  private readonly session$$ = new BehaviorSubject<Session | null>(null);
  private readonly errorSubject = new Subject<FyreDbError>();

  readonly status$: Observable<FyreDbStatus> = this.status$$.asObservable();
  readonly provider$: Observable<string | null> = this.provider$$.asObservable();
  readonly tenant$: Observable<Tenant | undefined> = this.tenant$$.asObservable();
  readonly tenants$: Observable<readonly Tenant[]> = this.tenants$$.asObservable();
  readonly session$: Observable<Session | null> = this.session$$.asObservable();
  readonly error$: Observable<FyreDbError> = this.errorSubject.asObservable();

  constructor(config: FyreDbAppConfig) {
    this.appId = config.appId;
    this.deviceId = config.deviceId ?? getOrCreateDeviceId(config.appId);
    this.entities = config.entities;
    this.migrations = config.migrations;
    this.localAdapter = config.localAdapter ?? new LocalStorageAdapter(config.appId);
    this.encryptionService =
      config.encryption === false
        ? undefined
        : config.encryption ?? new Pbkdf2EncryptionService({ targets: ['cloud'], strategy: new AesGcmEncryptionStrategy() });
    this.authService = config.auth;
    this.cloudByName = new Map((config.providers ?? []).map((a) => [a.name, a]));
    this.credentialCache = new CredentialCache(config.credentialCacheKey, this.deviceId);

    if (this.authService) {
      this.authSub = this.authService.state$.subscribe((state) => {
        void this.enqueue(() => this.applyAuthState(state));
      });
    } else {
      void this.enqueue(() => this.buildLocal());
    }
  }

  // ─── Sync getters ────────────────────────────────────────

  get status(): FyreDbStatus { return this.status$$.value; }
  get provider(): string | null { return this.provider$$.value; }
  get providers(): readonly string[] { return [...this.cloudByName.keys()]; }
  get tenant(): Tenant | undefined { return this.tenant$$.value; }
  get tenants(): readonly Tenant[] { return this.tenants$$.value; }
  get session(): Session | null { return this.session$$.value; }
  get auth(): ClientAuthService | undefined { return this.authService; }
  get encryption(): EncryptionService | undefined { return this.encryptionService; }
  get db(): FyreDb {
    if (!this.dbInstance) throw new FyreDbPluginConfigError('FyreDbApp: no active provider');
    return this.dbInstance;
  }

  // ─── Provider ops ────────────────────────────────────────

  async signIn(provider: string): Promise<void> {
    const entry = this.authService?.supportedAuths().find((a) => a.name === provider);
    if (!entry) throw new FyreDbPluginConfigError(`FyreDbApp: unknown provider "${provider}"`);
    this.localOnly = false;
    await this.closeTenant().catch(() => { /* no tenant open */ });
    await entry.login(); // BFF redirect — never resolves
  }

  async signOut(): Promise<void> {
    this.credentialCache.clear();
    if (this.authService) {
      await this.authService.logout(); // → state$ 'signed-out' → teardown
    } else {
      await this.enqueue(async () => {
        await this.teardownDb();
        this.currentProvider = null;
        this.provider$$.next(null);
        this.setStatus('signed-out');
      });
    }
  }

  useLocalOnly(): Promise<void> {
    return this.enqueue(() => this.buildLocal());
  }

  // ─── Tenant ops ──────────────────────────────────────────

  openTenant(id: string, opts?: { credential?: string }): Promise<void> {
    return this.enqueue(() => this.doOpen(id, opts?.credential));
  }

  unlock(password: string): Promise<void> {
    const id = this.pendingUnlockTenant;
    if (!id) throw new FyreDbPluginConfigError('FyreDbApp: no tenant awaiting unlock');
    return this.enqueue(() => this.doOpen(id, password));
  }

  closeTenant(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.dbInstance) return;
      await this.dbInstance.tenants.close();
      this.credentialCache.clear();
      this.pendingUnlockTenant = null;
      this.session$$.next(null);
      this.setStatus('no-tenant');
    });
  }

  createTenant(opts: CreateTenantOptions): Promise<Tenant> { return this.db.tenants.create(opts); }
  joinTenant(opts: JoinTenantOptions): Promise<Tenant> { return this.db.tenants.join(opts); }
  probeTenant(ref: { meta: Record<string, unknown> }): Promise<ProbeResult> { return this.db.tenants.probe(ref); }

  async removeTenant(id: string, opts?: { purge?: boolean }): Promise<void> {
    await this.db.tenants.remove(id, opts);
    this.credentialCache.clear();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.authSub?.unsubscribe();
    await this.enqueue(() => this.teardownDb());
    this.status$$.complete();
    this.provider$$.complete();
    this.tenant$$.complete();
    this.tenants$$.complete();
    this.session$$.complete();
    this.errorSubject.complete();
    log.app('disposed');
  }

  // ─── Internals ───────────────────────────────────────────

  private enqueue(fn: () => Promise<void> | void): Promise<void> {
    this.chain = this.chain.then(() => fn()).catch((e: unknown) => {
      log.app.error('lifecycle error: %s', e instanceof Error ? e.message : String(e));
    });
    return this.chain;
  }

  private async applyAuthState(state: AuthState): Promise<void> {
    if (this.disposed || this.localOnly) return;
    if (state.status === 'loading') {
      this.setStatus('connecting');
      return;
    }
    if (state.status === 'signed-out' || !state.name) {
      await this.teardownDb();
      this.currentProvider = null;
      this.provider$$.next(null);
      this.setStatus('signed-out');
      return;
    }
    // signed-in
    if (this.currentProvider !== state.name) {
      await this.rebuildFor(state.name);
    }
  }

  private async rebuildFor(provider: string): Promise<void> {
    await this.teardownDb();
    this.buildDb(this.cloudByName.get(provider));
    this.currentProvider = provider;
    this.provider$$.next(provider);
    this.setStatus('no-tenant');
    log.app('provider → %s', provider);
  }

  private async buildLocal(): Promise<void> {
    this.localOnly = true;
    await this.teardownDb();
    this.buildDb(undefined);
    this.currentProvider = LOCAL_PROVIDER;
    this.provider$$.next(LOCAL_PROVIDER);
    this.setStatus('no-tenant');
    log.app('provider → local');
  }

  private buildDb(cloudAdapter: StorageAdapter | undefined): void {
    const db = new FyreDb({
      appId: this.appId,
      deviceId: this.deviceId,
      entities: this.entities,
      migrations: this.migrations,
      localAdapter: this.localAdapter,
      cloudAdapter,
      encryptionService: this.encryptionService,
    });
    this.dbInstance = db;
    this.dbSubs.push(db.tenants.activeTenant$.subscribe((t) => { this.tenant$$.next(t); }));
    this.dbSubs.push(db.tenants.tenants$.subscribe((list) => { this.tenants$$.next(list); }));
    this.dbSubs.push(db.observe('error').subscribe((e) => { this.errorSubject.next(e); }));
  }

  private async teardownDb(): Promise<void> {
    for (const sub of this.dbSubs) sub.unsubscribe();
    this.dbSubs = [];
    const db = this.dbInstance;
    this.dbInstance = null;
    this.pendingUnlockTenant = null;
    this.tenant$$.next(undefined);
    this.tenants$$.next([]);
    this.session$$.next(null);
    if (db) await db.dispose();
  }

  private async doOpen(id: string, credential?: string): Promise<void> {
    const db = this.dbInstance;
    if (!db) throw new FyreDbPluginConfigError('FyreDbApp: no active provider');
    this.setStatus('opening');
    const cred = credential ?? this.credentialCache.read(id);
    try {
      await db.tenants.open(id, cred ? { credential: cred } : undefined);
      if (cred) this.credentialCache.write(id, cred);
      this.pendingUnlockTenant = null;
      const tenant = db.tenants.activeTenant;
      if (tenant) this.session$$.next({ id: ++this.sessionCounter, tenant });
      this.setStatus('ready');
      log.app('tenant %s ready (session %d)', id, this.sessionCounter);
    } catch (err) {
      if (err instanceof TenantError && err.kind === 'credential-required') {
        this.pendingUnlockTenant = id;
        this.setStatus('unlocking');
        return;
      }
      this.pendingUnlockTenant = null;
      this.setStatus('error');
      log.app.error('open %s failed: %s', id, err instanceof Error ? err.message : String(err));
    }
  }

  private setStatus(s: FyreDbStatus): void {
    if (this.status$$.value !== s) this.status$$.next(s);
  }
}
