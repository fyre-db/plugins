import { FyreDbPluginConfigError } from '@/errors/fyredb-error';

export type OneDriveSpace = 'approot' | 'personal' | 'shared';

export type OneDriveTenantMeta = {
  readonly space: OneDriveSpace;
  readonly folderId?: string;
};

export function validateOneDriveMeta(
  meta: Record<string, unknown>,
): OneDriveTenantMeta {
  const space = meta.space as string | undefined;
  if (!space) {
    throw new FyreDbPluginConfigError('meta.space is required');
  }
  if (space !== 'approot' && space !== 'personal' && space !== 'shared') {
    throw new FyreDbPluginConfigError(`Invalid meta.space: "${space}". Must be "approot", "personal", or "shared"`);
  }
  if ((space === 'personal' || space === 'shared') && !meta.folderId) {
    throw new FyreDbPluginConfigError(`meta.folderId is required when space is "${space}"`);
  }
  return { space, folderId: meta.folderId as string | undefined };
}
