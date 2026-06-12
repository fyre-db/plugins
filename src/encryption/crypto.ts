import { toArrayBuffer, toBase64, fromBase64 } from '@fyre-db/core';
import { EncryptionError } from './errors';

// ─── Constants ───────────────────────────────────────────

const PBKDF2_ITERATIONS = 600_000;
const IV_LENGTH = 12;
const ENCRYPTION_VERSION = 1;

const textEncoder = new TextEncoder();

// ─── Key derivation ─────────────────────────────────────

export async function pbkdf2DeriveKey(
  password: string,
  salt: string,
): Promise<CryptoKey> {
  const saltBytes = textEncoder.encode(salt);
  return pbkdf2DeriveKeyWithSalt(password, saltBytes);
}

export async function pbkdf2DeriveKeyWithSalt(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    toArrayBuffer(textEncoder.encode(password)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ─── AES-GCM key management ─────────────────────────────

export async function aesGcmGenerateKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function exportCryptoKey(key: CryptoKey): Promise<string> {
  const raw = await globalThis.crypto.subtle.exportKey('raw', key);
  return toBase64(new Uint8Array(raw));
}

export async function importAesGcmKey(base64: string): Promise<CryptoKey> {
  const raw = fromBase64(base64);
  return globalThis.crypto.subtle.importKey(
    'raw',
    toArrayBuffer(raw),
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

// ─── AES-256-GCM encrypt / decrypt ─────────────────────

export async function aesGcmEncrypt(
  data: Uint8Array,
  key: CryptoKey,
): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(data),
  );
  const result = new Uint8Array(1 + IV_LENGTH + ciphertext.byteLength);
  result[0] = ENCRYPTION_VERSION;
  result.set(iv, 1);
  result.set(new Uint8Array(ciphertext), 1 + IV_LENGTH);
  return result;
}

export async function aesGcmDecrypt(
  data: Uint8Array,
  key: CryptoKey,
): Promise<Uint8Array> {
  const GCM_TAG_LENGTH = 16;
  const minLength = 1 + IV_LENGTH + GCM_TAG_LENGTH; // version + IV + GCM auth tag
  if (data.length < minLength) {
    throw new EncryptionError(`Encrypted data too short (${data.length} bytes, minimum ${minLength})`, { kind: 'data-corrupted' });
  }
  const version = data[0];
  if (version !== ENCRYPTION_VERSION) {
    throw new EncryptionError(`Unsupported encryption version: ${version}`, { kind: 'data-corrupted' });
  }
  const iv = data.slice(1, 1 + IV_LENGTH);
  const ciphertext = data.slice(1 + IV_LENGTH);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext),
  );
  return new Uint8Array(plaintext);
}
