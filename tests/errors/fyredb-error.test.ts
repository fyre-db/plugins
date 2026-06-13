import { describe, it, expect } from 'vitest';
import {
  FyreDbError,
  StorageError,
  FyreDbPluginConfigError,
} from '@/errors/fyredb-error';

describe('FyreDbError hierarchy', () => {
  it('FyreDbError has correct properties', () => {
    const cause = new Error('raw');
    const err = new FyreDbError('something broke', {
      kind: 'unknown',
      retryable: false,
      cause,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FyreDbError);
    expect(err.name).toBe('FyreDbError');
    expect(err.kind).toBe('unknown');
    expect(err.retryable).toBe(false);
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('something broke');
  });

  it('FyreDbError defaults retryable to false', () => {
    const err = new FyreDbError('msg', { kind: 'unknown' });
    expect(err.retryable).toBe(false);
  });

  it('StorageError auth-expired', () => {
    const err = new StorageError('Token expired', { kind: 'auth-expired' });
    expect(err).toBeInstanceOf(FyreDbError);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.name).toBe('StorageError');
    expect(err.kind).toBe('auth-expired');
    expect(err.retryable).toBe(false);
  });

  it('StorageError quota-exceeded', () => {
    const err = new StorageError('Full', { kind: 'quota-exceeded' });
    expect(err).toBeInstanceOf(FyreDbError);
    expect(err.kind).toBe('quota-exceeded');
    expect(err.retryable).toBe(false);
  });

  it('StorageError not-found', () => {
    const err = new StorageError('Missing', { kind: 'not-found' });
    expect(err.kind).toBe('not-found');
    expect(err.retryable).toBe(false);
  });

  it('StorageError permission-denied', () => {
    const err = new StorageError('Forbidden', { kind: 'permission-denied' });
    expect(err.kind).toBe('permission-denied');
    expect(err.retryable).toBe(false);
  });

  it('StorageError offline', () => {
    const err = new StorageError('No network', { kind: 'offline', retryable: true });
    expect(err.kind).toBe('offline');
    expect(err.retryable).toBe(true);
  });

  it('StorageError rate-limited with retryAfterMs', () => {
    const err = new StorageError('Throttled', { kind: 'rate-limited', retryable: true, retryAfterMs: 5000 });
    expect(err.kind).toBe('rate-limited');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(5000);
  });

  it('StorageError rate-limited without retryAfterMs', () => {
    const err = new StorageError('Throttled', { kind: 'rate-limited', retryable: true });
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('StorageError data-corrupted', () => {
    const err = new StorageError('Bad data', { kind: 'data-corrupted' });
    expect(err.kind).toBe('data-corrupted');
    expect(err.retryable).toBe(false);
  });

  it('StorageError preserves cause', () => {
    const cause = new Error('root cause');
    const err = new StorageError('Failed', { kind: 'auth-expired', cause });
    expect(err.cause).toBe(cause);
  });

  it('can be caught by kind in a switch', () => {
    const err: FyreDbError = new StorageError('Expired', { kind: 'auth-expired' });
    let matched = false;
    switch (err.kind) {
      case 'auth-expired':
        matched = true;
        break;
    }
    expect(matched).toBe(true);
  });

  it('can be caught by instanceof', () => {
    const err: Error = new StorageError('Throttled', { kind: 'rate-limited', retryable: true, retryAfterMs: 1000 });
    expect(err instanceof FyreDbError).toBe(true);
    expect(err instanceof StorageError).toBe(true);
  });

  it('FyreDbPluginConfigError is not a FyreDbError', () => {
    const err = new FyreDbPluginConfigError('Bad config');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FyreDbError);
    expect(err.name).toBe('FyreDbPluginConfigError');
  });
});
