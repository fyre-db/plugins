import { describe, it, expect } from 'vitest';
import { validateGoogleDriveMeta } from '@/providers/google/google-tenant-meta';

describe('validateGoogleDriveMeta', () => {
  it('accepts appDataFolder space', () => {
    const result = validateGoogleDriveMeta({ space: 'appDataFolder' });
    expect(result).toEqual({ space: 'appDataFolder', folderId: undefined });
  });

  it('accepts drive space with folderId', () => {
    const result = validateGoogleDriveMeta({ space: 'drive', folderId: 'abc-123' });
    expect(result).toEqual({ space: 'drive', folderId: 'abc-123' });
  });

  it('accepts sharedWithMe space with folderId', () => {
    const result = validateGoogleDriveMeta({ space: 'sharedWithMe', folderId: 'xyz-789' });
    expect(result).toEqual({ space: 'sharedWithMe', folderId: 'xyz-789' });
  });

  it('throws when space is missing', () => {
    expect(() => validateGoogleDriveMeta({})).toThrow('meta.space is required');
  });

  it('throws on invalid space value', () => {
    expect(() => validateGoogleDriveMeta({ space: 'invalid' })).toThrow('Invalid meta.space');
  });

  it('throws when drive space lacks folderId', () => {
    expect(() => validateGoogleDriveMeta({ space: 'drive' })).toThrow(
      'meta.folderId is required when space is "drive"',
    );
  });

  it('throws when sharedWithMe space lacks folderId', () => {
    expect(() => validateGoogleDriveMeta({ space: 'sharedWithMe' })).toThrow(
      'meta.folderId is required when space is "sharedWithMe"',
    );
  });

  it('appDataFolder does not require folderId', () => {
    expect(() => validateGoogleDriveMeta({ space: 'appDataFolder' })).not.toThrow();
  });
});
