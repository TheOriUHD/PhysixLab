import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Vitest configuration. Merged on top of vite.config.ts so any plugin / alias / define added there for the
// app (e.g. glob-based registries) also applies to the unit and physics tests. The physics tests run the
// real Rapier engine in Node, so the environment is `node` and a single test may take a while.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
      testTimeout: 60000,
    },
  }),
);
