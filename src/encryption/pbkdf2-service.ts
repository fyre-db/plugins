import type { EncryptionStrategy, EncryptionService, EncryptionKeys } from '@fyre-db/core';
import {
  pbkdf2DeriveKeyWithSalt, aesGcmGenerateKey, exportCryptoKey, importAesGcmKey,
} from './crypto';
import { EncryptionError } from './errors';
import { log } from '@/log';

const SALT_LENGTH = 16;

type Pbkdf2Keys = {
  readonly kek: CryptoKey;
  readonly dek: CryptoKey | null;
  readonly salt: Uint8Array;
};

export class Pbkdf2EncryptionService implements EncryptionService {
  readonly targets: ReadonlyArray<'local' | 'cloud'>;
  private readonly strategy: EncryptionStrategy<CryptoKey>;
  private readonly tenantKey: string;
  private readonly markerKey: string;

  constructor(options: {
    readonly targets: ReadonlyArray<'local' | 'cloud'>;
    readonly strategy: EncryptionStrategy<CryptoKey>;
    readonly tenantKey?: string;
    readonly markerKey?: string;
  }) {
    this.targets = options.targets;
    this.strategy = options.strategy;
    this.tenantKey = options.tenantKey ?? '__tenants';
    this.markerKey = options.markerKey ?? '__fyredb';
  }

  private castKeys(keys: EncryptionKeys): Pbkdf2Keys | null {
    if (keys === null) return null;
    if (typeof keys !== 'object' || !('kek' in (keys as Record<string, unknown>))) {
      throw new EncryptionError('Invalid encryption keys: expected Pbkdf2Keys with kek property', { kind: 'invalid-key-data' });
    }
    return keys as Pbkdf2Keys;
  }

  async encrypt(blobKey: string, data: Uint8Array, keys: EncryptionKeys): Promise<Uint8Array> {
    if (blobKey === this.tenantKey) return data;
    const k = this.castKeys(keys);
    if (!k) return data;
    if (blobKey === this.markerKey) {
      const ciphertext = await this.strategy.encrypt(data, k.kek);
      const result = new Uint8Array(SALT_LENGTH + ciphertext.length);
      result.set(k.salt, 0);
      result.set(ciphertext, SALT_LENGTH);
      return result;
    }
    if (!k.dek) throw new EncryptionError('DEK not loaded — cannot encrypt partition data', { kind: 'dek-not-loaded' });
    return this.strategy.encrypt(data, k.dek);
  }

  async decrypt(blobKey: string, data: Uint8Array, keys: EncryptionKeys): Promise<Uint8Array> {
    if (blobKey === this.tenantKey) return data;
    const k = this.castKeys(keys);
    if (!k) return data;
    if (blobKey === this.markerKey) {
      const ciphertext = data.slice(SALT_LENGTH);
      return this.strategy.decrypt(ciphertext, k.kek);
    }
    if (!k.dek) throw new EncryptionError('DEK not loaded — cannot decrypt partition data', { kind: 'dek-not-loaded' });
    return this.strategy.decrypt(data, k.dek);
  }

  async deriveKeys(credential: string, appId: string, rawMarkerBytes?: Uint8Array | null): Promise<EncryptionKeys> {
    const textEncoder = new TextEncoder();
    let salt: Uint8Array;
    if (rawMarkerBytes && rawMarkerBytes.length >= SALT_LENGTH) {
      salt = rawMarkerBytes.slice(0, SALT_LENGTH);
    } else {
      salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    }
    const appIdBytes = textEncoder.encode(appId);
    const fullSalt = new Uint8Array(salt.length + appIdBytes.length);
    fullSalt.set(salt, 0);
    fullSalt.set(appIdBytes, salt.length);
    const kek = await pbkdf2DeriveKeyWithSalt(credential, fullSalt);
    log.crypto('KEK derived for app %s', appId);
    return { kek, dek: null, salt } satisfies Pbkdf2Keys;
  }

  async generateKeyData(keys: EncryptionKeys): Promise<{ keys: EncryptionKeys; keyData: Record<string, unknown> }> {
    const k = keys as Pbkdf2Keys;
    const dek = await aesGcmGenerateKey();
    const dekBase64 = await exportCryptoKey(dek);
    return {
      keys: { kek: k.kek, dek, salt: k.salt } satisfies Pbkdf2Keys,
      keyData: { dek: dekBase64 },
    };
  }

  async loadKeyData(keys: EncryptionKeys, data: Record<string, unknown>): Promise<EncryptionKeys> {
    const k = keys as Pbkdf2Keys;
    if (typeof data.dek !== 'string') {
      throw new EncryptionError('Invalid key data: expected dek to be a base64 string', { kind: 'invalid-key-data' });
    }
    const dek = await importAesGcmKey(data.dek);
    return { kek: k.kek, dek, salt: k.salt } satisfies Pbkdf2Keys;
  }

  async rekey(keys: EncryptionKeys, credential: string, appId: string): Promise<{ keys: EncryptionKeys; keyData: Record<string, unknown> }> {
    const k = keys as Pbkdf2Keys;
    if (!k.dek) throw new EncryptionError('No DEK loaded — cannot rekey', { kind: 'dek-not-loaded' });
    const textEncoder = new TextEncoder();
    const newSalt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const appIdBytes = textEncoder.encode(appId);
    const fullSalt = new Uint8Array(newSalt.length + appIdBytes.length);
    fullSalt.set(newSalt, 0);
    fullSalt.set(appIdBytes, newSalt.length);
    const newKek = await pbkdf2DeriveKeyWithSalt(credential, fullSalt);
    const dekBase64 = await exportCryptoKey(k.dek);
    return {
      keys: { kek: newKek, dek: k.dek, salt: newSalt } satisfies Pbkdf2Keys,
      keyData: { dek: dekBase64 },
    };
  }
}
