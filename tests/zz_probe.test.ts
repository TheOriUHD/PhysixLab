import { it } from 'vitest';
import { getTemplate } from '../src/model/content';
import { PhysicsWorld } from '../src/physics/world';
import type { BodyEntity, JointEntity } from '../src/model/types';
const out = (s: string) => process.stderr.write(s + '\n');
const ids = process.env.PROBE?.split(',') ?? [];
for (const id of ids) it(id, async () => {
  const doc = getTemplate(id)!.build();
  const w = await PhysicsWorld.create(doc);
  const bodies = doc.entities.filter((e): e is BodyEntity => e.kind === 'body' && e.bodyType !== 'static');
  const joints = doc.entities.filter((e): e is JointEntity => e.kind === 'joint');
  for (let t = 0; t < 8; t++) {
    for (let i = 0; i < 60; i++) w.stepOnce();
    out(`--- ${id} t=${t + 1}`);
    for (const b of bodies) { const p = w.getPose(b.id)!; out(`  ${b.name}: pos ${p.position.map((v) => v.toFixed(3))} w ${p.angvel.map((v) => v.toFixed(2))} v ${p.linvel.map((v) => v.toFixed(2))}`); }
    for (const j of joints) { const r = w.getJointRec(j.id); if (r) out(`  J ${j.name}: value ${r.value.toFixed(3)} speed ${r.speed.toFixed(3)} force ${r.force.toFixed(2)}`); }
  }
});
