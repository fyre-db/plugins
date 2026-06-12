import type { AccessToken } from '@/auth/types';
import { StorageError, FyreDbPluginConfigError } from '@/errors/fyredb-error';
import { log } from '@/log';
import type {
  CloudFile,
  CloudFileService,
  CloudSpace,
} from '@/cloud/cloud-file-service';
import { GoogleDriveAdapter } from './google-drive-adapter';
import { mapDriveError } from './google-drive-errors';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export const GOOGLE_DRIVE_SPACES = {
  myDrive: { id: 'drive', displayName: 'My Drive' },
  sharedWithMe: { id: 'sharedWithMe', displayName: 'Shared with me' },
  appData: { id: 'appDataFolder', displayName: 'App data' },
} as const satisfies Record<string, CloudSpace>;

const ALL_SPACES: readonly CloudSpace[] = [
  GOOGLE_DRIVE_SPACES.myDrive,
  GOOGLE_DRIVE_SPACES.sharedWithMe,
  GOOGLE_DRIVE_SPACES.appData,
];

const FILE_FIELDS =
  'files(id,name,mimeType,modifiedTime,size,owners(displayName,me))';

type DriveFileRaw = {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly modifiedTime?: string;
  readonly size?: string;
  readonly owners?: ReadonlyArray<{ readonly displayName: string; readonly me: boolean }>;
};

/**
 * `GoogleDriveAdapter` extended with browse + folder-creation methods.
 * One instance can be passed wherever a `StorageAdapter` or `CloudFileService`
 * is expected — the picked folder *is* the tenant root.
 */
export class GoogleDriveService extends GoogleDriveAdapter implements CloudFileService {
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

    const filters: string[] = ['trashed=false'];
    if (space.id === 'sharedWithMe' && !parentId) {
      filters.push('sharedWithMe=true');
    } else if (parentId) {
      filters.push(`'${escapeQ(parentId)}' in parents`);
    } else if (space.id === 'drive') {
      filters.push("'root' in parents");
    } else if (space.id === 'appDataFolder') {
      filters.push("'appDataFolder' in parents");
    }
    if (search.trim()) {
      filters.push(`name contains '${escapeQ(search.trim())}'`);
    }

    const params = new URLSearchParams({
      q: filters.join(' and '),
      fields: FILE_FIELDS,
      pageSize: '200',
      orderBy: 'folder,name',
    });
    if (space.id === 'appDataFolder') params.set('spaces', 'appDataFolder');

    const res = await fetch(`${DRIVE_API}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) throw mapDriveError(res);

    const body = (await res.json()) as { readonly files?: readonly DriveFileRaw[] };
    const files = (body.files ?? []).map(toCloudFile);
    log.storage.google('listing %s/%s → %d files', space.id, parentId ?? 'root', files.length);
    return files;
  }

  async createFolder(
    space: CloudSpace,
    name: string,
    parentId: string | null,
    signal?: AbortSignal,
  ): Promise<CloudFile> {
    const token = await this.requireToken();

    const parents = parentId
      ? [parentId]
      : space.id === 'appDataFolder'
        ? ['appDataFolder']
        : space.id === 'drive'
          ? ['root']
          : undefined;

    if (!parents) {
      throw new FyreDbPluginConfigError(`Cannot create folder in "${space.id}" without a parent folder`);
    }

    const res = await fetch(`${DRIVE_API}?fields=id,name,mimeType,modifiedTime,size`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents }),
      signal,
    });
    if (!res.ok) throw mapDriveError(res);

    const raw = (await res.json()) as DriveFileRaw;
    log.storage.google('created folder %s (id=%s)', name, raw.id);
    return toCloudFile(raw);
  }

  private async requireToken(): Promise<string> {
    const token = await this.tokenSupplier();
    if (!token) throw new StorageError('No access token available', { kind: 'auth-expired' });
    if (token.name !== 'google') {
      throw new StorageError(`Expected google access token, got ${token.name}`, { kind: 'auth-expired' });
    }
    return token.token;
  }
}

function toCloudFile(raw: DriveFileRaw): CloudFile {
  const me = raw.owners?.find((o) => o.me);
  return {
    id: raw.id,
    name: raw.name,
    isFolder: raw.mimeType === FOLDER_MIME,
    mimeType: raw.mimeType,
    modifiedTime: raw.modifiedTime,
    size: raw.size ? Number(raw.size) : undefined,
    owner: me ? 'me' : raw.owners?.[0]?.displayName,
  };
}

function escapeQ(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

