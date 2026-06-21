import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CredentialCache } from '@/app/credential-cache';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', new MemStorage());
});

describe('CredentialCache', () => {
  it('round-trips a credential for a tenant', () => {
    const cache = new CredentialCache('k', 'device-1');
    cache.write('t1', 'secret');
    expect(cache.read('t1')).toBe('secret');
  });

  it('returns undefined for a different tenant id', () => {
    const cache = new CredentialCache('k', 'device-1');
    cache.write('t1', 'secret');
    expect(cache.read('t2')).toBeUndefined();
  });

  it('is disabled when no key is configured', () => {
    const cache = new CredentialCache(undefined, 'device-1');
    cache.write('t1', 'secret');
    expect(cache.read('t1')).toBeUndefined();
    expect(sessionStorage.getItem('k')).toBeNull();
  });

  it('clear removes the cached credential', () => {
    const cache = new CredentialCache('k', 'device-1');
    cache.write('t1', 'secret');
    cache.clear();
    expect(cache.read('t1')).toBeUndefined();
  });

  it('clear is a no-op when no key is configured', () => {
    const cache = new CredentialCache(undefined, 'device-1');
    expect(() => cache.clear()).not.toThrow();
  });

  it('returns undefined on corrupt stored data', () => {
    const cache = new CredentialCache('k', 'device-1');
    sessionStorage.setItem('k', 'not-valid-base64-json!!!');
    expect(cache.read('t1')).toBeUndefined();
  });

  it('returns undefined when nothing is stored', () => {
    const cache = new CredentialCache('k', 'device-1');
    expect(cache.read('t1')).toBeUndefined();
  });

  it('a credential written under a different device key does not decode', () => {
    new CredentialCache('k', 'device-1').write('t1', 'secret');
    const other = new CredentialCache('k', 'device-2');
    expect(other.read('t1')).toBeUndefined();
  });
});
