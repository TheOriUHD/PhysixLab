/**
 * UI-A: copy / paste and presets of body properties — pure (no DOM, no storage).
 *
 * A *snapshot* holds some property groups of a body ("Material", "Damping & mass" …). It can be pasted onto other
 * bodies (all groups or a chosen subset) and saved as a named preset. Snapshots that come from storage are untrusted:
 * `sanitizeSnapshot` whitelists the keys and clamps every number, so a hand-edited preset can never put a NaN, an
 * absurd value or a stray key into the document.
 */
import type { Vec3 } from '../../../core/math';
import type { BodyEntity, MaterialSpec, ThrustSpec } from '../../../model/types';

export type GroupId = 'material' | 'appearance' | 'damping' | 'locks' | 'motion' | 'thruster';

export interface GroupInfo {
  id: GroupId;
  label: string;
  hint: string;
}

export const PROP_GROUPS: readonly GroupInfo[] = [
  { id: 'material', label: 'Material', hint: 'Preset, density, friction, bounciness' },
  { id: 'appearance', label: 'Appearance', hint: 'Colour, metalness, roughness, opacity' },
  { id: 'damping', label: 'Damping & mass', hint: 'Damping, gravity scale, air drag, mass override, inertia scale' },
  { id: 'locks', label: 'Locks & options', hint: 'Axis locks, continuous collision, sleeping, ghost' },
  { id: 'motion', label: 'Initial motion', hint: 'Velocity and spin' },
  { id: 'thruster', label: 'Thruster', hint: 'Force / torque / trigger' },
];

export const ALL_GROUPS: readonly GroupId[] = PROP_GROUPS.map((g) => g.id);

export type Snapshot = Partial<Record<GroupId, Record<string, unknown>>>;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Read the groups of a body into a snapshot (deep copies). */
export function captureProps(b: BodyEntity, groups: readonly GroupId[] = ALL_GROUPS): Snapshot {
  const s: Snapshot = {};
  for (const g of groups) {
    switch (g) {
      case 'material':
        s.material = {
          preset: b.material.preset,
          density: b.material.density,
          friction: b.material.friction,
          restitution: b.material.restitution,
        };
        break;
      case 'appearance':
        s.appearance = {
          color: b.material.color,
          metalness: b.material.metalness,
          roughness: b.material.roughness,
          opacity: b.material.opacity,
        };
        break;
      case 'damping':
        s.damping = clone({
          linearDamping: b.linearDamping,
          angularDamping: b.angularDamping,
          gravityScale: b.gravityScale,
          drag: b.drag,
          massOverride: b.massOverride ?? null,
          inertiaScale: b.inertiaScale,
        });
        break;
      case 'locks':
        s.locks = clone({
          lockPosition: b.lockPosition,
          lockRotation: b.lockRotation,
          ccd: b.ccd,
          canSleep: b.canSleep,
          ghost: b.ghost,
        });
        break;
      case 'motion':
        s.motion = clone({ velocity: b.velocity, angularVelocity: b.angularVelocity });
        break;
      case 'thruster':
        s.thruster = clone({ thrust: b.thrust });
        break;
    }
  }
  return s;
}

/** The patch that applies the chosen groups of a snapshot to a body. Unknown / malformed parts are skipped. */
export function snapshotPatch(
  snap: Snapshot,
  b: BodyEntity,
  groups: readonly GroupId[] = ALL_GROUPS,
): Partial<BodyEntity> {
  const patch: Partial<BodyEntity> & Record<string, unknown> = {};
  let material: MaterialSpec | null = null;
  let massSet = false;
  let mass: number | undefined;
  const mat = (): MaterialSpec => (material ??= { ...b.material });
  for (const g of groups) {
    const d = snap[g];
    if (!d) continue;
    switch (g) {
      case 'material':
        Object.assign(mat(), d);
        break;
      case 'appearance':
        Object.assign(mat(), d);
        break;
      case 'damping': {
        const { massOverride, ...rest } = d;
        Object.assign(patch, rest);
        massSet = true;
        mass = typeof massOverride === 'number' ? massOverride : undefined;
        break;
      }
      case 'locks':
      case 'motion':
      case 'thruster':
        Object.assign(patch, d);
        break;
    }
  }
  if (material) patch.material = material;
  const out = clone(patch);
  // JSON drops `undefined`, but "no mass override" is a real value to paste
  if (massSet) out.massOverride = mass;
  return out;
}

