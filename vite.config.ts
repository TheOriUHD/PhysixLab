import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: false },
  server: { host: true },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 60000 },
} as any);
