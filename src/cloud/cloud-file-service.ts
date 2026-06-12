import type { StorageAdapter } from '@fyre-db/core';

/** Top-level logical partition within a cloud (e.g. "My Drive"). */
export type CloudSpace = {
  readonly id: string;
  readonly displayName: string;
};

/** File or folder within a `CloudSpace`. */
export type CloudFile = {
  readonly id: string;
  readonly name: string;
  readonly isFolder: boolean;
  /** Raw provider MIME type, if meaningful. */
  readonly mimeType?: string;
  /** ISO timestamp of last modification, if exposed. */
  readonly modifiedTime?: string;
  /** Display name of the file's owner. Use `"me"` for the current user. */
  readonly owner?: string;
  /** Size in bytes when known. Folders typically omit this. */
  readonly size?: number;
};

/**
 * Browse-side contract used by `<CloudFileExplorer>`. Extends `StorageAdapter`
 * because the picked folder *is* the tenant root — a single instance can
 * satisfy both surfaces.
 */
export interface CloudFileService extends StorageAdapter {
  getSpaces(signal?: AbortSignal): Promise<readonly CloudSpace[]>;
  getListing(
    space: CloudSpace,
    parentId: string | null,
    search: string,
    signal?: AbortSignal,
  ): Promise<readonly CloudFile[]>;
  createFolder(
    space: CloudSpace,
    name: string,
    parentId: string | null,
    signal?: AbortSignal,
  ): Promise<CloudFile>;
}

/** Per-instance gating predicates passed to `<CloudFileExplorer>`. */
export type CloudFileExplorerValidator = {
  readonly isSpaceVisible: (space: CloudSpace) => boolean;
  readonly isSpaceEnabled: (space: CloudSpace) => boolean;
  readonly isFileVisible: (file: CloudFile) => boolean;
  readonly isFileEnabled: (file: CloudFile) => boolean;
  readonly folderCreationEnabled: (
    space: CloudSpace,
    parentFolder: CloudFile | null,
  ) => boolean;
};