/** Pure helpers behind the soft-body inspector sections of package SF (kept free of the DOM so they are unit-tested). */
import type { Vec3 } from '../../core/math';
import { listShapes, makeShapeSpec } from '../../model/shapeRegistry';
import { stiffnessForYoungModulus } from '../../model/softMaterial';
import { softSurfacePoints } from '../../model/softMesh';
import type { SoftEntity } from '../../model/types';

/** Stiffness range the inspector offers (Hz). */
export const STIFFNESS_RANGE = { min: 3, max: 400 } as const;

export interface MeshShapeOption {
  id: string;
  label: string;
  icon: string;
}

let cache: MeshShapeOption[] | null = null;
let cacheCount = -1;

/** Registered shapes that give a closed surface a volumetric jelly can be built from (cached per registry size). */
export function meshShapeOptions(): MeshShapeOption[] {
  const all = listShapes();
  if (cache && cacheCount === all.length) return cache;
  cacheCount = all.length;
  cache = all
    .filter((d) => {
      try {
        const pts = softSurfacePoints(makeShapeSpec(d.id));
        return !!pts && pts.length >= 4;
      } catch {
        return false;
      }
    })
    .map((d) => ({ id: d.id, label: d.label, icon: d.icon }));
  return cache;
}

/** Pascals as kPa for the editable field. */
export const pascalToKPa = (pa: number): number => pa / 1000;

/** Stiffness (Hz, clamped to the slider range, 0.1 Hz resolution) that gives `kPa` kilopascals for this body. */
export function stiffnessForKPa(def: SoftEntity, kPa: number): number {
  const hz = stiffnessForYoungModulus(def, kPa * 1000);
  const clamped = Math.min(STIFFNESS_RANGE.max, Math.max(STIFFNESS_RANGE.min, hz));
  return Math.round(clamped * 10) / 10;
}

/** Weight (N) a fastened body hangs on its fastening: m·g for dynamic bodies, null for fixed / kinematic ones. */
export function loadCarried(mass: number, dynamic: boolean, gravity: number): number | null {
  return dynamic && mass > 0 ? mass * gravity : null;
}

export interface PressureHint {
  ok: boolean;
  text: string;
}

/** Working-pressure advice for a tyre, consistent with the "tyre-soft" stability warning. */
export function workingPressureHint(def: Pick<SoftEntity, 'pneumatic' | 'volumeFactor' | 'stiffness'>): PressureHint {
  if (!def.pneumatic)
    return {
      ok: true,
      text: 'Airless tyre: a solid lattice that carries load by stiffness alone — pressure has no effect.',
    };
  if (def.volumeFactor < 1.15)
    return {
      ok: false,
      text: 'Under-inflated: a vehicle needs a pressure of about ×1.15 – ×1.6 to keep the sidewalls up.',
    };
  if (def.volumeFactor > 1.6)
    return { ok: false, text: 'Over-inflated: above ×1.6 the shell is stretched hard and rides rigidly.' };
  if (def.stiffness < 100)
    return {
      ok: false,
      text: 'Pressure is right, but the rubber is too soft to hold it: raise the stiffness to 100 Hz or more.',
    };
  return { ok: true, text: 'Working pressure: carries a vehicle (×1.15 – ×1.6, stiffness 100 Hz or more).' };
}

/** Particle count caption with a heaviness note. */
export function particleCaption(count: number): string {
  return `≈ ${count} particles${count > 3000 ? ' — far too heavy' : count > 1200 ? ' — heavy' : ''}`;
}

/** Resize one axis of a tyre, clamped to the sizes the generator supports. */
export function tyreSize(size: Vec3, axis: 0 | 1 | 2, v: number): Vec3 {
  const min = [0.2, 0.08, 0.06][axis];
  const next: Vec3 = [...size] as Vec3;
  next[axis] = Math.max(min, v);
  return next;
}

/** Signature of a warning list: the UI rebuilds only when it changes. */
export function warningSignature(ws: readonly { id: string; message: string }[]): string {
  return ws.map((w) => `${w.id}:${w.message}`).join('|');
}
