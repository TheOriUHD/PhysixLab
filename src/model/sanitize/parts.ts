/** Sanitiser for the colliders of a compound body (`BodyEntity.parts`). */
import { clamp } from '../../core/math';
import { warn, type LoadReport } from '../errors';
import { LIMITS } from '../limits';
import { sanitizeShapeSpec } from '../shapeRegistry';
import type { ColliderPart, PartMaterial } from '../types';
import { bool, hexColor, idStr, num, obj, position3, quat } from './primitives';

function sanitizeMaterial(raw: unknown): PartMaterial | undefined {
  const r = obj(raw);
  const m: PartMaterial = {};
  if ('density' in r) m.density = clamp(num(r.density, 1000), 0, 1e6);
  if ('friction' in r) m.friction = Math.max(0, num(r.friction, 0.5));
  if ('restitution' in r) m.restitution = clamp(num(r.restitution, 0.2), 0, 1.5);
  // an unusable colour is dropped, so the part simply inherits the body's
  const color = hexColor(r.color, '');
  if (color) m.color = color;
  if ('metalness' in r) m.metalness = clamp(num(r.metalness, 0), 0, 1);
  if ('roughness' in r) m.roughness = clamp(num(r.roughness, 0.5), 0, 1);
  if ('opacity' in r) m.opacity = clamp(num(r.opacity, 1), 0.05, 1);
  return Object.keys(m).length ? m : undefined;
}

/** Valid parts (at most `maxPartsPerBody`, unique ids), or undefined when there are none. */
export function sanitizeParts(raw: unknown, report: LoadReport | undefined, owner: string): ColliderPart[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const list = raw as unknown[];
  if (list.length > LIMITS.maxPartsPerBody) {
    warn(report, `${owner} has ${list.length} collider parts; only the first ${LIMITS.maxPartsPerBody} were kept.`);
  }
  const out: ColliderPart[] = [];
  const ids = new Set<string>();
  for (const item of list.slice(0, LIMITS.maxPartsPerBody)) {
    const r = obj(item);
    let id = idStr(r.id, `p${out.length}`);
    for (let n = 2; ids.has(id); n++) id = `${idStr(r.id, `p${out.length}`)}~${n}`;
    ids.add(id);
    const part: ColliderPart = {
      id,
      shape: sanitizeShapeSpec(r.shape, report, `a collider part of ${owner}`),
      position: position3(r.position, [0, 0, 0]),
      rotation: quat(r.rotation),
    };
    const material = sanitizeMaterial(r.material);
    if (material) part.material = material;
    if (bool(r.sensor, false)) part.sensor = true;
    if (r.visible === false) part.visible = false;
    out.push(part);
  }
  return out;
}