// ---- sanitising (stored presets are untrusted) -------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown, lo: number, hi: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
}

function vec(v: unknown, lim: number): Vec3 | undefined {
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  const o = v.map((x) => num(x, -lim, lim));
  return o.every((x) => x !== undefined) ? (o as Vec3) : undefined;
}

function bools(v: unknown): [boolean, boolean, boolean] | undefined {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'boolean')
    ? ([v[0], v[1], v[2]] as [boolean, boolean, boolean])
    : undefined;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Keep only the well-formed, clamped parts of a snapshot-shaped value. */
export function sanitizeSnapshot(raw: unknown): Snapshot {
  const out: Snapshot = {};
  if (!isObj(raw)) return out;
  const put = (id: GroupId, d: Record<string, unknown>) => {
    if (Object.keys(d).length) out[id] = d;
  };
  const set = (d: Record<string, unknown>, k: string, v: unknown) => {
    if (v !== undefined) d[k] = v;
  };
  if (isObj(raw.material)) {
    const r = raw.material;
    const d: Record<string, unknown> = {};
    if (typeof r.preset === 'string' && r.preset.length > 0 && r.preset.length <= 48) d.preset = r.preset;
    set(d, 'density', num(r.density, 1, 1e6));
    set(d, 'friction', num(r.friction, 0, 10));
    set(d, 'restitution', num(r.restitution, 0, 1.5));
    put('material', d);
  }
  if (isObj(raw.appearance)) {
    const r = raw.appearance;
    const d: Record<string, unknown> = {};
    if (typeof r.color === 'string' && HEX.test(r.color)) d.color = r.color;
    set(d, 'metalness', num(r.metalness, 0, 1));
    set(d, 'roughness', num(r.roughness, 0, 1));
    set(d, 'opacity', num(r.opacity, 0.05, 1));
    put('appearance', d);
  }
  if (isObj(raw.damping)) {
    const r = raw.damping;
    const d: Record<string, unknown> = {};
    set(d, 'linearDamping', num(r.linearDamping, 0, 1000));
    set(d, 'angularDamping', num(r.angularDamping, 0, 1000));
    set(d, 'gravityScale', num(r.gravityScale, -100, 100));
    set(d, 'inertiaScale', num(r.inertiaScale, 1e-3, 1e3));
    if (isObj(r.drag)) {
      const l = num(r.drag.linear2, 0, 1e6);
      const a = num(r.drag.angular2, 0, 1e6);
      if (l !== undefined && a !== undefined) d.drag = { linear2: l, angular2: a };
    }
    if (r.massOverride === null) d.massOverride = null;
    else set(d, 'massOverride', num(r.massOverride, 1e-6, 1e9));
    put('damping', d);
  }
  if (isObj(raw.locks)) {
    const r = raw.locks;
    const d: Record<string, unknown> = {};
    set(d, 'lockPosition', bools(r.lockPosition));
    set(d, 'lockRotation', bools(r.lockRotation));
    for (const k of ['ccd', 'canSleep', 'ghost']) if (typeof r[k] === 'boolean') d[k] = r[k];
    put('locks', d);
  }
  if (isObj(raw.motion)) {
    const r = raw.motion;
    const d: Record<string, unknown> = {};
    set(d, 'velocity', vec(r.velocity, 1e4));
    set(d, 'angularVelocity', vec(r.angularVelocity, 1e4));
    put('motion', d);
  }
  if (isObj(raw.thruster) && 'thrust' in raw.thruster) {
    const t = raw.thruster.thrust;
    if (t === null) out.thruster = { thrust: null };
    else if (isObj(t)) {
      const force = vec(t.force, 1e7);
      const torque = vec(t.torque, 1e7);
      if (force && torque && (t.mode === 'always' || t.mode === 'key')) {
        const thrust: ThrustSpec = {
          force,
          torque,
          mode: t.mode,
          key: typeof t.key === 'string' ? t.key.slice(0, 32) : '',
        };
        out.thruster = { thrust };
      }
    }
  }
  return out;
}

/** Which groups does a snapshot actually contain? */
export const groupsOf = (s: Snapshot): GroupId[] => ALL_GROUPS.filter((g) => !!s[g]);
