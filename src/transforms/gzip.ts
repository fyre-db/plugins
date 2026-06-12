import type { StorageAdapter, Tenant } from '@fyre-db/core';
import { toArrayBuffer, streamToUint8Array } from '@fyre-db/core';

const GZIP_MARKER = new Uint8Array([0x00, 0x47, 0x5A]); // \0GZ

function hasGzipMarker(data: Uint8Array): boolean {
  return data.length >= GZIP_MARKER.length &&
    data[0] === GZIP_MARKER[0] &&
    data[1] === GZIP_MARKER[1] &&
    data[2] === GZIP_MARKER[2];
}

export function withGzip(adapter: StorageAdapter): StorageAdapter {
  return {
    ...adapter,
    async read(tenant: Tenant | undefined, key: string): Promise<Uint8Array | null> {
      const data = await adapter.read(tenant, key);
      if (!data) return null;
      if (!hasGzipMarker(data)) return data; // legacy uncompressed data
      const compressed = data.slice(GZIP_MARKER.length);
      const stream = new Blob([toArrayBuffer(compressed)])
        .stream()
        .pipeThrough(new DecompressionStream('gzip'));
      return streamToUint8Array(stream);
    },
    async write(tenant: Tenant | undefined, key: string, data: Uint8Array): Promise<void> {
      const stream = new Blob([toArrayBuffer(data)])
        .stream()
        .pipeThrough(new CompressionStream('gzip'));
      const compressed = await streamToUint8Array(stream);
      const marked = new Uint8Array(GZIP_MARKER.length + compressed.length);
      marked.set(GZIP_MARKER);
      marked.set(compressed, GZIP_MARKER.length);
      return adapter.write(tenant, key, marked);
    },
    delete: (t, k) => adapter.delete(t, k),
  };
}
