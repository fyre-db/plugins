import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Tenant } from '@fyre-db/core';
import { GoogleDriveAdapter } from '@/providers/google/google-drive-adapter';
import {
  StorageError,
  FyreDbPluginConfigError,
  FyreDbError,
} from '@/errors/fyredb-error';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

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

describe('GoogleDriveAdapter', () => {
  let adapter: GoogleDriveAdapter;
  let mockFetch: Mock;
  const getToken = vi.fn().mockResolvedValue({ name: 'google', token: 'test-token' });

  const appDataTenant = makeTenant({
    id: 'app-tenant',
    meta: { space: 'appDataFolder' },
  });

  const driveTenant = makeTenant({
    id: 'drive-tenant',
    meta: { space: 'drive', folderId: 'folder-123' },
  });

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    getToken.mockResolvedValue({ name: 'google', token: 'test-token' });
    adapter = new GoogleDriveAdapter(getToken);
  });

  describe('deriveTenantId', () => {
    it('returns hashed folderId from meta', () => {
      const id = adapter.deriveTenantId({ folderId: 'abc-123' });
      expect(id).toHaveLength(6);
      // Deterministic: same input always produces same hash
      expect(adapter.deriveTenantId({ folderId: 'abc-123' })).toBe(id);
      // Different input produces different hash
      expect(adapter.deriveTenantId({ folderId: 'xyz-456' })).not.toBe(id);
    });

    it('returns random id when folderId is missing', () => {
      const id = adapter.deriveTenantId({});
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe('read', () => {
    it('returns null when file is not found in Drive', async () => {
      // resolveFileId returns no files
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

      const result = await adapter.read(appDataTenant, 'key1');
      expect(result).toBeNull();
    });

    it('returns data for an existing file', async () => {
      const data = new Uint8Array([1, 2, 3]);
      // resolveFileId finds the file
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [{ id: 'file-1' }] }));
      // read content
      mockFetch.mockResolvedValueOnce(binaryResponse(data));

      const result = await adapter.read(appDataTenant, 'key1');
      expect(result).toEqual(data);
      expect(mockFetch.mock.calls[1][0]).toContain(`${DRIVE_API}/file-1?alt=media`);
    });

    it('returns null and clears cache on 404 during content fetch', async () => {
      // resolveFileId finds the file
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [{ id: 'file-1' }] }));
      // content fetch returns 404
      mockFetch.mockResolvedValueOnce(errorResponse(404));

      const result = await adapter.read(appDataTenant, 'key1');
      expect(result).toBeNull();

      // Next read should re-resolve (cache cleared)
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));
      await adapter.read(appDataTenant, 'key1');
      // Should have called resolveFileId again (3rd call)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('throws DriveApiError on non-404 error', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [{ id: 'file-1' }] }));
      mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'));

      await expect(adapter.read(appDataTenant, 'key1')).rejects.toThrow(
        'Google Drive API error: 500 Internal Server Error',
      );
    });

    it('uses cached fileId on subsequent reads', async () => {
      const data = new Uint8Array([10]);
      // First read: resolve + content
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [{ id: 'file-1' }] }));
      mockFetch.mockResolvedValueOnce(binaryResponse(data));
      await adapter.read(appDataTenant, 'key1');

      // Second read: only content (cached fileId)
      mockFetch.mockResolvedValueOnce(binaryResponse(data));
      await adapter.read(appDataTenant, 'key1');

      // 3 total calls: resolve, content, content (no second resolve)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('read without tenant (appDataFolder default)', () => {
    it('uses appDataFolder space when tenant is undefined', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

      await adapter.read(undefined, 'global-key');

      const url = new URL(mockFetch.mock.calls[0][0] as string);
      expect(url.searchParams.get('spaces')).toBe('appDataFolder');
      expect(url.searchParams.get('q')).toContain("'appDataFolder' in parents");
    });
  });

  describe('write', () => {
    it('creates a new file with multipart upload when file does not exist', async () => {
      const data = new Uint8Array([65, 66, 67]);
      // resolveFileId: no existing file
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));
      // create returns new file id
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'new-file-1' }));

      await adapter.write(appDataTenant, 'doc', data);

      const [url, opts] = mockFetch.mock.calls[1];
      expect(url).toBe(`${UPLOAD_API}?uploadType=multipart`);
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toContain('multipart/related');
    });

    it('caches the file id after creation', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'new-file-1' }));
      await adapter.write(appDataTenant, 'doc', new Uint8Array([1]));

      // Second write should use cached id — only 1 call (PATCH, no resolve)
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await adapter.write(appDataTenant, 'doc', new Uint8Array([2]));

      const [url, opts] = mockFetch.mock.calls[2];
      expect(url).toContain(`${UPLOAD_API}/new-file-1?uploadType=media`);
      expect(opts.method).toBe('PATCH');
    });

    it('updates an existing file with PATCH', async () => {
      const data = new Uint8Array([99]);
      // resolveFileId finds existing file
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [{ id: 'existing-1' }] }));
      // PATCH succeeds
      mockFetch.mockResolvedValueOnce(jsonResponse({}));

      await adapter.write(appDataTenant, 'doc', data);

      const [url, opts] = mockFetch.mock.calls[1];
      expect(url).toBe(`${UPLOAD_API}/existing-1?uploadType=media`);
      expect(opts.method).toBe('PATCH');
      expect(opts.headers['Content-Type']).toBe('application/octet-stream');
    });

    it('throws on create failure', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));
      mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'));

      await expect(adapter.write(appDataTenant, 'doc', new Uint8Array([1]))).rejects.toThrow(
        StorageError,
      );
    });

    it('throws on update failure', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [{ id: 'f1' }] }));
      mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'));

      await expect(adapter.write(appDataTenant, 'doc', new Uint8Array([1]))).rejects.toThrow(
        FyreDbError,
      );
    });

    it('sets parents to folderId for drive space tenant', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'new-1' }));

      await adapter.write(driveTenant, 'doc', new Uint8Array([1]));

      // The multipart body should contain the folderId as parent
      const body = mockFetch.mock.calls[1][1].body as Uint8Array;
      const bodyText = new TextDecoder().decode(body);
      expect(bodyText).toContain('"parents":["folder-123"]');
    });

    it('sets parents to appDataFolder for appDataFolder tenant', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'new-1' }));

      await adapter.write(appDataTenant, 'doc', new Uint8Array([1]));

      const body = mockFetch.mock.calls[1][1].body as Uint8Array;
      const bodyText = new TextDecoder().decode(body);
      expect(bodyText).toContain('"parents":["appDataFolder"]');
    });
  });

  describe('delete', () => {
    it('returns false when file does not exist', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

      const result = await adapter.delete(appDataTenant, 'missing');
      expect(result).toBe(false);
    });

    it('deletes an existing file and returns true', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [{ id: 'file-1' }] }));
      mockFetch.mockResolvedValueOnce(errorResponse(204));

      const result = await adapter.delete(appDataTenant, 'key1');
      expect(result).toBe(true);

      const [url, opts] = mockFetch.mock.calls[1];
      expect(url).toBe(`${DRIVE_API}/file-1`);
      expect(opts.method).toBe('DELETE');
    });

    it('returns false on 404 from delete API', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [{ id: 'file-1' }] }));
      mockFetch.mockResolvedValueOnce(errorResponse(404));

      const result = await adapter.delete(appDataTenant, 'key1');
      expect(result).toBe(false);
    });

    it('throws on non-404 error', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [{ id: 'file-1' }] }));
      mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'));

      await expect(adapter.delete(appDataTenant, 'key1')).rejects.toThrow(
        'Google Drive API error: 500 Internal Server Error',
      );
    });

    it('clears cache so next access re-resolves', async () => {
      // Populate cache via read
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [{ id: 'file-1' }] }));
      mockFetch.mockResolvedValueOnce(binaryResponse(new Uint8Array([1])));
      await adapter.read(appDataTenant, 'key1');

      // Delete the file
      mockFetch.mockResolvedValueOnce(errorResponse(204));
      await adapter.delete(appDataTenant, 'key1');

      // Next read should re-resolve (cache cleared)
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));
      const result = await adapter.read(appDataTenant, 'key1');
      expect(result).toBeNull();
      // resolve, read, delete (cached id), resolve = 4 calls
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });

  describe('resolveFileId', () => {
    it('queries with appDataFolder space', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

      await adapter.read(appDataTenant, 'key1');

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('spaces')).toBe('appDataFolder');
      const q = url.searchParams.get('q')!;
      expect(q).toContain("'appDataFolder' in parents");
    });

    it('queries with folderId for drive space', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

      await adapter.read(driveTenant, 'key1');

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('spaces')).toBeNull();
      const q = url.searchParams.get('q')!;
      expect(q).toContain("'folder-123' in parents");
    });

    it('throws on resolve API error', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(401, 'Unauthorized'));

      await expect(adapter.read(appDataTenant, 'key1')).rejects.toThrow(
        StorageError,
      );
    });

    it('escapes special characters in file name', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

      await adapter.read(appDataTenant, "file'name");

      const url = new URL(mockFetch.mock.calls[0][0]);
      const q = url.searchParams.get('q')!;
      expect(q).toContain("file\\'name");
    });
  });

  describe('tenant meta validation', () => {
    it('throws when tenant meta.space is missing', async () => {
      const badTenant = makeTenant({ meta: {} });

      await expect(adapter.read(badTenant, 'k')).rejects.toThrow('missing required meta.space');
    });

    it('throws when drive space tenant lacks folderId', async () => {
      const badTenant = makeTenant({ meta: { space: 'drive' } });

      await expect(adapter.read(badTenant, 'k')).rejects.toThrow('requires meta.folderId');
    });
  });

  describe('authorization', () => {
    it('passes bearer token to all requests', async () => {
      getToken.mockResolvedValue({ name: 'google', token: 'my-secret-token' });
      mockFetch.mockResolvedValueOnce(jsonResponse({ files: [{ id: 'f1' }] }));
      mockFetch.mockResolvedValueOnce(binaryResponse(new Uint8Array([1])));

      await adapter.read(appDataTenant, 'key1');

      for (const call of mockFetch.mock.calls) {
        expect(call[1].headers.Authorization || call[1].headers.authorization)
          .toBe('Bearer my-secret-token');
      }
    });
  });
});
