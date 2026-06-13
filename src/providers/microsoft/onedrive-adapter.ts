import type { StorageAdapter, Tenant } from '@fyre-db/core'
import { compositeKey, fnvHash, generateId } from '@fyre-db/core'
import type { AccessToken } from '@/auth/types'
import { StorageError, FyreDbPluginConfigError } from '@/errors/fyredb-error'
import { mapOneDriveError } from './onedrive-errors'
import { log } from '@/log'

const GRAPH_API = 'https://graph.microsoft.com/v1.0'

type DriveSpace = 'approot' | 'personal'

type DriveMeta = {
  space: DriveSpace
  folderId?: string
}

function getDriveMeta(tenant: Tenant | undefined): DriveMeta {
  if (!tenant) return { space: 'approot' }
  const meta = tenant.meta as { space?: string; folderId?: string }
  const space = meta.space as DriveSpace | undefined
  if (!space) throw new FyreDbPluginConfigError(`Tenant "${tenant.id}" missing required meta.space`)
  if (space === 'personal' && !meta.folderId) {
    throw new FyreDbPluginConfigError(`Tenant "${tenant.id}" with space "personal" requires meta.folderId`)
  }
  return { space, folderId: meta.folderId }
}

/** OneDrive forbids `:` in file names; replace with `_._` which is safe and reversible. */
function sanitizeFileName(name: string): string {
  return name.replace(/:/g, '_._')
}

function buildItemPath(meta: DriveMeta, fileName: string): string {
  const safe = encodeURIComponent(sanitizeFileName(fileName))
  if (meta.space === 'approot') {
    return `${GRAPH_API}/me/drive/special/approot:/${safe}`
  }
  if (meta.folderId) {
    return `${GRAPH_API}/me/drive/items/${encodeURIComponent(meta.folderId)}:/${safe}`
  }
  return `${GRAPH_API}/me/drive/root:/${safe}`
}

export class OneDriveAdapter implements StorageAdapter {
  private readonly getToken: () => Promise<AccessToken | null>
  private readonly fileIdCache = new Map<string, string>()

  constructor(getAccessToken: () => Promise<AccessToken | null>) {
    this.getToken = getAccessToken
  }

  private async getAccessToken(): Promise<string> {
    const token = await this.getToken()
    if (!token) throw new StorageError('No access token available', { kind: 'auth-expired' })
    if (token.name !== 'microsoft') {
      throw new StorageError(`Expected microsoft access token, got ${token.name}`, { kind: 'auth-expired' })
    }
    return token.token
  }

  deriveTenantId(meta: Record<string, unknown>): string {
    const folderId = meta.folderId as string | undefined
    if (!folderId) return generateId()
    return fnvHash(folderId)
  }

  async read(tenant: Tenant | undefined, key: string): Promise<Uint8Array | null> {
    const meta = getDriveMeta(tenant)
    const fileName = compositeKey(tenant, key)
    const token = await this.getAccessToken()

    const itemPath = buildItemPath(meta, fileName)
    const response = await fetch(`${itemPath}:/content`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (response.status === 404) return null
    if (!response.ok) throw mapOneDriveError(response)

    log.storage.onedrive('read %s (%d bytes)', key, (await response.clone().arrayBuffer()).byteLength)
    return new Uint8Array(await response.arrayBuffer())
  }

  async write(tenant: Tenant | undefined, key: string, data: Uint8Array): Promise<void> {
    const meta = getDriveMeta(tenant)
    const fileName = compositeKey(tenant, key)
    const token = await this.getAccessToken()

    const itemPath = buildItemPath(meta, fileName)
    const response = await fetch(`${itemPath}:/content`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: data as BodyInit,
    })
    if (!response.ok) throw mapOneDriveError(response)
    log.storage.onedrive('wrote %s', key)
  }

  async delete(tenant: Tenant | undefined, key: string): Promise<boolean> {
    const meta = getDriveMeta(tenant)
    const fileName = compositeKey(tenant, key)
    const token = await this.getAccessToken()

    // Resolve file ID first via search
    const fileId = await this.resolveFileId(meta, fileName, token)
    if (!fileId) return false

    const response = await fetch(`${GRAPH_API}/me/drive/items/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    if (response.status === 404) return false
    if (!response.ok) throw mapOneDriveError(response)
    this.fileIdCache.delete(fileName)
    log.storage.onedrive('deleted %s', key)
    return true
  }

  private async resolveFileId(meta: DriveMeta, fileName: string, token: string): Promise<string | null> {
    const cached = this.fileIdCache.get(fileName)
    if (cached) return cached

    const itemPath = buildItemPath(meta, fileName)
    const response = await fetch(itemPath, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (response.status === 404) return null
    if (!response.ok) throw mapOneDriveError(response)

    const result = (await response.json()) as { id: string }
    this.fileIdCache.set(fileName, result.id)
    return result.id
  }
}
