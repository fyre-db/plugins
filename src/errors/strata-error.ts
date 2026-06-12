import { StrataError, StrataConfigError } from '@fyre-db/core';

export { StrataError, StrataConfigError } from '@fyre-db/core';

export type StorageErrorKind =
  | 'auth-expired'
  | 'quota-exceeded'
  | 'not-found'
  | 'permission-denied'
  | 'offline'
  | 'rate-limited'
  | 'data-corrupted'
  | 'unknown';

export class StorageError extends StrataError {
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

export class StrataPluginConfigError extends StrataConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'StrataPluginConfigError';
  }
}
