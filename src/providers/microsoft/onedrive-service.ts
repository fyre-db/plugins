import type { AccessToken } from '@/auth/types';
import { StorageError } from '@/errors/strata-error';
import { log } from '@/log';
import type {
  CloudFile,
  CloudFileService,
  CloudSpace,
} from '@/cloud/cloud-file-service';
import { OneDriveAdapter } from './onedrive-adapter';
import { mapOneDriveError } from './onedrive-errors';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
export const ONEDRIVE_SPACES = {
  myFiles: { id: 'personal', displayName: 'My Files' },
  shared: { id: 'shared', displayName: 'Shared' },
  appData: { id: 'approot', displayName: 'App data' },
} as const satisfies Record<string, CloudSpace>;

const ALL_SPACES: readonly CloudSpace[] = [
  ONEDRIVE_SPACES.myFiles,
  ONEDRIVE_SPACES.shared,
  ONEDRIVE_SPACES.appData,
];

const FILE_FIELDS = 'id,name,folder,file,lastModifiedDateTime,size,createdBy';

type DriveItemRaw = {
  readonly id: string;
  readonly name: string;
  readonly folder?: { readonly childCount: number };
  readonly file?: { readonly mimeType: string };
  readonly lastModifiedDateTime?: string;
  readonly size?: number;
  readonly createdBy?: {
    readonly user?: { readonly displayName: string };
  };
};

export class OneDriveService extends OneDriveAdapter implements CloudFileService {
  private readonly tokenSupplier: () => Promise<AccessToken | null>;

  constructor(getAccessToken: () => Promise<AccessToken | null>) {
    super(getAccessToken);
    this.tokenSupplier = getAccessToken;
  }

  getSpaces(_signal?: AbortSignal): Promise<readonly CloudSpace[]> {
    return Promise.resolve(ALL_SPACES);
  }

  async getListing(
    space: CloudSpace,
    parentId: string | null,
    search: string,
    signal?: AbortSignal,
  ): Promise<readonly CloudFile[]> {
    const token = await this.requireToken();

    let url: string;
    if (search.trim()) {
      const parentPath = parentId
        ? `${GRAPH_API}/me/drive/items/${parentId}`
        : space.id === 'approot'
          ? `${GRAPH_API}/me/drive/special/approot`
          : `${GRAPH_API}/me/drive/root`;
      url = `${parentPath}/search(q='${encodeURIComponent(search.trim())}')?select=${FILE_FIELDS}&top=200`;
    } else if (space.id === 'shared' && !parentId) {
      url = `${GRAPH_API}/me/drive/sharedWithMe?select=${FILE_FIELDS}&top=200`;
    } else if (parentId) {
      url = `${GRAPH_API}/me/drive/items/${parentId}/children?select=${FILE_FIELDS}&top=200&orderby=name`;
    } else if (space.id === 'approot') {
      url = `${GRAPH_API}/me/drive/special/approot/children?select=${FILE_FIELDS}&top=200&orderby=name`;
    } else {
      url = `${GRAPH_API}/me/drive/root/children?select=${FILE_FIELDS}&top=200&orderby=name`;
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) throw mapOneDriveError(res);

    const body = (await res.json()) as { readonly value?: readonly DriveItemRaw[] };
    const files = (body.value ?? []).map(toCloudFile);
    log.storage.onedrive('listing %s/%s → %d files', space.id, parentId ?? 'root', files.length);
    return files;
  }

  async createFolder(
    space: CloudSpace,
    name: string,
    parentId: string | null,
    signal?: AbortSignal,
  ): Promise<CloudFile> {
    const token = await this.requireToken();

    let url: string;
    if (parentId) {
      url = `${GRAPH_API}/me/drive/items/${parentId}/children`;
    } else if (space.id === 'approot') {
      url = `${GRAPH_API}/me/drive/special/approot/children`;
    } else {
      url = `${GRAPH_API}/me/drive/root/children`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }),
      signal,
    });
    if (!res.ok) throw mapOneDriveError(res);

    const raw = (await res.json()) as DriveItemRaw;
    log.storage.onedrive('created folder %s (id=%s)', name, raw.id);
    return toCloudFile(raw);
  }

  private async requireToken(): Promise<string> {
    const token = await this.tokenSupplier();
    if (!token) throw new StorageError('No access token available', { kind: 'auth-expired' });
    if (token.name !== 'microsoft') {
      throw new StorageError(`Expected microsoft access token, got ${token.name}`, { kind: 'auth-expired' });
    }
    return token.token;
  }
}

function toCloudFile(raw: DriveItemRaw): CloudFile {
  return {
    id: raw.id,
    name: raw.name,
    isFolder: raw.folder !== undefined,
    mimeType: raw.file?.mimeType,
    modifiedTime: raw.lastModifiedDateTime,
    size: raw.size,
    owner: raw.createdBy?.user?.displayName,
  };
}
