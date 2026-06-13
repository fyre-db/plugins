import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@/': path.resolve(__dirname, 'src') + '/',
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      include: ['src/**/*.ts'],
      // CI gate: fail the run if coverage drops below 97% on any metric.
      thresholds: {
        statements: 97,
        branches: 97,
        functions: 97,
        lines: 97,
      },
    },
  },
});
