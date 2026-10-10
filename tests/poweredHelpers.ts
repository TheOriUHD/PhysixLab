/**
 * Fixtures for the powered-part tests: bodies and joints with exactly known mass and inertia, so the results can be
 * compared with analytic ones (T = I·α, F = m·a, rocket equation …).
 */
import { vlen, type Vec3 } from '../src/core/math';
import { makeComponent } from '../src/model/componentRegistry';
import { defaultSettings } from '../src/model/factory';
import type { BodyEntity, ComponentSpec, JointEntity } from '../src/model/types';
import type { BodyInit } from '../src/model/factory';
import type { PhysicsWorld } from '../src/physics/world';
import { createBody, createJoint } from './helpers';

export const NO_G = { gravity: [0, 0, 0] as Vec3, ground: { ...defaultSettings().ground, enabled: false } };
export const DT = 1 / 120;

/** A unit cube of density `d` (mass d kg, inertia d/6 kg·m² about any axis through its centre), no damping. */
export const cube = (density: number, over: Omit<BodyInit, 'shape'> = {}): BodyEntity =>
  createBody({
    shape: { type: 'box', size: [1, 1, 1] },
    material: { preset: 'custom', density },
    linearDamping: 0,
    angularDamping: 0,
    ...over,
  });

/** A small static anchor body. */
export const anchor = (position: Vec3 = [0, 0, 0]): BodyEntity =>
  createBody({ shape: { type: 'box', size: [0.1, 0.1, 0.1] }, position, bodyType: 'static' });

export const withComponents = <T extends BodyEntity | JointEntity>(e: T, ...components: ComponentSpec[]): T => ({
  ...e,
  components,
});

/** A hinge about +z at the origin between two bodies (or the world). */
export const hinge = (a: BodyEntity | null, b: BodyEntity | null, over: Partial<JointEntity> = {}): JointEntity =>
  createJoint({
    type: 'hinge',
    bodyA: a?.id ?? null,
    bodyB: b?.id ?? null,
    anchorA: [0, 0, 0],
    axis: [0, 0, 1],
    ...over,
  });

export const comp = makeComponent;

/** Speed of a hinge as the world measures it (rad/s). */
export function hingeSpeed(w: PhysicsWorld, j: JointEntity): number {
  return w.getJointRec(j.id)?.speed ?? NaN;
}

export const speedOf = (w: PhysicsWorld, id: string): number => vlen(w.getPose(id)!.linvel);

const published = new Map<string, number[]>();

/** The latest numbers a component published (the world only reports changes, so earlier values are remembered). */
export function stateOf(w: PhysicsWorld, componentId: string): number[] {
  const { changed } = w.drainComponentState();
  for (const [id, e] of Object.entries(changed)) if (e.values) published.set(id, [...e.values]);
  return published.get(componentId) ?? [];
}
