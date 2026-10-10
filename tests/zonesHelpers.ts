/**
 * Helpers for the zone tests (ZN): build zone bodies, drive bodies through them and collect the zone events.
 */
import type { Vec3 } from '../src/core/math';
import { makeComponent } from '../src/model/componentRegistry';
import { defaultSettings } from '../src/model/factory';
import type { BodyEntity, ComponentParams, SceneSettings } from '../src/model/types';
import { B, BODY_STRIDE, type ComponentEvent, type SimEvent } from '../src/physics/protocol';
import type { PhysicsWorld } from '../src/physics/world';
import { createBody, run, worldOf } from './helpers';

/** No gravity, no ground: bodies move in straight lines. */
export const SPACE: Partial<SceneSettings> = {
  gravity: [0, 0, 0],
  ground: { ...defaultSettings().ground, enabled: false },
};

export const NO_GROUND: Partial<SceneSettings> = { ground: { ...defaultSettings().ground, enabled: false } };

export interface ZoneOptions {
  name?: string;
  position?: Vec3;
  size?: Vec3;
  shape?: string;
  rotation?: [number, number, number, number];
  bodyType?: 'static' | 'kinematic';
  /** Extra components / parameters of the zone component. */
  params?: ComponentParams;
  extra?: Record<string, unknown>;
}

/** A ghost body with a zone component: the standard trigger volume. */
export function zoneBody(params: ComponentParams = {}, o: ZoneOptions = {}): BodyEntity {
  return createBody({
    name: o.name ?? 'Zone',
    shape: { type: o.shape ?? 'box', size: o.size ?? [4, 4, 4] },
    position: o.position ?? [0, 0, 0],
    ...(o.rotation ? { rotation: o.rotation } : {}),
    bodyType: o.bodyType ?? 'static',
    ghost: true,
    components: [makeComponent('zone', params)],
    ...(o.extra ?? {}),
  });
}

/** A small dynamic ball: radius 0.25 m, 1 kg, no damping, with an optional velocity. */
export function ball(position: Vec3, velocity: Vec3 = [0, 0, 0], extra: Record<string, unknown> = {}): BodyEntity {
  return createBody({
    name: 'Ball',
    shape: { type: 'sphere', size: [0.5, 0.5, 0.5] },
    position,
    velocity,
    linearDamping: 0,
    angularDamping: 0,
    material: { preset: 'custom', density: 1 / ((4 / 3) * Math.PI * 0.25 ** 3), friction: 0.5, restitution: 0 }, // 1 kg
    ...extra,
  });
}

export const isZoneEvent = (e: SimEvent): e is ComponentEvent => e.kind === 'component' && e.type === 'zone';

/** Every zone event raised so far (the queue is emptied). */
export function zoneEvents(w: PhysicsWorld, name?: string): ComponentEvent[] {
  return w
    .drainEvents()
    .filter(isZoneEvent)
    .filter((e) => !name || e.name === name);
}

/** Run for `seconds` and return the zone events raised meanwhile, in order. */
export function runCollect(w: PhysicsWorld, seconds: number): ComponentEvent[] {
  const out: ComponentEvent[] = [];
  const n = Math.round(seconds * w.settings.physicsHz);
  for (let i = 0; i < n; i++) {
    w.stepOnce();
    out.push(...w.drainEvents().filter(isZoneEvent));
  }
  return out;
}

export { createBody, run, worldOf };

/** Is the body switched off (killed, or held out of the world before a respawn)? A body that is gone is "off" too. */
export function isOff(w: PhysicsWorld, id: string): boolean {
  const i = w.bodyIds.indexOf(id);
  if (i < 0) return true;
  return w.readPoses(1)[i * BODY_STRIDE + B.state] === 2;
}

/** Position of a body (throws if it does not exist). */
export function at(w: PhysicsWorld, id: string): Vec3 {
  const p = w.getPose(id);
  if (!p) throw new Error(`no body ${id}`);
  return p.position;
}

/** Events of any component type ('zone' or 'bounds'), by name. */
export function eventsOf(w: PhysicsWorld, type: string, name?: string): ComponentEvent[] {
  return w
    .drainEvents()
    .filter((e): e is ComponentEvent => e.kind === 'component' && e.type === type && (!name || e.name === name));
}

/** Step until a zone event with this name is raised (returns it), or give up after `seconds`. */
export function runUntil(w: PhysicsWorld, name: string, seconds: number): ComponentEvent | null {
  const n = Math.round(seconds * w.settings.physicsHz);
  for (let i = 0; i < n; i++) {
    w.stepOnce();
    const hit = w.drainEvents().find((e): e is ComponentEvent => isZoneEvent(e) && e.name === name);
    if (hit) return hit;
  }
  return null;
}

/** The gauges `[inside, entered, fired]` a zone component last published. */
export function gauges(w: PhysicsWorld, body: BodyEntity): number[] {
  const id = body.components[0].id;
  const st = w.drainComponentState().changed[id];
  return st?.values ? [...st.values] : [];
}
