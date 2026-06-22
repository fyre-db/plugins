/**
 * A storage handle for a single string value.
 *
 * Consumers supply these (typically backed by `sessionStorage` / `localStorage`
 * via a small factory, optionally wrapped with a transform that obfuscates or
 * encrypts). **This package never touches browser storage itself** — it only
 * reads and writes through `StorageSlot`, so storage location and protection
 * are entirely the app's concern.
 */
export type StorageSlot = {
  get(): string | null;
  set(value: string): void;
  clear(): void;
};

