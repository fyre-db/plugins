import { FyreDbError, FyreDbConfigError } from '@fyre-db/core';

export { FyreDbError, FyreDbConfigError } from '@fyre-db/core';

export type StorageErrorKind =
  | 'auth-expired'
  | 'quota-exceeded'
  | 'not-found'
  | 'permission-denied'
  | 'offline'
  | 'rate-limited'
  | 'data-corrupted'
  | 'unknown';

export class StorageError extends FyreDbError {
  readonly retryAfterMs?: number;

  constructor(message: string, options: {
    readonly kind: StorageErrorKind;
    readonly retryable?: boolean;
    readonly retryAfterMs?: number;
    readonly cause?: Error;
  }) {
    super(message, { kind: options.kind, retryable: options.retryable, cause: options.cause });
    this.name = 'StorageError';
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class FyreDbPluginConfigError extends FyreDbConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'FyreDbPluginConfigError';
  }
}
