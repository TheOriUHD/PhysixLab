/**
 * Sanitisers for the entity kinds added in format v3 — groups, lights and paths — and for the `parent` link they
 * share with bodies and soft bodies. Like every sanitiser they read untrusted JSON through the coercion helpers and
 * never throw.
 */
import { clamp } from '../../core/math';
import { createGroup, createLight, createPath, defaultPathPoints, lightDefaults, LIGHT_TYPES } from '../factory';
import { LIMITS } from '../limits';
import type { GroupEntity, LightEntity, LightType, PathEntity } from '../types';
import { outlinerMetaFields } from './outlinerMeta'; // -- UI-A --
import { bool, hexColor, idStr, isFiniteVec, nameStr, num, obj, oneOf, position3, quat } from './primitives';

/** `parent` of a raw entity: a non-empty id, validated later once every entity id is known. */
export function parentField(raw: Record<string, unknown>): { parent?: string } {
  return typeof raw.parent === 'string' && raw.parent ? { parent: idStr(raw.parent, '') } : {};
}

export function sanitizeGroup(input: unknown): GroupEntity {
  const raw = obj(input);
  const base = createGroup();
  return {
    ...base,
    id: idStr(raw.id, base.id),
    name: nameStr(raw.name, base.name),
    position: position3(raw.position, base.position),
    rotation: quat(raw.rotation),
    locked: bool(raw.locked, false),
    hidden: bool(raw.hidden, false),
    ...parentField(raw),
    ...outlinerMetaFields(raw, true), // -- UI-A --
  };
}

export function sanitizeLight(input: unknown): LightEntity {
  const raw = obj(input);
  const type: LightType = oneOf(raw.lightType, LIGHT_TYPES, 'point');
  const base = createLight(type);
  const d = lightDefaults(type);
  const size = isFiniteVec(raw.size, 2) ? raw.size : d.size;
  return {
    ...base,
    id: idStr(raw.id, base.id),
    name: nameStr(raw.name, base.name),
    position: position3(raw.position, base.position),
    rotation: isFiniteVec(raw.rotation, 4) ? quat(raw.rotation) : base.rotation,
    color: hexColor(raw.color, d.color),
    intensity: clamp(num(raw.intensity, d.intensity), 0, 1e6),
    range: clamp(num(raw.range, d.range), 0, 1e5),
    angle: clamp(num(raw.angle, d.angle), 0.01, Math.PI / 2),
    penumbra: clamp(num(raw.penumbra, d.penumbra), 0, 1),
    size: [clamp(size[0], 0.01, 1000), clamp(size[1], 0.01, 1000)],
    castShadow: bool(raw.castShadow, d.castShadow),
    enabled: bool(raw.enabled, true),
    locked: bool(raw.locked, false),
    hidden: bool(raw.hidden, false),
    ...parentField(raw),
    ...outlinerMetaFields(raw, true), // -- UI-A --
  };
}

export function sanitizePath(input: unknown): PathEntity {
  const raw = obj(input);
  const base = createPath();
  const listed = Array.isArray(raw.points) ? (raw.points as unknown[]).slice(0, LIMITS.maxPathPoints) : [];
  const points = listed.filter((p) => isFiniteVec(p, 3)).map((p) => position3(p, [0, 0, 0]));
  const usable = points.length >= 2 ? points : defaultPathPoints();
  return {
    ...base,
    id: idStr(raw.id, base.id),
    name: nameStr(raw.name, base.name),
    position: position3(raw.position, base.position),
    rotation: quat(raw.rotation),
    points: usable,
    // A loop needs three corners to enclose anything.
    closed: bool(raw.closed, false) && usable.length >= 3,
    tension: clamp(num(raw.tension, 0), 0, 1),
    color: hexColor(raw.color, base.color),
    locked: bool(raw.locked, false),
    hidden: bool(raw.hidden, false),
    ...parentField(raw),
    ...outlinerMetaFields(raw, true), // -- UI-A --
  };
}
