import { Registry } from '../../core/registry';
import type { SkinDef } from './types';

/** Visual skins (VZ-42), keyed by `SkinDef.id`. Packages register theirs from `skins/index.ts`. */
export const skinRegistry = new Registry<SkinDef>({ kind: 'skin' });

export function getSkin(id: string): SkinDef | undefined {
  return skinRegistry.get(id);
}
