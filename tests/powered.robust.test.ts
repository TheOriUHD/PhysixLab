/** The powered parts under abuse: opposing commands, live edits, removals, misuse, and what the registries promise. */
import { describe, expect, it } from 'vitest';
import { componentDef, defaultParams, makeComponent, sanitizeParams } from '../src/model/componentRegistry';
import { POWERED_COMPONENTS } from '../src/model/components/poweredIndex';
import { listTemplates } from '../src/model/content';
import { sanitizeDocument } from '../src/model/serialize';
import type { BodyEntity, JointEntity, SceneDocument } from '../src/model/types';
import { runtimeOf } from '../src/physics/components/registry';
import { PhysicsWorld } from '../src/physics/world';
import { createBody, createJoint, run, worldOf } from './helpers';
import { anchor, comp, cube, hinge, NO_G, withComponents } from './poweredHelpers';

const scene = (id: string): SceneDocument => {
  const t = listTemplates().find((x) => x.id === id);
  if (!t) throw new Error(`no example scene "${id}"`);
  return sanitizeDocument(JSON.parse(JSON.stringify(t.build())));
};
const finite = (w: PhysicsWorld, ids: string[]) =>
  ids.every((id) => {
    const p = w.getPose(id);
    return !!p && [...p.position, ...p.linvel, ...p.angvel].every(Number.isFinite);
  });
const errorsOf = (w: PhysicsWorld) =>
  w.drainEvents().filter((e) => e.kind === 'component' && (e as { name?: string }).name === 'error');

describe('a motor and a brake on one shaft', () => {
  const rig = (brakeTorque: number) => {
    const base = anchor();
    const wheel = cube(6); // I = 1 kg·m²
    const motor = comp('motor', {
      stallTorque: 4,
      noLoadRpm: 6000,
      currentLimit: 1000,
      inertia: 0.0001,
      duty: 1,
    });
    const brake = comp('brake', { torque: brakeTorque, key: 'KeyB', response: 0 });
    return { base, wheel, motor, brake, j: withComponents(hinge(base, wheel), motor, brake) };
  };

  it('the stronger one wins: 10 N·m of brake holds a 4 N·m motor; 2 N·m of brake lets the 2 N·m difference accelerate it', async () => {
    const strong = rig(10);
    const w = await worldOf([strong.base, strong.wheel, strong.j], NO_G);
    w.setKeys(['KeyB']);
    run(w, 2);
    expect(Math.abs(w.getPose(strong.wheel.id)!.angvel[2])).toBeLessThan(1e-3);
    // edit the brake live to 2 N·m: the 4 N·m motor now wins by 2 N·m → α ≈ 2 rad/s²
    const weaker = {
      ...strong.j,
      components: [strong.motor, { ...strong.brake, params: { ...strong.brake.params, torque: 2 } }],
    };
    w.updateJoint(weaker);
    run(w, 1);
    const speed = w.getPose(strong.wheel.id)!.angvel[2];
    expect(speed).toBeGreaterThan(1.7);
    expect(speed).toBeLessThan(2.3);
    expect(finite(w, [strong.wheel.id])).toBe(true);
    expect(errorsOf(w)).toHaveLength(0);
  });
});

