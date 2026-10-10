/**
 * Joint types are the one extension point that is still a closed union (`JointType`), so adding one touches a
 * handful of places (see "How to add a joint type" in docs/EXTENDING.md). This suite walks every joint type the
 * model knows and checks each of those places — a new type that was forgotten somewhere fails here with its name
 * and the missing place, instead of being drawn as a ball joint or dropped when a file loads.
 */
import { describe, expect, it } from 'vitest';
import { JOINT_ITEMS } from '../src/app/addCatalog';
import { Builder } from '../src/model/builder';
import { JOINT_TYPE_LABELS } from '../src/model/factory';
import { newReport } from '../src/model/errors';
import { parseDocument, serializeDocument } from '../src/model/serialize';
import { isJoint, type JointType } from '../src/model/types';
import { JOINT_COLORS } from '../src/render/jointViews';
import { PhysicsWorld } from '../src/physics/world';

const TYPES = Object.keys(JOINT_TYPE_LABELS) as JointType[];

/** Two boxes, one joint of `type` between them at the contact point. */
function twoBodies(type: JointType) {
  const b = new Builder(`joint ${type}`);
  const a = b.body('A', 'box', [1, 1, 1], [0, 2, 0], { bodyType: 'static' });
  const c = b.body('B', 'box', [1, 1, 1], [0, 0.9, 0], {});
  const j = b.joint(type, a, c, [0, 1.5, 0], [0, 0, 1]);
  return { doc: b.done(), joint: j };
}

describe('every joint type is wired everywhere it has to be', () => {
  it('has the six built-in types (a deliberate change must update this list and docs/EXTENDING.md)', () => {
    expect([...TYPES].sort()).toEqual(['ball', 'fixed', 'hinge', 'rope', 'slider', 'spring']);
  });

  for (const type of TYPES) {
    describe(type, () => {
      it('has a label and a viewport colour', () => {
        expect(JOINT_TYPE_LABELS[type].length).toBeGreaterThan(0);
        expect(JOINT_COLORS[type], 'src/render/jointViews.ts JOINT_COLORS').toMatch(/^#[0-9a-f]{6}$/i);
      });

      it('is offered by the Add tab and the "Joint tool: …" command catalogue', () => {
        const item = JOINT_ITEMS.find((i) => i.type === type);
        expect(item, 'src/app/addCatalog.ts JOINT_ITEMS').toBeDefined();
        expect(item!.blurb.length).toBeGreaterThan(10);
      });

      it('survives saving and loading (src/model/serialize.ts knows the type)', () => {
        const { doc, joint } = twoBodies(type);
        const report = newReport();
        const loaded = parseDocument(serializeDocument(doc), report);
        const back = loaded.entities.find((e) => e.id === joint.id);
        expect(report.warnings).toEqual([]);
        expect(back && isJoint(back) ? back.type : null, 'the loader kept the joint type').toBe(type);
      });

      it('is built by the physics world (src/physics/world/joints.ts) and measured while stepping', async () => {
        const { doc, joint } = twoBodies(type);
        const w = await PhysicsWorld.create(doc);
        for (let i = 0; i < 60; i++) w.stepOnce();
        const rec = w.getJointRec(joint.id);
        expect(rec, 'the world built the joint').not.toBeNull();
        expect(Number.isFinite(rec!.value) && Number.isFinite(rec!.speed) && Number.isFinite(rec!.force)).toBe(true);
        expect(rec!.broken).toBe(false);
      });
    });
  }
});
