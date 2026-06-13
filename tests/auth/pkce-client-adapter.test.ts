import { describe, it, expect } from 'vitest';
import { PkceClientAdapter } from '@/auth/pkce-client-adapter';

function newAdapter(name = 'pkce-test') {
  return new PkceClientAdapter({ name });
}

describe('PkceClientAdapter', () => {
  it('exposes name from config', () => {
    const adapter = newAdapter('my-pkce');
    expect(adapter.name).toBe('my-pkce');
  });

  it('login() rejects with "not implemented" error', async () => {
    await expect(newAdapter().login()).rejects.toThrow(
      'PkceClientAdapter is not implemented yet.',
    );
  });

  it('logout() rejects with "not implemented" error', async () => {
    await expect(newAdapter().logout()).rejects.toThrow(
      'PkceClientAdapter is not implemented yet.',
    );
  });

  it('refresh() resolves with null', async () => {
    const result = await newAdapter().refresh();
    expect(result).toBeNull();
  });
});