describe('live edits and removals', () => {
  it('removing a wheel, a joint or the engine mid-drive leaves the rest of the car running without errors', async () => {
    const doc = scene('powertrain-car');
    const chassis = doc.entities.find((e) => e.name === 'Powertrain car chassis') as BodyEntity;
    const wheels = doc.entities.filter((e): e is BodyEntity => e.kind === 'body' && /wheel/i.test(e.name));
    const hinges = doc.entities.filter((e): e is JointEntity => e.kind === 'joint' && e.type === 'hinge');
    expect(wheels.length).toBeGreaterThanOrEqual(4);
    const w = await PhysicsWorld.create(doc);
    w.setKeys(['KeyW']);
    run(w, 1.5);
    w.removeEntities([wheels[0].id]); // a wheel disappears (its hinge goes with it)
    run(w, 1);
    expect(finite(w, [chassis.id])).toBe(true);
    w.removeEntities([hinges[hinges.length - 1].id]); // a hinge disappears on its own
    run(w, 1);
    expect(finite(w, [chassis.id])).toBe(true);
    // the engine component is edited away: the drive stops, the car coasts
    const noEngine = { ...chassis, components: chassis.components.filter((c) => c.type !== 'engine') };
    w.updateBody(noEngine);
    run(w, 2);
    expect(finite(w, [chassis.id])).toBe(true);
    expect(errorsOf(w)).toHaveLength(0);
  });

  it('a component moved to another joint, or re-added, picks up from the new place', async () => {
    const base = anchor();
    const wheel = cube(6);
    const m = comp('motor', { stallTorque: 5, noLoadRpm: 6000, currentLimit: 1000, inertia: 0.0001, duty: 1 });
    const j = hinge(base, wheel);
    const w = await worldOf([base, wheel, withComponents(j, m)], NO_G);
    run(w, 0.5);
    const v1 = w.getPose(wheel.id)!.angvel[2];
    expect(v1).toBeGreaterThan(2);
    w.updateJoint({ ...j, components: [] }); // motor off the joint
    const speedAtRemoval = w.getPose(wheel.id)!.angvel[2];
    run(w, 0.5);
    expect(w.getPose(wheel.id)!.angvel[2]).toBeCloseTo(speedAtRemoval, 1); // no motor, no brake: it coasts
    w.updateJoint({ ...j, components: [m] });
    run(w, 0.5);
    expect(w.getPose(wheel.id)!.angvel[2]).toBeGreaterThan(speedAtRemoval + 1.5); // and drives again
    expect(errorsOf(w)).toHaveLength(0);
  });

  it('a servo on a ball joint, a brake on nothing and a gearbox with no shafts do nothing and report nothing wrong', async () => {
    const a = cube(2);
    const b = cube(2, { position: [2, 0, 0] });
    const ball = createJoint({ type: 'ball', bodyA: a.id, bodyB: b.id, anchorA: [1, 0, 0] });
    const w = await worldOf(
      [
        { ...a, components: [comp('gearbox', {}), comp('brake', { key: 'KeyB' })] },
        { ...b, components: [comp('clutch', {}), comp('differential', {})] },
        withComponents(ball, comp('servo', {}), comp('linearActuator', {})),
      ],
      NO_G,
    );
    w.setKeys(['KeyB', 'KeyW', 'KeyS']);
    run(w, 1);
    expect(finite(w, [a.id, b.id])).toBe(true);
    expect(errorsOf(w)).toHaveLength(0);
  });
});

describe('what the registries promise', () => {
  it('every powered component has a runtime, a unique type and defaults that survive their own sanitising', () => {
    const types = new Set<string>();
    for (const def of POWERED_COMPONENTS) {
      expect(types.has(def.type), def.type).toBe(false);
      types.add(def.type);
      expect(componentDef(def.type), def.type).toBe(def);
      expect(runtimeOf(def.type), `${def.type} has a runtime`).toBeDefined();
      expect(sanitizeParams(def, defaultParams(def)), def.type).toEqual(defaultParams(def));
      expect(makeComponent(def.type).params, def.type).toEqual(defaultParams(def));
      expect(def.icon && def.blurb && def.category, def.type).toBeTruthy();
      // every published number has a label for the inspector
      expect(def.state?.length ?? 0, `${def.type} labels its live numbers`).toBeGreaterThan(0);
    }
    expect(types.size).toBe(15);
  });

  it('garbage parameters are repaired to something the runtime can use', () => {
    for (const def of POWERED_COMPONENTS) {
      const junk: Record<string, unknown> = {};
      for (const f of def.fields) junk[f.key] = f.kind === 'number' ? Number.NaN : { nope: true };
      const p = sanitizeParams(def, junk);
      for (const f of def.fields) {
        if (f.kind === 'number') expect(Number.isFinite(p[f.key] as number), `${def.type}.${f.key}`).toBe(true);
      }
    }
  });

  it('a body carrying every powered component at its defaults can be simulated without a single error', async () => {
    const body = createBody({ shape: { type: 'box', size: [1, 1, 1] } });
    const base = anchor([0, -2, 0]);
    const joint = createJoint({ type: 'hinge', bodyA: base.id, bodyB: body.id, anchorA: [0, -1, 0], axis: [0, 0, 1] });
    const bodyTypes = POWERED_COMPONENTS.filter((d) => d.appliesTo !== 'joint').map((d) => makeComponent(d.type));
    const jointTypes = POWERED_COMPONENTS.filter((d) => d.appliesTo !== 'body').map((d) => makeComponent(d.type));
    const w = await worldOf([base, { ...body, components: bodyTypes }, { ...joint, components: jointTypes }], NO_G);
    w.setKeys(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'ShiftLeft', 'KeyF', 'KeyB']);
    w.setAxes({ throttle: 1, brake: 0.5, steer: -1 });
    run(w, 2);
    expect(finite(w, [body.id])).toBe(true);
    expect(errorsOf(w)).toHaveLength(0);
    expect(w.missingRuntimes()).toEqual([]);
  });
});
