import { BehaviorSubject, distinctUntilChanged, type Observable } from 'rxjs';
import type { AccessToken, ClientAuthAdapter, AuthState, FeatureCreds } from './types';
import { FyreDbPluginConfigError } from '@/errors/fyredb-error';
import type { StorageSlot } from '@/storage';
import { log } from '@/log';

export type SupportedAuth = {
  readonly name: string;
  /** Begin the login flow for this adapter via the service. */
  login(feature?: string): Promise<void>;
};

const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

/**
 * Single browser-side auth surface. Aggregates `ClientAuthAdapter`s and
 * owns the **only** in-memory copy of the current access token, the active
 * adapter (encoded in `cached.name`), and inflight coalescing.
 *
 * The server-side refresh cookie carries the provider name, so the client
 * does not need to persist the active adapter — the first successful
 * `refresh()` determines who is signed in.
 *
 * Per PLUGGABLES_V2 §5 + decision SA22.
 */
export class ClientAuthService {
  private readonly byName: ReadonlyMap<string, ClientAuthAdapter>;
  private cached: AccessToken | null = null;
  private inflight: Promise<AccessToken | null> | null = null;
  private readonly featureTokenCache = new Map<string, AccessToken>();
  private readonly state$$: BehaviorSubject<AuthState>;
  private readonly returnUrlSlot: StorageSlot;
  private readonly featureCredsSlot: StorageSlot;
  readonly state$: Observable<AuthState>;

  constructor(
    private readonly adapters: readonly ClientAuthAdapter[],
    options: { readonly returnUrl: StorageSlot; readonly featureCreds: StorageSlot },
  ) {
    const byName = new Map<string, ClientAuthAdapter>();
    for (const a of adapters) {
      if (byName.has(a.name)) throw new FyreDbPluginConfigError(`ClientAuthService: duplicate adapter name "${a.name}"`);
      byName.set(a.name, a);
    }
    this.byName = byName;
    this.returnUrlSlot = options.returnUrl;
    this.featureCredsSlot = options.featureCreds;
    this.state$$ = new BehaviorSubject<AuthState>({ status: 'loading' });
    this.state$ = this.state$$.pipe(
      distinctUntilChanged((a, b) => a.status === b.status && a.name === b.name && a.profile?.userId === b.profile?.userId),
    );

    // Probe adapters so state$ transitions from 'loading' to
    // 'signed-in' or 'signed-out' without waiting for the first
    // explicit getAccessToken() call.
    log.auth('initialized with %d adapters', adapters.length);
    void this.getAccessToken();
  }

  /** Synchronous snapshot of the current auth state (for `useSyncExternalStore`). */
  get state(): AuthState {
    return this.state$$.value;
  }

  /**
   * Returns the cached token if it has more than 5 minutes of life left,
   * otherwise refreshes by trying each adapter. Coalesces concurrent calls.
   * Emits `signed-in` / `signed-out` as appropriate.
   *
   * Returns `null` when no adapter has a valid session.
   */
  async getAccessToken(): Promise<AccessToken | null> {
    if (this.cached && (this.cached.expiresAt ?? 0) - Date.now() > REFRESH_LEEWAY_MS) {
      return this.cached;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.refreshAny();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /**
   * Drives the login page. Each `login()` invokes the adapter directly
   * (BFF login redirects, so we never come back to this code path
   * post-call).
   */
  supportedAuths(): readonly SupportedAuth[] {
    return this.adapters.map((a) => ({
      name: a.name,
      login: async (feature?: string) => {
        this.returnUrlSlot.set(window.location.href);
        if (!feature || feature === 'login') this.cached = null;
        await a.login(feature);
      },
    }));
  }

  /**
   * Refresh a feature-scoped token. Unlike `getAccessToken()`, this does
   * not affect the cached login token or auth state — it returns a
   * one-off access token for the requested feature.
   */
  async getFeatureToken(adapterName: string, feature: string, refreshToken: string): Promise<AccessToken | null> {
    const adapter = this.byName.get(adapterName);
    if (!adapter) return null;

    // Return cached token if still valid (5-minute margin)
    const cacheKey = `${adapterName}:${feature}:${refreshToken}`;
    const cached = this.featureTokenCache.get(cacheKey);
    if (cached?.expiresAt && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
      return cached;
    }

    const result = await adapter.refresh(feature, refreshToken);
    if (result) {
      this.featureTokenCache.set(cacheKey, result);
    }
    return result;
  }

  /**
   * Reads and clears the saved return URL from its storage slot.
   * Returns the URL if one was saved before the last login redirect,
   * or `fallback` if none was saved.
   */
  consumeReturnUrl(fallback = '/'): string {
    const raw = this.returnUrlSlot.get();
    this.returnUrlSlot.clear();
    if (!raw) return fallback;
    try {
      const url = new URL(raw);
      return url.pathname + url.search + url.hash;
    } catch {
      return raw;
    }
  }

  /**
   * Processes the OAuth callback by delegating to each adapter's
   * `handleCallback()`. Stores creds in the feature-creds slot.
   * Returns the return URL and parsed creds.
   */
  handleCallback(fallbackUrl = '/'): { returnUrl: string; creds: FeatureCreds | null } {
    const returnUrl = this.consumeReturnUrl(fallbackUrl);
    for (const adapter of this.adapters) {
      if (!adapter.handleCallback) continue;
      const creds = adapter.handleCallback();
      if (creds) {
        this.featureCredsSlot.set(JSON.stringify(creds));
        return { returnUrl, creds };
      }
    }
    return { returnUrl, creds: null };
  }

  /**
   * Logs out the active adapter (best-effort), clears cached token,
   * emits `signed-out`.
   */
  async logout(): Promise<void> {
    const name = this.cached?.name;
    const adapter = name ? this.byName.get(name) : undefined;
    this.cached = null;
    this.emit();
    log.auth('logout, adapter=%s', name ?? 'all');
    if (adapter) {
      await adapter.logout();
    } else {
      for (const a of this.adapters) {
        try { await a.logout(); } catch { /* best-effort */ }
      }
    }
  }

  // ─── internals ───────────────────────────────────────────

  private async refreshAny(): Promise<AccessToken | null> {
    for (const adapter of this.adapters) {
      let refreshed;
      try {
        refreshed = await adapter.refresh();
      } catch {
        refreshed = null;
      }
      if (refreshed) {
        this.cached = refreshed;
        log.auth('refreshed via adapter %s', adapter.name);
        this.emit();
        return this.cached;
      }
    }
    log.auth('all adapters failed refresh');
    this.cached = null;
    this.emit();
    return null;
  }

  private emit(): void {
    this.state$$.next(
      this.cached
        ? { status: 'signed-in', name: this.cached.name, profile: this.cached.profile }
        : { status: 'signed-out' },
    );
  }
}
