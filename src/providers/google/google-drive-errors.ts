import { StorageError } from '@/errors/fyredb-error';

export function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get('Retry-After');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

export function mapDriveError(response: Response): StorageError {
  const message = `Google Drive API error: ${response.status} ${response.statusText}`;
  switch (response.status) {
    case 401:
      return new StorageError(message, { kind: 'auth-expired' });
    case 403:
      return new StorageError(message, { kind: 'permission-denied' });
    case 404:
      return new StorageError(message, { kind: 'not-found' });
    case 429:
      return new StorageError(message, { kind: 'rate-limited', retryable: true, retryAfterMs: parseRetryAfter(response) });
    default:
      return new StorageError(message, { kind: 'unknown', retryable: response.status >= 500 });
  }
}
