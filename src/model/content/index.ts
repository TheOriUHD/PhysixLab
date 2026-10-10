/**
 * The content library: example scenes (templates), prefabs and maps.
 *
 * This is the module to import (`from '../model/content'`). It re-exports the registry API and — as a side
 * effect — collects every other file in this folder, so **adding content means adding a file here** that calls
 * `registerTemplate()` / `registerPrefab()` / `registerMap()`; no list needs editing. Files are loaded in
 * alphabetical order, which is the order the content appears in the library tabs (within one file: the order of
 * its registrations).
 *
 * Collected with Vite's `import.meta.glob` (eager), which Vitest understands too, so unit tests see exactly the
 * content the app ships.
 */
export * from './registry';

// `registry.ts` is the API above and this file is the collector; everything else is content.
import.meta.glob(['./*.ts', '!./index.ts', '!./registry.ts'], { eager: true });
