import { describe, it, expect } from 'vitest';
import { validateOneDriveMeta } from '@/providers/microsoft/onedrive-tenant-meta';

describe('validateOneDriveMeta', () => {
  it('accepts approot space', () => {
    const result = validateOneDriveMeta({ space: 'approot' });
    expect(result).toEqual({ space: 'approot', folderId: undefined });
  });

  it('accepts personal space with folderId', () => {
    const result = validateOneDriveMeta({ space: 'personal', folderId: 'abc-123' });
    expect(result).toEqual({ space: 'personal', folderId: 'abc-123' });
  });

  it('accepts shared space with folderId', () => {
    const result = validateOneDriveMeta({ space: 'shared', folderId: 'xyz-789' });
    expect(result).toEqual({ space: 'shared', folderId: 'xyz-789' });
  });

  it('throws when space is missing', () => {
    expect(() => validateOneDriveMeta({})).toThrow('meta.space is required');
  });

  it('throws on invalid space value', () => {
    expect(() => validateOneDriveMeta({ space: 'invalid' })).toThrow('Invalid meta.space');
  });

  it('throws when personal space lacks folderId', () => {
    expect(() => validateOneDriveMeta({ space: 'personal' })).toThrow(
      'meta.folderId is required when space is "personal"',
    );
  });

  it('throws when shared space lacks folderId', () => {
    expect(() => validateOneDriveMeta({ space: 'shared' })).toThrow(
      'meta.folderId is required when space is "shared"',
    );
  });

  it('approot does not require folderId', () => {
    expect(() => validateOneDriveMeta({ space: 'approot' })).not.toThrow();
  });
});
