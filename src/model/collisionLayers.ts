/**
 * JT-30: the scene's 16 named collision layers and their interaction matrix.
 *
 * A body belongs to one layer (`collision.group`) and lists the layers it accepts (`collision.mask`). On top of that the
 * scene has a matrix: `matrix[a]` is the set of layers that layer `a` may collide with. Two bodies collide only if both
 * their own masks and the matrix allow it (the effective filter is `mask & matrix[group]`). A *trigger* layer turns its
 * bodies into sensors: they pass through everything but still report overlap events.
 */
import { ALL_GROUPS } from './factory';
import type { CollisionSpec } from './types';

export const LAYER_COUNT = 16;

export interface CollisionLayers {
  /** Display name of each of the 16 layers. */
  names: string[];
  /** `matrix[a]` bit `b` set = layers a and b may collide. Kept symmetric by the editor. */
  matrix: number[];
  /** Bit `g` set = bodies on layer g are triggers (sensors). */
  trigger: number;
}

export const DEFAULT_LAYER_NAMES: readonly string[] = [
  'Default',
  ...Array.from({ length: LAYER_COUNT - 1 }, (_, i) => `Layer ${i + 1}`),
];

export function defaultLayers(): CollisionLayers {
  return { names: [...DEFAULT_LAYER_NAMES], matrix: new Array<number>(LAYER_COUNT).fill(ALL_GROUPS), trigger: 0 };
}

/** True when the layers are exactly the defaults (nothing is stored then). */
export function isDefaultLayers(l: CollisionLayers): boolean {
  return (
    l.trigger === 0 && l.matrix.every((m) => m === ALL_GROUPS) && l.names.every((n, i) => n === DEFAULT_LAYER_NAMES[i])
  );
}

/** Sanitise a raw `settings.layers` into a spread-able fragment (nothing for the defaults / garbage). */
export function layersField(raw: unknown): { layers?: CollisionLayers } {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out = defaultLayers();
  if (Array.isArray(r.names)) {
    for (let i = 0; i < LAYER_COUNT; i++) {
      const n = (r.names as unknown[])[i];
      if (typeof n === 'string' && n.trim()) out.names[i] = n.trim().slice(0, 32);
    }
  }
  if (Array.isArray(r.matrix)) {
    for (let i = 0; i < LAYER_COUNT; i++) {
      const m = (r.matrix as unknown[])[i];
      if (typeof m === 'number' && Number.isFinite(m)) out.matrix[i] = Math.round(m) & ALL_GROUPS;
    }
    // symmetric: a pair collides only if both directions say so
    for (let a = 0; a < LAYER_COUNT; a++)
      for (let b = a + 1; b < LAYER_COUNT; b++)
        if (!((out.matrix[a] >> b) & 1) || !((out.matrix[b] >> a) & 1)) {
          out.matrix[a] &= ~(1 << b);
          out.matrix[b] &= ~(1 << a);
        }
  }
  if (typeof r.trigger === 'number' && Number.isFinite(r.trigger)) out.trigger = Math.round(r.trigger) & ALL_GROUPS;
  return isDefaultLayers(out) ? {} : { layers: out };
}

export function layerNames(l: CollisionLayers | undefined): readonly string[] {
  return l?.names ?? DEFAULT_LAYER_NAMES;
}

/** Do layers a and b collide according to the matrix? */
export function layersCollide(l: CollisionLayers | undefined, a: number, b: number): boolean {
  return !l || ((l.matrix[a] >> b) & 1) === 1;
}

/** The filter bits a body on `c.group` really uses: its own mask limited by the scene matrix. */
export function effectiveMask(c: CollisionSpec, l: CollisionLayers | undefined): number {
  return c.mask & ALL_GROUPS & (l ? l.matrix[c.group] : ALL_GROUPS) & ALL_GROUPS;
}

export function isTriggerLayer(l: CollisionLayers | undefined, group: number): boolean {
  return !!l && ((l.trigger >> group) & 1) === 1;
}

/** A matrix with `a ↔ b` switched on or off (both directions). */
export function setLayerPair(l: CollisionLayers, a: number, b: number, on: boolean): CollisionLayers {
  const matrix = [...l.matrix];
  if (on) {
    matrix[a] |= 1 << b;
    matrix[b] |= 1 << a;
  } else {
    matrix[a] &= ~(1 << b);
    matrix[b] &= ~(1 << a);
  }
  return { ...l, matrix };
}
