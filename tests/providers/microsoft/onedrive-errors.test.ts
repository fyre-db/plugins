import { describe, it, expect } from 'vitest';
import { parseRetryAfter, mapOneDriveError } from '@/providers/microsoft/onedrive-errors';
import { StorageError } from '@/errors/fyredb-error';

describe('parseRetryAfter', () => {
  it('returns milliseconds from a numeric Retry-After header', () => {
    const res = new Response('', { status: 429, headers: { 'Retry-After': '5' } });
    expect(parseRetryAfter(res)).toBe(5000);
  });

  it('returns undefined when the header is missing', () => {
    const res = new Response('', { status: 429 });
    expect(parseRetryAfter(res)).toBeUndefined();
  });

  it('returns undefined for non-numeric values', () => {
    const res = new Response('', { status: 429, headers: { 'Retry-After': 'soon' } });
    expect(parseRetryAfter(res)).toBeUndefined();
  });
});

describe('mapOneDriveError', () => {
  it('maps 401 to auth-expired', () => {
    const err = mapOneDriveError(new Response('', { status: 401, statusText: 'Unauthorized' }));
    expect(err).toBeInstanceOf(StorageError);
    expect(err.kind).toBe('auth-expired');
    expect(err.retryable).toBe(false);
  });

  it('maps 403 to permission-denied', () => {
    const err = mapOneDriveError(new Response('', { status: 403, statusText: 'Forbidden' }));
    expect(err.kind).toBe('permission-denied');
    expect(err.retryable).toBe(false);
  });

  it('maps 404 to not-found', () => {
    const err = mapOneDriveError(new Response('', { status: 404, statusText: 'Not Found' }));
    expect(err.kind).toBe('not-found');
    expect(err.retryable).toBe(false);
  });

  it('maps 429 to rate-limited with retryable and retryAfterMs', () => {
    const err = mapOneDriveError(
      new Response('', { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '5' } }),
    );
    expect(err.kind).toBe('rate-limited');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(5000);
  });

  it('maps 500 to unknown with retryable true', () => {
    const err = mapOneDriveError(new Response('', { status: 500, statusText: 'Internal Server Error' }));
    expect(err.kind).toBe('unknown');
    expect(err.retryable).toBe(true);
  });

  it('maps 400 to unknown with retryable false', () => {
    const err = mapOneDriveError(new Response('', { status: 400, statusText: 'Bad Request' }));
    expect(err.kind).toBe('unknown');
    expect(err.retryable).toBe(false);
  });

  it('includes status and statusText in the message', () => {
    const err = mapOneDriveError(new Response('', { status: 401, statusText: 'Unauthorized' }));
    expect(err.message).toContain('401');
    expect(err.message).toContain('Unauthorized');
  });
});
