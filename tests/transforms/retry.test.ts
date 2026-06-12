import { describe, it, expect, vi } from 'vitest';
import { MemoryStorageAdapter } from '@fyre-db/core';
import { withRetry } from '@/transforms/retry';

describe('withRetry', () => {
  it('passes through successful read', async () => {
    const inner = new MemoryStorageAdapter();
    await inner.write(undefined, 'k', new Uint8Array([1, 2]));
    const adapter = withRetry(inner);
    const result = await adapter.read(undefined, 'k');
    expect(result).toEqual(new Uint8Array([1, 2]));
  });

  it('passes through successful write', async () => {
    const inner = new MemoryStorageAdapter();
    const adapter = withRetry(inner);
    await adapter.write(undefined, 'k', new Uint8Array([3]));
    const result = await inner.read(undefined, 'k');
    expect(result).toEqual(new Uint8Array([3]));
  });

  it('passes through successful delete', async () => {
    const inner = new MemoryStorageAdapter();
    await inner.write(undefined, 'k', new Uint8Array([1]));
    const adapter = withRetry(inner);
    const result = await adapter.delete(undefined, 'k');
    expect(result).toBe(true);
  });

  it('retries on failure and succeeds', async () => {
    let attempts = 0;
    const inner: any = {
      read: async () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return new Uint8Array([42]);
      },
    };
    const adapter = withRetry(inner, { maxRetries: 3, delayMs: 1 });
    const result = await adapter.read(undefined, 'k');
    expect(result).toEqual(new Uint8Array([42]));
    expect(attempts).toBe(3);
  });

  it('calls onRetry callback on failure', async () => {
    let attempts = 0;
    const retries: number[] = [];
    const inner: any = {
      write: async () => {
        attempts++;
        if (attempts < 2) throw new Error('fail');
      },
    };
    const adapter = withRetry(inner, {
      maxRetries: 3,
      delayMs: 1,
      onRetry: (attempt) => retries.push(attempt),
    });
    await adapter.write(undefined, 'k', new Uint8Array([1]));
    expect(retries).toEqual([1]);
  });

  it('throws after exhausting retries', async () => {
    const inner: any = {
      read: async () => { throw new Error('persistent failure'); },
    };
    const adapter = withRetry(inner, { maxRetries: 2, delayMs: 1 });
    await expect(adapter.read(undefined, 'k')).rejects.toThrow('persistent failure');
  });

  it('wraps non-Error throws', async () => {
    const inner: any = {
      read: async () => { throw 'string error'; },
    };
    const adapter = withRetry(inner, { maxRetries: 0, delayMs: 1 });
    await expect(adapter.read(undefined, 'k')).rejects.toThrow('string error');
  });

  it('uses default options when none provided', async () => {
    let attempts = 0;
    const inner: any = {
      read: async () => {
        attempts++;
        if (attempts < 2) throw new Error('fail');
        return null;
      },
    };
    // Using default delayMs is 1000ms — override just delay for speed
    const adapter = withRetry(inner, { delayMs: 1 });
    const result = await adapter.read(undefined, 'k');
    expect(result).toBeNull();
  });
});
