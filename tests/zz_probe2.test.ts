import { it } from 'vitest';
import { getPrefab } from '../src/model/content';
import { newDocument } from '../src/model/factory';
import { PhysicsWorld } from '../src/physics/world';
import type { BodyEntity, JointEntity } from '../src/model/types';
const out = (s: string) => process.stderr.write(s + '\n');
for (const [tm, rev] of [[8, true], [3, true], [12, true], [4.5, true], [5.5, true]] as [number, boolean][]) it('torque ' + tm, async () => {
  const doc = { ...newDocument('g'), entities: getPrefab('jt-gear-pair')!.build() };
  const js = doc.entities.filter((e): e is JointEntity => e.kind === 'joint');
  const axA = js.find((j) => j.name === 'Axle A (motor)')!;
  const axB = js.find((j) => j.name === 'Axle B')!;
  axA.motor = { ...axA.motor, mode: 'velocity', targetVelocity: 4, maxForce: tm, damping: 1e4 };
  axB.motor = { ...axB.motor, mode: 'velocity', targetVelocity: 0, maxForce: 10, damping: 1e4 };
  const a = doc.entities.find((e) => e.name === 'Gear A (driver)') as BodyEntity;
  const w = await PhysicsWorld.create(doc);
  for (let i = 0; i < 360; i++) w.stepOnce();
  out(`motor ${tm} N·m: gear A speed ${w.getPose(a.id)!.angvel[2].toFixed(3)} ${rev}`);
});
