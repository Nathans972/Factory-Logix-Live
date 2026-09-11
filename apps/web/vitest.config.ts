import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@fld/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@fld/engine': fileURLToPath(new URL('../../packages/engine/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
