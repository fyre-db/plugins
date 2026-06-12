import { describe, it, expect } from 'vitest';
import {
  pbkdf2DeriveKey,
  aesGcmGenerateKey,
  exportCryptoKey,
  importAesGcmKey,
  aesGcmEncrypt,
  aesGcmDecrypt,
} from '@/encryption/crypto';
import { InvalidEncryptionKeyError } from '@fyre-db/core';

describe('Encryption primitives', () => {
  const appId = 'test-app';

  describe('deriveKey', () => {
    it('produces a CryptoKey from password+appId', async () => {
      const key = await pbkdf2DeriveKey('password', appId);
      expect(key).toBeDefined();
      expect(key.algorithm).toMatchObject({ name: 'AES-GCM' });
    });

    it('same inputs produce same key', async () => {
      const key1 = await pbkdf2DeriveKey('password', appId);
      const key2 = await pbkdf2DeriveKey('password', appId);
      const data = new TextEncoder().encode('test');
      const encrypted = await aesGcmEncrypt(data, key1);
      const decrypted = await aesGcmDecrypt(encrypted, key2);
      expect(decrypted).toEqual(data);
    });

    it('different passwords produce different keys', async () => {
      const key1 = await pbkdf2DeriveKey('password1', appId);
      const key2 = await pbkdf2DeriveKey('password2', appId);
      const data = new TextEncoder().encode('test');
      const encrypted = await aesGcmEncrypt(data, key1);
      await expect(aesGcmDecrypt(encrypted, key2)).rejects.toThrow();
    });

    it('different appIds produce different keys', async () => {
      const key1 = await pbkdf2DeriveKey('password', 'app-1');
      const key2 = await pbkdf2DeriveKey('password', 'app-2');
      const data = new TextEncoder().encode('test');
      const encrypted = await aesGcmEncrypt(data, key1);
      await expect(aesGcmDecrypt(encrypted, key2)).rejects.toThrow();
    });
  });

  describe('generateDek', () => {
    it('produces extractable AES-256-GCM key', async () => {
      const dek = await aesGcmGenerateKey();
      expect(dek.extractable).toBe(true);
      expect(dek.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    });

    it('generates unique keys', async () => {
      const dek1 = await aesGcmGenerateKey();
      const dek2 = await aesGcmGenerateKey();
      const raw1 = await globalThis.crypto.subtle.exportKey('raw', dek1);
      const raw2 = await globalThis.crypto.subtle.exportKey('raw', dek2);
      expect(new Uint8Array(raw1)).not.toEqual(new Uint8Array(raw2));
    });
  });

  describe('exportDek / importDek', () => {
    it('round-trips DEK through base64', async () => {
      const dek = await aesGcmGenerateKey();
      const b64 = await exportCryptoKey(dek);
      const imported = await importAesGcmKey(b64);

      const original = await globalThis.crypto.subtle.exportKey('raw', dek);
      const recovered = await globalThis.crypto.subtle.exportKey('raw', imported);
      expect(new Uint8Array(recovered)).toEqual(new Uint8Array(original));
    });

    it('exported DEK is a base64 string', async () => {
      const dek = await aesGcmGenerateKey();
      const b64 = await exportCryptoKey(dek);
      expect(typeof b64).toBe('string');
      expect(b64.length).toBeGreaterThan(0);
    });

    it('importDek throws on invalid base64', async () => {
      await expect(importAesGcmKey('!!!not-base64!!!')).rejects.toThrow('Invalid base64');
    });
  });

  describe('encrypt / decrypt', () => {
    it('round-trip', async () => {
      const dek = await aesGcmGenerateKey();
      const plaintext = new TextEncoder().encode('Hello, World!');
      const ciphertext = await aesGcmEncrypt(plaintext, dek);
      const result = await aesGcmDecrypt(ciphertext, dek);
      expect(result).toEqual(plaintext);
    });

    it('ciphertext starts with version byte', async () => {
      const dek = await aesGcmGenerateKey();
      const plaintext = new Uint8Array([1, 2, 3]);
      const ciphertext = await aesGcmEncrypt(plaintext, dek);
      expect(ciphertext[0]).toBe(1); // version 1
    });
  });
});
