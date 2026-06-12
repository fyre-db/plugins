import { BehaviorSubject, distinctUntilChanged, type Observable, type Subscription } from 'rxjs';
import type { StorageAdapter } from '@fyre-db/core';
import type { ClientAuthService } from '@/auth/client-auth-service';
import { FyreDbPluginConfigError } from '@/errors/fyredb-error';
import { log } from '@/log';

/** A named storage adapter — the name matches the auth adapter name. */
export type CloudAdapter = StorageAdapter & {
  readonly name: string;
};

/**
 * Resolves the active cloud storage adapter based on auth state.
 * Subscribes to `auth.state$` — when auth transitions to `signed-in`
 * with a given name, activates the matching `CloudAdapter`.
 *
 * Mirrors the `ClientAuthService` pattern: adapters are registered by
 * name, and the service owns the reactive active state.
 */
export class CloudService {
  private readonly byName: ReadonlyMap<string, CloudAdapter>;
  private readonly active$$: BehaviorSubject<CloudAdapter | null>;
  private readonly sub: Subscription;

  readonly active$: Observable<CloudAdapter | null>;

  constructor(
    adapters: readonly CloudAdapter[],
    auth: ClientAuthService,
  ) {
    const byName = new Map<string, CloudAdapter>();
    for (const a of adapters) {
      if (byName.has(a.name)) throw new FyreDbPluginConfigError(`CloudService: duplicate adapter name "${a.name}"`);
      byName.set(a.name, a);
    }
    this.byName = byName;
    this.active$$ = new BehaviorSubject<CloudAdapter | null>(null);
    this.active$ = this.active$$.pipe(distinctUntilChanged());

    this.sub = auth.state$.subscribe((state) => {
      if (state.status === 'signed-in' && state.name) {
        const adapter = byName.get(state.name) ?? null;
        log.cloud('active adapter → %s', adapter?.name ?? 'none');
        this.active$$.next(adapter);
      } else {
        log.cloud('active adapter → none (signed-out)');
        this.active$$.next(null);
      }
    });
  }

  get active(): CloudAdapter | null {
    return this.active$$.getValue();
  }

  get supported(): readonly string[] {
    return [...this.byName.keys()];
  }

  resolve(name: string): CloudAdapter | undefined {
    return this.byName.get(name);
  }

  dispose(): void {
    this.sub.unsubscribe();
  }
}
