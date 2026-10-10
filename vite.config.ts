import { defineConfig } from 'vite';
// -- DT-B: Rapier wasm as a separate asset (scripts/vite/rapierWasm.ts) --
import { rapierWasm } from './scripts/vite/rapierWasm.ts';

// App / build configuration only. Test configuration lives in vitest.config.ts (which extends this file,
// so tests run through the same transform pipeline as the app).
export default defineConfig({
  base: './',
  plugins: process.env.VITEST ? [] : [rapierWasm()],
  worker: { format: 'es', plugins: () => [rapierWasm()] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: false },
  server: { host: true },
});
