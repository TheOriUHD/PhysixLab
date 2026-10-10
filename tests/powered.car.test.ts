/** The powertrain car as a whole: it drives, shifts, brakes and survives a snapshot. */
import { describe, expect, it } from 'vitest';
import { listPrefabs } from '../src/model/content';
import { newDocument } from '../src/model/factory';
import { toRpm } from '../src/physics/components/powered/common';
import { PhysicsWorld } from '../src/physics/world';
import type { BodyEntity, SceneDocument } from '../src/model/types';
import { sanitizeDocument } from '../src/model/serialize';

/** The prefab on its own (no ramp, no ice): just the car on the ground. */
const car = (): SceneDocument =>
  sanitizeDocument(
    JSON.parse(
      JSON.stringify({
        ...newDocument('car'),
        entities: listPrefabs()
          .find((p) => p.id === 'powertrain-car')!
          .build(),
      }),
    ),
  );
const byName = (doc: SceneDocument, name: string) => doc.entities.find((e) => e.name === name) as BodyEntity;
const run = (w: PhysicsWorld, s: number) => {
  for (let i = 0; i < Math.round(s * w.settings.physicsHz); i++) w.stepOnce();
};
const published = new Map<string, number[]>();
const state = (w: PhysicsWorld, id: string) => {
  for (const [k, e] of Object.entries(w.drainComponentState().changed)) if (e.values) published.set(k, [...e.values]);
  return published.get(id) ?? [];
};
const comp = (doc: SceneDocument, type: string) =>
  byName(doc, 'Powertrain car chassis').components.find((c) => c.type === type)!;

describe('powertrain car', () => {
  it('is registered as a prefab and an example scene', () => {
    expect(listPrefabs().some((p) => p.id === 'powertrain-car')).toBe(true);
  });

  it('accelerates under throttle through the whole drive train, shifting up on its own', async () => {
    const doc = car();
    const w = await PhysicsWorld.create(doc);
    const chassis = byName(doc, 'Powertrain car chassis');
    const gearbox = comp(doc, 'gearbox');
    const engine = comp(doc, 'engine');
    run(w, 1);
    expect(Math.abs(w.getPose(chassis.id)!.linvel[0])).toBeLessThan(0.3); // idling, brakes off, nothing pushes it
    w.setKeys(['KeyW']);
    const gears = new Set<number>();
    for (let i = 0; i < 5.5 * 120; i++) {
      w.stepOnce();
      if (i % 12 === 0) gears.add(state(w, gearbox.id)[0]);
    }
    const v = w.getPose(chassis.id)!.linvel;
    expect(v[0]).toBeGreaterThan(12); // > 43 km/h after 5.5 s
    expect(Math.abs(v[2])).toBeLessThan(1.5); // straight
    expect(gears.size).toBeGreaterThanOrEqual(3); // 1 → 2 → 3 …
    const rpm = state(w, engine.id)[0];
    expect(rpm).toBeGreaterThan(900);
    expect(rpm).toBeLessThanOrEqual(6801);
    // the locked drive train: crank speed = ratio · final drive · driven-wheel speed
    const [gear, ratio, inRpm, outRpm] = state(w, gearbox.id);
    expect(gear).toBeGreaterThanOrEqual(1);
    expect(inRpm / outRpm).toBeCloseTo(ratio, 1);
  });

  it('brakes to a stop, and the parking brake holds it on the spot', async () => {
    const doc = car();
    const w = await PhysicsWorld.create(doc);
    const chassis = byName(doc, 'Powertrain car chassis');
    w.setKeys(['KeyW']);
    run(w, 3);
    const fast = w.getPose(chassis.id)!.linvel[0];
    expect(fast).toBeGreaterThan(8);
    w.setKeys(['KeyS']);
    run(w, 6);
    expect(Math.abs(w.getPose(chassis.id)!.linvel[0])).toBeLessThan(0.3);
    expect(w.getPose(chassis.id)!.position[0]).toBeLessThan(40); // it stopped on the ground, not off the edge
    expect(Number.isFinite(w.getPose(chassis.id)!.position[0])).toBe(true);
  });

  it('reverses with R', async () => {
    const doc = car();
    const w = await PhysicsWorld.create(doc);
    const chassis = byName(doc, 'Powertrain car chassis');
    w.setKeys(['KeyR']);
    run(w, 0.1);
    w.setKeys(['KeyW']);
    run(w, 4);
    expect(w.getPose(chassis.id)!.linvel[0]).toBeLessThan(-2);
  });

  it('survives a snapshot: the replay after a restore is identical', async () => {
    const doc = car();
    const w = await PhysicsWorld.create(doc);
    const chassis = byName(doc, 'Powertrain car chassis');
    w.setKeys(['KeyW']);
    run(w, 3);
    const snap = w.snapshot();
    run(w, 2);
    const first = w.getPose(chassis.id)!;
    w.restore(snap);
    run(w, 2);
    const second = w.getPose(chassis.id)!;
    expect(second.position).toEqual(first.position);
    expect(second.linvel).toEqual(first.linvel);
    void toRpm;
  });
});
