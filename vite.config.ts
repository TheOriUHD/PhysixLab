import { defineConfig } from 'vite';

// App / build configuration only. Test configuration lives in vitest.config.ts (which extends this file,
// so tests run through the same transform pipeline as the app).
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: false },
  server: { host: true },
});
