import { describe, it, expect } from 'vitest';
import { MemoryStorageAdapter } from '@fyre-db/core';
import { withGzip } from '@/transforms/index';

describe('withGzip', () => {
  it('round-trips data through write/read', async () => {
    const inner = new MemoryStorageAdapter();
    const adapter = withGzip(inner);
    const input = new TextEncoder().encode('Hello, FyreDb!');
    await adapter.write(undefined, 'test', input);
    const result = await adapter.read(undefined, 'test');
    expect(result).toEqual(input);
  });

  it('compressed data on inner adapter differs from input', async () => {
    const inner = new MemoryStorageAdapter();
    const adapter = withGzip(inner);
    const input = new TextEncoder().encode('Hello, FyreDb!');
    await adapter.write(undefined, 'test', input);
    const raw = await inner.read(undefined, 'test');
    expect(raw).not.toEqual(input);
  });

  it('compresses repetitive data smaller than input', async () => {
    const inner = new MemoryStorageAdapter();
    const adapter = withGzip(inner);
    const input = new TextEncoder().encode('A'.repeat(1000));
    await adapter.write(undefined, 'test', input);
    const raw = await inner.read(undefined, 'test');
    expect(raw!.length).toBeLessThan(input.length);
  });

  it('round-trips empty data', async () => {
    const inner = new MemoryStorageAdapter();
    const adapter = withGzip(inner);
    const input = new Uint8Array(0);
    await adapter.write(undefined, 'test', input);
    const result = await adapter.read(undefined, 'test');
    expect(result).toEqual(input);
  });

  it('round-trips large data', async () => {
    const inner = new MemoryStorageAdapter();
    const adapter = withGzip(inner);
    const input = new Uint8Array(10_000);
    for (let i = 0; i < input.length; i++) {
      input[i] = i % 256;
    }
    await adapter.write(undefined, 'test', input);
    const result = await adapter.read(undefined, 'test');
    expect(result).toEqual(input);
  });

  it.skip('produces valid gzip on inner adapter (starts with gzip magic bytes)', async () => {
    const inner = new MemoryStorageAdapter();
    const adapter = withGzip(inner);
    const input = new TextEncoder().encode('test');
    await adapter.write(undefined, 'test', input);
    const raw = await inner.read(undefined, 'test');
    expect(raw![0]).toBe(0x1f);
    expect(raw![1]).toBe(0x8b);
  });

  it('read returns null for missing key', async () => {
    const inner = new MemoryStorageAdapter();
    const adapter = withGzip(inner);
    const result = await adapter.read(undefined, 'missing');
    expect(result).toBeNull();
  });

  it('delete delegates to inner adapter', async () => {
    const inner = new MemoryStorageAdapter();
    const adapter = withGzip(inner);
    await adapter.write(undefined, 'test', new TextEncoder().encode('data'));
    const deleted = await adapter.delete(undefined, 'test');
    expect(deleted).toBe(true);
    const result = await adapter.read(undefined, 'test');
    expect(result).toBeNull();
  });
});
