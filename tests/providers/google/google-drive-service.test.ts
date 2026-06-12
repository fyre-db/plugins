import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleDriveService, GOOGLE_DRIVE_SPACES } from '@/providers/google/google-drive-service';
import { StorageError, FyreDbPluginConfigError } from '@/errors/fyredb-error';
import type { AccessToken } from '@/auth/types';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, text: string): Response {
  return new Response(text, { status, statusText: text });
}

const VALID_TOKEN: AccessToken = { name: 'google', token: 'tok123' };

function tokenSupplier(token: AccessToken | null = VALID_TOKEN) {
  return async () => token;
}

describe('GoogleDriveService', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // --- getSpaces ---

  it('getSpaces() returns 3 spaces', async () => {
    const svc = new GoogleDriveService(tokenSupplier());
    const spaces = await svc.getSpaces();
    expect(spaces).toHaveLength(3);
    expect(spaces.map((s) => s.id)).toEqual(['drive', 'sharedWithMe', 'appDataFolder']);
  });

  // --- getListing ---

  it('getListing() builds correct query for myDrive root', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

    const svc = new GoogleDriveService(tokenSupplier());
    await svc.getListing(GOOGLE_DRIVE_SPACES.myDrive, null, '');

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = new URL(mockFetch.mock.calls[0][0] as string);
    const q = url.searchParams.get('q')!;
    expect(q).toContain("'root' in parents");
    expect(q).toContain('trashed=false');
  });

  it('getListing() builds correct query for a subfolder', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

    const svc = new GoogleDriveService(tokenSupplier());
    await svc.getListing(GOOGLE_DRIVE_SPACES.myDrive, 'folder-abc', '');

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    const q = url.searchParams.get('q')!;
    expect(q).toContain("'folder-abc' in parents");
    expect(q).not.toContain("'root' in parents");
  });

  it('getListing() builds correct query for sharedWithMe without parentId', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

    const svc = new GoogleDriveService(tokenSupplier());
    await svc.getListing(GOOGLE_DRIVE_SPACES.sharedWithMe, null, '');

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    const q = url.searchParams.get('q')!;
    expect(q).toContain('sharedWithMe=true');
    expect(q).not.toContain('in parents');
  });

  it('getListing() includes search term in query when provided', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

    const svc = new GoogleDriveService(tokenSupplier());
    await svc.getListing(GOOGLE_DRIVE_SPACES.myDrive, null, 'budget');

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    const q = url.searchParams.get('q')!;
    expect(q).toContain("name contains 'budget'");
  });

  it('getListing() throws StorageError on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'));

    const svc = new GoogleDriveService(tokenSupplier());
    await expect(
      svc.getListing(GOOGLE_DRIVE_SPACES.myDrive, null, ''),
    ).rejects.toThrow(StorageError);
  });

  // --- createFolder ---

  it('createFolder() posts to Drive API with name and parents', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ id: 'new-id', name: 'Reports', mimeType: 'application/vnd.google-apps.folder' }),
    );

    const svc = new GoogleDriveService(tokenSupplier());
    const file = await svc.createFolder(GOOGLE_DRIVE_SPACES.myDrive, 'Reports', 'parent-123');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://www.googleapis.com/drive/v3/files');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe('Reports');
    expect(body.parents).toEqual(['parent-123']);
    expect(file.id).toBe('new-id');
    expect(file.isFolder).toBe(true);
  });

  it('createFolder() throws FyreDbPluginConfigError when sharedWithMe and no parentId', async () => {
    const svc = new GoogleDriveService(tokenSupplier());
    await expect(
      svc.createFolder(GOOGLE_DRIVE_SPACES.sharedWithMe, 'Folder', null),
    ).rejects.toThrow(FyreDbPluginConfigError);
  });

  // --- requireToken ---

  it('requireToken() throws StorageError auth-expired when token is null', async () => {
    const svc = new GoogleDriveService(tokenSupplier(null));
    await expect(
      svc.getListing(GOOGLE_DRIVE_SPACES.myDrive, null, ''),
    ).rejects.toThrow(StorageError);
  });

  it('requireToken() throws StorageError auth-expired when token name is not google', async () => {
    const wrongToken: AccessToken = { name: 'dropbox', token: 'tok456' };
    const svc = new GoogleDriveService(tokenSupplier(wrongToken));
    await expect(
      svc.getListing(GOOGLE_DRIVE_SPACES.myDrive, null, ''),
    ).rejects.toThrow(StorageError);
  });
});
