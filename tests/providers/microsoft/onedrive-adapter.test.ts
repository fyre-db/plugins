import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Tenant } from '@fyre-db/core';
import { OneDriveAdapter } from '@/providers/microsoft/onedrive-adapter';
import { StorageError, FyreDbPluginConfigError } from '@/errors/fyredb-error';
import type { AccessToken } from '@/auth/types';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';

function makeTenant(overrides: Partial<Tenant> & { meta: Record<string, unknown> }): Tenant {
  return {
    id: 'tenant-1',
    name: 'Test',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function binaryResponse(data: Uint8Array, status = 200): Response {
  return new Response(data, { status });
}

function errorResponse(status: number, statusText = 'Error'): Response {
  return new Response(null, { status, statusText });
}

describe('OneDriveAdapter', () => {
  let adapter: OneDriveAdapter;
  let mockFetch: Mock;
  const getToken = vi.fn<[], Promise<AccessToken | null>>();

  const approotTenant = makeTenant({ id: 'approot-tenant', meta: { space: 'approot' } });
  const personalTenant = makeTenant({ id: 'personal-tenant', meta: { space: 'personal', folderId: 'folder-123' } });

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    getToken.mockResolvedValue({ name: 'microsoft', token: 'test-token' });
    adapter = new OneDriveAdapter(getToken);
  });

  describe('deriveTenantId', () => {
    it('returns hashed folderId from meta', () => {
      const id = adapter.deriveTenantId({ folderId: 'abc-123' });
      expect(adapter.deriveTenantId({ folderId: 'abc-123' })).toBe(id);
      expect(adapter.deriveTenantId({ folderId: 'xyz-456' })).not.toBe(id);
    });

    it('returns random id when folderId is missing', () => {
      const id = adapter.deriveTenantId({});
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe('getAccessToken', () => {
    it('throws when token is null', async () => {
      getToken.mockResolvedValueOnce(null);
      await expect(adapter.read(approotTenant, 'k')).rejects.toThrow('No access token available');
    });

    it('throws when token name is not microsoft', async () => {
      getToken.mockResolvedValueOnce({ name: 'google', token: 't' });
      await expect(adapter.read(approotTenant, 'k')).rejects.toThrow('Expected microsoft access token');
    });
  });

  describe('read', () => {
    it('returns data for an existing file in approot', async () => {
      const data = new Uint8Array([1, 2, 3]);
      mockFetch.mockResolvedValueOnce(binaryResponse(data));

      const result = await adapter.read(approotTenant, 'key1');
      expect(result).toEqual(data);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(`${GRAPH_API}/me/drive/special/approot:/`);
      expect(url).toContain(':/content');
    });

    it('returns null on 404', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404));
      const result = await adapter.read(approotTenant, 'missing');
      expect(result).toBeNull();
    });

    it('throws on non-404 error', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'));
      await expect(adapter.read(approotTenant, 'key1')).rejects.toThrow(
        'OneDrive API error: 500 Internal Server Error',
      );
    });

    it('uses items path for personal space with folderId', async () => {
      mockFetch.mockResolvedValueOnce(binaryResponse(new Uint8Array([1])));
      await adapter.read(personalTenant, 'key1');
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(`${GRAPH_API}/me/drive/items/folder-123:/`);
    });

    it('uses root path when space has no folderId and is not approot', async () => {
      const driveTenant = makeTenant({ id: 'drive', meta: { space: 'drive' } });
      mockFetch.mockResolvedValueOnce(binaryResponse(new Uint8Array([1])));
      await adapter.read(driveTenant, 'key1');
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(`${GRAPH_API}/me/drive/root:/`);
    });

    it('defaults to approot space when tenant is undefined', async () => {
      mockFetch.mockResolvedValueOnce(binaryResponse(new Uint8Array([1])));
      await adapter.read(undefined, 'global');
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(`${GRAPH_API}/me/drive/special/approot:/`);
    });

    it('sanitizes colons in the file name', async () => {
      mockFetch.mockResolvedValueOnce(binaryResponse(new Uint8Array([1])));
      await adapter.read(approotTenant, 'a:b');
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('_._');
    });
  });

  describe('write', () => {
    it('PUTs file content', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'x' }));
      await adapter.write(approotTenant, 'doc', new Uint8Array([1, 2]));
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain(':/content');
      expect(opts.method).toBe('PUT');
      expect(opts.headers['Content-Type']).toBe('application/octet-stream');
    });

    it('throws on write failure', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'));
      await expect(adapter.write(approotTenant, 'doc', new Uint8Array([1]))).rejects.toThrow(
        StorageError,
      );
    });
  });

  describe('delete', () => {
    it('returns false when file does not exist (resolve 404)', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404));
      const result = await adapter.delete(approotTenant, 'missing');
      expect(result).toBe(false);
    });

    it('deletes an existing file and returns true', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'file-1' }));
      mockFetch.mockResolvedValueOnce(errorResponse(204));

      const result = await adapter.delete(approotTenant, 'key1');
      expect(result).toBe(true);
      const [url, opts] = mockFetch.mock.calls[1];
      expect(url).toBe(`${GRAPH_API}/me/drive/items/file-1`);
      expect(opts.method).toBe('DELETE');
    });

    it('returns false on 404 from delete API', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'file-1' }));
      mockFetch.mockResolvedValueOnce(errorResponse(404));
      const result = await adapter.delete(approotTenant, 'key1');
      expect(result).toBe(false);
    });

    it('throws on non-404 delete error', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'file-1' }));
      mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'));
      await expect(adapter.delete(approotTenant, 'key1')).rejects.toThrow(StorageError);
    });

    it('uses cached file id on a subsequent delete', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'file-1' }));
      mockFetch.mockResolvedValueOnce(errorResponse(204));
      await adapter.delete(approotTenant, 'key1');

      // After deletion the cache entry is cleared, so a second delete re-resolves.
      mockFetch.mockResolvedValueOnce(errorResponse(404));
      const second = await adapter.delete(approotTenant, 'key1');
      expect(second).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('reuses a cached file id when a prior delete returned 404', async () => {
      // Resolve sets the cache, then the DELETE 404 leaves it intact.
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'file-1' }));
      mockFetch.mockResolvedValueOnce(errorResponse(404));
      expect(await adapter.delete(approotTenant, 'key1')).toBe(false);

      // Second delete hits the cache (no resolve fetch) and succeeds.
      mockFetch.mockResolvedValueOnce(errorResponse(204));
      expect(await adapter.delete(approotTenant, 'key1')).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('resolveFileId', () => {
    it('caches the resolved id between operations', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'file-1' }));
      mockFetch.mockResolvedValueOnce(errorResponse(204));
      await adapter.delete(approotTenant, 'key1');
      expect(mockFetch.mock.calls[0][0]).toContain('approot:/');
    });

    it('throws on non-404 resolve error', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(401, 'Unauthorized'));
      await expect(adapter.delete(approotTenant, 'key1')).rejects.toThrow(StorageError);
    });
  });

  describe('tenant meta validation', () => {
    it('throws when meta.space is missing', async () => {
      const badTenant = makeTenant({ meta: {} });
      await expect(adapter.read(badTenant, 'k')).rejects.toThrow('missing required meta.space');
    });

    it('throws when personal space lacks folderId', async () => {
      const badTenant = makeTenant({ meta: { space: 'personal' } });
      await expect(adapter.read(badTenant, 'k')).rejects.toThrow(FyreDbPluginConfigError);
    });
  });
});
