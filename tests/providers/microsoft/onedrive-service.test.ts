import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OneDriveService, ONEDRIVE_SPACES } from '@/providers/microsoft/onedrive-service';
import { StorageError } from '@/errors/fyredb-error';
import type { AccessToken } from '@/auth/types';
import type { CloudSpace } from '@/cloud/cloud-file-service';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const VALID_TOKEN: AccessToken = { name: 'microsoft', token: 'tok123' };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, text: string): Response {
  return new Response(text, { status, statusText: text });
}

function tokenSupplier(token: AccessToken | null = VALID_TOKEN) {
  return async () => token;
}

const MY_FILES: CloudSpace = ONEDRIVE_SPACES.myFiles;
const SHARED: CloudSpace = ONEDRIVE_SPACES.shared;
const APP_DATA: CloudSpace = ONEDRIVE_SPACES.appData;

describe('OneDriveService', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getSpaces() returns 3 spaces', async () => {
    const svc = new OneDriveService(tokenSupplier());
    const spaces = await svc.getSpaces();
    expect(spaces.map((s) => s.id)).toEqual(['personal', 'shared', 'approot']);
  });

  // --- getListing url building ---

  it('lists sharedWithMe when shared space has no parent', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ value: [] }));
    const svc = new OneDriveService(tokenSupplier());
    await svc.getListing(SHARED, null, '');
    expect(mockFetch.mock.calls[0][0]).toContain(`${GRAPH_API}/me/drive/sharedWithMe`);
  });

  it('lists children of a parent folder', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ value: [] }));
    const svc = new OneDriveService(tokenSupplier());
    await svc.getListing(MY_FILES, 'parent-1', '');
    expect(mockFetch.mock.calls[0][0]).toContain(`${GRAPH_API}/me/drive/items/parent-1/children`);
  });

  it('lists approot children for appData space root', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ value: [] }));
    const svc = new OneDriveService(tokenSupplier());
    await svc.getListing(APP_DATA, null, '');
    expect(mockFetch.mock.calls[0][0]).toContain(`${GRAPH_API}/me/drive/special/approot/children`);
  });

  it('lists root children for personal space root', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ value: [] }));
    const svc = new OneDriveService(tokenSupplier());
    await svc.getListing(MY_FILES, null, '');
    expect(mockFetch.mock.calls[0][0]).toContain(`${GRAPH_API}/me/drive/root/children`);
  });

  it('search within a parent folder', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ value: [] }));
    const svc = new OneDriveService(tokenSupplier());
    await svc.getListing(MY_FILES, 'parent-1', 'budget');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(`${GRAPH_API}/me/drive/items/parent-1/search(q='budget')`);
  });

  it('search at approot root', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ value: [] }));
    const svc = new OneDriveService(tokenSupplier());
    await svc.getListing(APP_DATA, null, 'budget');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(`${GRAPH_API}/me/drive/special/approot/search(q='budget')`);
  });

  it('search at personal root', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ value: [] }));
    const svc = new OneDriveService(tokenSupplier());
    await svc.getListing(MY_FILES, null, 'budget');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(`${GRAPH_API}/me/drive/root/search(q='budget')`);
  });

  it('maps returned items to CloudFile entries', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        value: [
          { id: 'f1', name: 'Folder', folder: { childCount: 2 } },
          {
            id: 'd1',
            name: 'doc.txt',
            file: { mimeType: 'text/plain' },
            lastModifiedDateTime: '2024-01-01T00:00:00Z',
            size: 42,
            createdBy: { user: { displayName: 'Alice' } },
          },
        ],
      }),
    );
    const svc = new OneDriveService(tokenSupplier());
    const files = await svc.getListing(MY_FILES, null, '');

    expect(files[0]).toEqual({
      id: 'f1',
      name: 'Folder',
      isFolder: true,
      mimeType: undefined,
      modifiedTime: undefined,
      size: undefined,
      owner: undefined,
    });
    expect(files[1]).toEqual({
      id: 'd1',
      name: 'doc.txt',
      isFolder: false,
      mimeType: 'text/plain',
      modifiedTime: '2024-01-01T00:00:00Z',
      size: 42,
      owner: 'Alice',
    });
  });

  it('treats a missing value array as empty', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const svc = new OneDriveService(tokenSupplier());
    const files = await svc.getListing(MY_FILES, null, '');
    expect(files).toEqual([]);
  });

  it('getListing throws StorageError on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'));
    const svc = new OneDriveService(tokenSupplier());
    await expect(svc.getListing(MY_FILES, null, '')).rejects.toThrow(StorageError);
  });

  // --- createFolder ---

  it('createFolder posts under a parent folder', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'new', name: 'Reports', folder: {} }));
    const svc = new OneDriveService(tokenSupplier());
    const file = await svc.createFolder(MY_FILES, 'Reports', 'parent-1');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GRAPH_API}/me/drive/items/parent-1/children`);
    expect(init.method).toBe('POST');
    expect(file).toMatchObject({ id: 'new', name: 'Reports', isFolder: true });
  });

  it('createFolder posts under approot when appData space and no parent', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'new', name: 'F', folder: {} }));
    const svc = new OneDriveService(tokenSupplier());
    await svc.createFolder(APP_DATA, 'F', null);
    expect(mockFetch.mock.calls[0][0]).toBe(`${GRAPH_API}/me/drive/special/approot/children`);
  });

  it('createFolder posts under root for personal space with no parent', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'new', name: 'F', folder: {} }));
    const svc = new OneDriveService(tokenSupplier());
    await svc.createFolder(MY_FILES, 'F', null);
    expect(mockFetch.mock.calls[0][0]).toBe(`${GRAPH_API}/me/drive/root/children`);
  });

  it('createFolder throws StorageError on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(409, 'Conflict'));
    const svc = new OneDriveService(tokenSupplier());
    await expect(svc.createFolder(MY_FILES, 'F', 'p')).rejects.toThrow(StorageError);
  });

  // --- requireToken ---

  it('throws auth-expired when token is null', async () => {
    const svc = new OneDriveService(tokenSupplier(null));
    await expect(svc.getListing(MY_FILES, null, '')).rejects.toThrow('No access token available');
  });

  it('throws auth-expired when token name is not microsoft', async () => {
    const svc = new OneDriveService(tokenSupplier({ name: 'google', token: 'x' }));
    await expect(svc.getListing(MY_FILES, null, '')).rejects.toThrow('Expected microsoft access token');
  });
});
