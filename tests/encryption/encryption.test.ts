import { describe, it, expect } from 'vitest';
import { InvalidEncryptionKeyError } from '@fyre-db/core';
import { Pbkdf2EncryptionService, AesGcmEncryptionStrategy } from '@/encryption/index';

describe('Pbkdf2EncryptionService', () => {
  const appId = 'test-app';

  function createService() {
    return new Pbkdf2EncryptionService({ targets: ['local'], strategy: new AesGcmEncryptionStrategy() });
  }

  it('passthrough when no keys provided', async () => {
    const svc = createService();
    const data = new Uint8Array([1, 2, 3]);
    const encoded = await svc.encrypt('task.global', data, null);
    expect(encoded).toEqual(data);
    const decoded = await svc.decrypt('task.global', encoded, null);
    expect(decoded).toEqual(data);
  });

  it('always passes through __tenants key', async () => {
    const svc = createService();
    const keys = await svc.deriveKeys('password', appId);
    const data = new Uint8Array([1, 2, 3]);
    const encoded = await svc.encrypt('__tenants', data, keys);
    expect(encoded).toEqual(data);
    const decoded = await svc.decrypt('__tenants', data, keys);
    expect(decoded).toEqual(data);
  });

  it('throws when encrypting partition data with DEK not loaded', async () => {
    const svc = createService();
    const keys = await svc.deriveKeys('password', appId); // keys.dek is null
    const data = new Uint8Array([1, 2, 3]);
    await expect(svc.encrypt('task.global', data, keys)).rejects.toThrow('DEK not loaded');
  });

  it('throws when decrypting partition data with DEK not loaded', async () => {
    const svc = createService();
    const keys = await svc.deriveKeys('password', appId); // keys.dek is null
    const data = new Uint8Array([1, 2, 3]);
    await expect(svc.decrypt('task.global', data, keys)).rejects.toThrow('DEK not loaded');
  });

  it('encrypts/decrypts __fyredb with KEK even when DEK is null', async () => {
    const svc = createService();
    const keys = await svc.deriveKeys('password', appId);
    const data = new TextEncoder().encode('marker data');
    const encrypted = await svc.encrypt('__fyredb', data, keys);
    expect(encrypted).not.toEqual(data);
    // First 16 bytes are the salt prefix, then version byte at offset 16
    expect(encrypted.length).toBeGreaterThan(16);
    expect(encrypted[16]).toBe(1); // version byte after salt
    const decrypted = await svc.decrypt('__fyredb', encrypted, keys);
    expect(decrypted).toEqual(data);
  });

  it('wrong credential fails to decrypt __fyredb', async () => {
    const svc = createService();
    const keys1 = await svc.deriveKeys('correct', appId);
    const data = new TextEncoder().encode('secret');
    const encrypted = await svc.encrypt('__fyredb', data, keys1);

    const keys2 = await svc.deriveKeys('wrong', appId);
    await expect(svc.decrypt('__fyredb', encrypted, keys2))
      .rejects.toThrow(InvalidEncryptionKeyError);
  });

  it('encrypts/decrypts data blobs with DEK', async () => {
    const svc = createService();
    let keys = await svc.deriveKeys('password', appId);
    const result = await svc.generateKeyData(keys);
    keys = result.keys;
    const data = new TextEncoder().encode('entity data');
    const encrypted = await svc.encrypt('task.global', data, keys);
    expect(encrypted).not.toEqual(data);
    const decrypted = await svc.decrypt('task.global', encrypted, keys);
    expect(decrypted).toEqual(data);
  });

  it('generateKeyData produces loadable key data', async () => {
    const svc = createService();
    const keys = await svc.deriveKeys('password', appId);
    const result = await svc.generateKeyData(keys);
    expect(result.keyData).toBeDefined();
    expect(typeof result.keyData!.dek).toBe('string');
    expect((result.keyData!.dek as string).length).toBeGreaterThan(0);
  });

  it('loadKeyData restores DEK from key data', async () => {
    const svc = createService();
    const keys1 = await svc.deriveKeys('password', appId);
    const { keys: fullKeys1, keyData } = await svc.generateKeyData(keys1);

    const data = new TextEncoder().encode('test data');
    const encrypted = await svc.encrypt('task.global', data, fullKeys1);

    // Load same key data on fresh keys
    const keys2 = await svc.deriveKeys('password', appId);
    const fullKeys2 = await svc.loadKeyData(keys2, keyData!);
    const decrypted = await svc.decrypt('task.global', encrypted, fullKeys2);
    expect(decrypted).toEqual(data);
  });

  it('loadKeyData throws when dek is not a base64 string', async () => {
    const svc = createService();
    const keys = await svc.deriveKeys('password', appId);
    await expect(svc.loadKeyData(keys, { dek: 123 })).rejects.toThrow(
      'Invalid key data: expected dek to be a base64 string',
    );
  });

  it('rekey re-wraps DEK under new credential', async () => {
    const svc = createService();
    let keys = await svc.deriveKeys('old-password', appId);
    const { keys: fullKeys } = await svc.generateKeyData(keys);

    const data = new TextEncoder().encode('important data');
    const encrypted = await svc.encrypt('task.global', data, fullKeys);

    // Rekey with new password
    const { keys: rekeyedKeys } = await svc.rekey(fullKeys, 'new-password', appId);

    // Data still decryptable (same DEK)
    const decrypted = await svc.decrypt('task.global', encrypted, rekeyedKeys);
    expect(decrypted).toEqual(data);
  });

  it('rekey throws if DEK is not loaded', async () => {
    const svc = createService();
    const keys = await svc.deriveKeys('password', appId);
    // Keys without DEK (no generateKeyData/loadKeyData)
    await expect(svc.rekey(keys, 'new-password', appId)).rejects.toThrow('No DEK loaded');
  });

  it('deriveKeys reuses salt from rawMarkerBytes', async () => {
    const svc = createService();
    // First derive to get a salt via __fyredb round-trip
    const keys1 = await svc.deriveKeys('password', appId);
    const data = new TextEncoder().encode('marker');
    const encrypted = await svc.encrypt('__fyredb', data, keys1);
    // encrypted starts with 16-byte salt; pass it as rawMarkerBytes
    const keys2 = await svc.deriveKeys('password', appId, encrypted);
    const decrypted = await svc.decrypt('__fyredb', encrypted, keys2);
    expect(decrypted).toEqual(data);
  });

  it('throws on invalid encryption keys object', async () => {
    const svc = createService();
    const badKeys = { notKek: 'wrong' } as any;
    const data = new Uint8Array([1, 2, 3]);
    await expect(svc.encrypt('task.global', data, badKeys)).rejects.toThrow('Invalid encryption keys');
    await expect(svc.decrypt('task.global', data, badKeys)).rejects.toThrow('Invalid encryption keys');
  });
});
