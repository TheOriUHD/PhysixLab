/**
 * Registers the example scenes (`../templates.ts`) and prefabs (`../prefabs.ts`) that ship with the app.
 * They go through exactly the same `registerTemplate` / `registerPrefab` calls a package would use.
 */
import { BUILTIN_PREFABS } from '../prefabs';
import { BUILTIN_TEMPLATES } from '../templates';
import { registerPrefab, registerTemplate } from './registry';

for (const t of BUILTIN_TEMPLATES) registerTemplate(t);
for (const p of BUILTIN_PREFABS) registerPrefab(p);
