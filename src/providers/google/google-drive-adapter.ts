import type { StorageAdapter, Tenant } from '@fyre-db/core'
import { compositeKey, fnvHash, generateId } from '@fyre-db/core'
import type { AccessToken } from '@/auth/types'
import { StorageError, StrataPluginConfigError } from '@/errors/strata-error'
import { mapDriveError } from './google-drive-errors'
import { log } from '@/log'

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files'

type DriveSpace = 'appDataFolder' | 'drive' | 'sharedWithMe'

type DriveMeta = {
  space: DriveSpace
  folderId?: string
}

function getDriveMeta(tenant: Tenant | undefined): DriveMeta {
  if (!tenant) return { space: 'appDataFolder' }
  const meta = tenant.meta as { space?: string; folderId?: string }
  const space = meta.space as DriveSpace | undefined
  if (!space) throw new StrataPluginConfigError(`Tenant "${tenant.id}" missing required meta.space`)
  if (space === 'drive' && !meta.folderId) {
    throw new StrataPluginConfigError(`Tenant "${tenant.id}" with space "drive" requires meta.folderId`)
  }
  if (space === 'sharedWithMe' && !meta.folderId) {
    throw new StrataPluginConfigError(`Tenant "${tenant.id}" with space "sharedWithMe" requires meta.folderId`)
  }
  return { space, folderId: meta.folderId }
}

export class GoogleDriveAdapter implements StorageAdapter {
  private readonly getToken: () => Promise<AccessToken | null>
  private readonly fileIdCache = new Map<string, string>()

  constructor(getAccessToken: () => Promise<AccessToken | null>) {
    this.getToken = getAccessToken
  }

  private async getAccessToken(): Promise<string> {
    const token = await this.getToken()
    if (!token) throw new StorageError('No access token available', { kind: 'auth-expired' })
    if (token.name !== 'google') {
      throw new StorageError(`Expected google access token, got ${token.name}`, { kind: 'auth-expired' })
    }
    return token.token
  }

  deriveTenantId(meta: Record<string, unknown>): string {
    const folderId = meta.folderId as string | undefined
    if (!folderId) return generateId()
    return fnvHash(folderId)
  }

  async read(tenant: Tenant | undefined, key: string): Promise<Uint8Array | null> {
    const fileId = await this.resolveFileId(tenant, key)
    if (!fileId) return null

    const token = await this.getAccessToken()
    const response = await fetch(`${DRIVE_API}/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (response.status === 404) {
      this.fileIdCache.delete(compositeKey(tenant, key))
      return null
    }
    if (!response.ok) throw mapDriveError(response)

    log.storage.google('read %s (%d bytes)', key, (await response.clone().arrayBuffer()).byteLength)
    return new Uint8Array(await response.arrayBuffer())
  }

  async write(tenant: Tenant | undefined, key: string, data: Uint8Array): Promise<void> {
    const fileId = await this.resolveFileId(tenant, key)
    const token = await this.getAccessToken()

    if (fileId) {
      const response = await fetch(`${UPLOAD_API}/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: data as BodyInit,
      })
      if (!response.ok) throw mapDriveError(response)
      log.storage.google('updated %s', key)
    } else {
      const { space, folderId } = getDriveMeta(tenant)
      const metadata: Record<string, unknown> = { name: compositeKey(tenant, key) }
      if (space === 'appDataFolder') {
        metadata.parents = ['appDataFolder']
      } else if (folderId) {
        metadata.parents = [folderId]
      }

      const boundary = `-----strata-${crypto.randomUUID()}`
      const body = [
        `--${boundary}\r\n`,
        'Content-Type: application/json; charset=UTF-8\r\n\r\n',
        JSON.stringify(metadata),
        `\r\n--${boundary}\r\n`,
        'Content-Type: application/octet-stream\r\n\r\n',
      ].join('')

      const prefix = new TextEncoder().encode(body)
      const suffix = new TextEncoder().encode(`\r\n--${boundary}--`)
      const multipart = new Uint8Array(prefix.length + data.length + suffix.length)
      multipart.set(prefix, 0)
      multipart.set(data, prefix.length)
      multipart.set(suffix, prefix.length + data.length)

      const response = await fetch(`${UPLOAD_API}?uploadType=multipart`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipart,
      })
      if (!response.ok) throw mapDriveError(response)

      const result = (await response.json()) as { id: string }
      this.fileIdCache.set(compositeKey(tenant, key), result.id)
      log.storage.google('created %s (fileId=%s)', key, result.id)
    }
  }

  async delete(tenant: Tenant | undefined, key: string): Promise<boolean> {
    const fileId = await this.resolveFileId(tenant, key)
    if (!fileId) return false

    const token = await this.getAccessToken()
    const response = await fetch(`${DRIVE_API}/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    if (response.status === 404) {
      this.fileIdCache.delete(compositeKey(tenant, key))
      return false
    }
    if (!response.ok) throw mapDriveError(response)
    this.fileIdCache.delete(compositeKey(tenant, key))
    log.storage.google('deleted %s', key)
    return true
  }

  private async resolveFileId(tenant: Tenant | undefined, key: string): Promise<string | null> {
    const cacheKey = compositeKey(tenant, key)
    const cached = this.fileIdCache.get(cacheKey)
    if (cached) {
      log.storage.google('resolve cache hit %s → %s', cacheKey, cached)
      return cached
    }

    const { space, folderId } = getDriveMeta(tenant)
    const fileName = cacheKey
    const token = await this.getAccessToken()

    const safeName = fileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    let q = `name='${safeName}' and trashed=false`
    if (space === 'appDataFolder') {
      q += ` and 'appDataFolder' in parents`
    } else if (folderId) {
      const safeFolderId = folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      q += ` and '${safeFolderId}' in parents`
    }

    const params = new URLSearchParams({
      q,
      fields: 'files(id)',
      pageSize: '1',
    })
    if (space === 'appDataFolder') {
      params.set('spaces', 'appDataFolder')
    }

    const response = await fetch(`${DRIVE_API}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw mapDriveError(response)

    const result = (await response.json()) as { files: { id: string }[] }
    const fileId = result.files[0]?.id ?? null

    if (fileId) this.fileIdCache.set(cacheKey, fileId)
    return fileId
  }
}
