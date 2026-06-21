import { log } from '@/log';

function xorEncode(text: string, key: string): string {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    out.push(String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length)));
  }
  return btoa(out.join(''));
}

function xorDecode(encoded: string, key: string): string {
  const text = atob(encoded);
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    out.push(String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length)));
  }
  return out.join('');
}

/**
 * Caches an encrypted tenant's unlock credential in `sessionStorage` so a page
 * refresh does not re-prompt. XOR-obfuscated with the device id — this is not
 * real encryption (a JS string cannot be zeroed), only light obfuscation
 * scoped to the tab session. Disabled when no `key` is configured.
 */
export class CredentialCache {
  constructor(
    private readonly key: string | undefined,
    private readonly deviceId: string,
  ) {}

  read(tenantId: string): string | undefined {
    if (!this.key) return undefined;
    try {
      const raw = sessionStorage.getItem(this.key);
      if (!raw) return undefined;
      const decoded = JSON.parse(xorDecode(raw, this.deviceId)) as {
        tenantId?: string;
        credential?: string;
      };
      if (decoded.tenantId === tenantId && typeof decoded.credential === 'string') {
        return decoded.credential;
      }
    } catch {
      /* best-effort */
    }
    return undefined;
  }

  write(tenantId: string, credential: string): void {
    if (!this.key) return;
    try {
      sessionStorage.setItem(this.key, xorEncode(JSON.stringify({ tenantId, credential }), this.deviceId));
    } catch {
      log.app.warn('credential cache write failed');
    }
  }

  clear(): void {
    if (!this.key) return;
    try {
      sessionStorage.removeItem(this.key);
    } catch {
      /* best-effort */
    }
  }
}
