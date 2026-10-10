/**
 * Joint operations that work on the selection (JT-22): copy settings to the other selected joints, and mirror
 * joints together with the bodies they connect across a world plane. DOM-free; the commands in
 * `builtin/jointCommands.ts` call these, and the inspector buttons do too.
 */
import { cloneComponents } from '../model/componentRegistry';
import { uid } from '../model/factory';
import {
  findMirrorPartner,
  isOnPlane,
  mirrorBody,
  mirrorJoint,
  type MirrorEnd,
  type MirrorPlane,
} from '../model/jointMirror';
import type { BodyEntity, Entity, JointEntity } from '../model/types';
import { isBody, isJoint } from '../model/types';
import type { App } from './app';

/** `params` fields that describe where this joint is (geometry / pose) rather than how it behaves. */
const POSE_PARAMS = ['pulleyA', 'pulleyB', 'axisB', 'refOffset', 'refLocked'] as const;

/** The joint whose settings are copied and the joints they go to: the first selected joint, and the other selected
 *  joints of its type. */
export function copySettingsPlan(app: App): { source: JointEntity; targets: JointEntity[] } | null {
  const joints = app.store.selection.map((id) => app.store.get(id)).filter(isJoint);
  if (joints.length < 2) return null;
  const [source, ...rest] = joints;
  const targets = rest.filter((j) => j.type === source.type);
  return targets.length ? { source, targets } : null;
}

/**
 * Copy limit, motor, spring, rope length, collide flag and behaviour params (not the joint's geometry: anchors, axes,
 * pulley points, reference pose) from `sourceId` to the joints in `targetIds` of the same type, as one undo step.
 * Returns how many joints changed.
 */
export function copyJointSettingsTo(app: App, sourceId: string, targetIds: readonly string[]): number {
  const source = app.store.joint(sourceId);
  if (!source) return 0;
  const targets = targetIds
    .map((id) => app.store.joint(id))
    .filter((t): t is JointEntity => !!t && t.id !== sourceId && t.type === source.type);
  if (!targets.length) return 0;
  app.store.updateMany(
    targets.map((t): [string, Partial<JointEntity>] => {
      const params = { ...source.params, dof: source.params.dof.map((d) => ({ ...d })) };
      for (const k of POSE_PARAMS) (params as Record<string, unknown>)[k] = t.params[k];
      return [
        t.id,
        {
          limit: { ...source.limit },
          motor: { ...source.motor },
          spring: { ...source.spring },
          ropeLength: source.ropeLength,
          collideConnected: source.collideConnected,
          params,
        },
      ];
    }),
    `Copy settings of ${source.name}`,
  );
  app.toast(`Copied settings of ${source.name} to ${targets.length} joint${targets.length > 1 ? 's' : ''}`);
  return targets.length;
}

/** `copyJointSettingsTo` for the selection: the first selected joint to the other selected joints of its type. */
export function copyJointSettings(app: App): number {
  const plan = copySettingsPlan(app);
  return plan
    ? copyJointSettingsTo(
        app,
        plan.source.id,
        plan.targets.map((t) => t.id),
      )
    : 0;
}

export interface MirrorResult {
  bodies: number;
  joints: number;
  /** Joints that could not be mirrored, with the reason. */
  skipped: string[];
}

/** Does `existing` already hold the joint `j` would become (same type, bodies and anchor)? */
function alreadyThere(all: readonly Entity[], j: JointEntity): boolean {
  return all.some(
    (o) =>
      isJoint(o) &&
      o.type === j.type &&
      o.bodyA === j.bodyA &&
      o.bodyB === j.bodyB &&
      o.anchorA.every((v, i) => Math.abs(v - j.anchorA[i]) < 1e-4),
  );
}

/**
 * Mirror the selected bodies and the joints between them across `plane`, as one undo step. A selected joint whose
 * bodies are not selected attaches to the body's existing mirror twin (a body that was mirrored earlier, or that lies
 * on the plane); a joint attached to the world mirrors its world anchor.
 */
export function mirrorSelection(app: App, plane: MirrorPlane): MirrorResult {
  const { store } = app;
  const all = store.all();
  const allBodies = all.filter(isBody);
  const sel = store.selection.map((id) => store.get(id)).filter((e): e is Entity => !!e);
  const selBodies = sel.filter(isBody);
  const selBodyIds = new Set(selBodies.map((b) => b.id));
  const result: MirrorResult = { bodies: 0, joints: 0, skipped: [] };

  // Joints to mirror: the selected ones, plus every joint between two selected bodies (or one and the world).
  const joints = new Map<string, JointEntity>();
  for (const e of sel) if (isJoint(e)) joints.set(e.id, e);
  for (const j of store.joints()) {
    const a = j.bodyA === null || selBodyIds.has(j.bodyA);
    const b = j.bodyB === null || selBodyIds.has(j.bodyB);
    if (a && b && (j.bodyA !== null || j.bodyB !== null)) joints.set(j.id, j);
  }
  if (!selBodies.length && !joints.size) return result;

  // Bodies: mirrored copies (a body on the plane is its own twin).
  const copyOf = new Map<string, string>();
  const newBodies: BodyEntity[] = [];
  for (const b of selBodies) {
    if (isOnPlane(b, plane)) continue;
    copyOf.set(b.id, uid('b'));
  }
  for (const b of selBodies) {
    const id = copyOf.get(b.id);
    if (!id) continue;
    newBodies.push({
      ...mirrorBody(b, plane),
      id,
      name: store.uniqueName(`${b.name.replace(/ \d+$/, '')} mirrored`),
      components: cloneComponents(b.components, copyOf),
    });
  }

  const poseOf = (b: BodyEntity) => ({ position: b.position, rotation: b.rotation });
  const endFor = (id: string | null): MirrorEnd | string => {
    if (id === null) return { kind: 'world' };
    const copy = copyOf.get(id);
    if (copy) return { kind: 'copy', body: copy };
    const b = store.body(id);
    if (!b) return `a body of the joint no longer exists`;
    if (isOnPlane(b, plane)) return { kind: 'keep', body: id, pose: poseOf(b) };
    const twin = findMirrorPartner(b, allBodies, plane);
    if (twin) return { kind: 'copy', body: twin.id };
    return `${b.name} has no mirrored twin (select it too to mirror it)`;
  };

  const newJoints: JointEntity[] = [];
  const idMap = new Map(copyOf);
  for (const j of joints.values()) {
    const a = endFor(j.bodyA);
    const b = endFor(j.bodyB);
    if (typeof a === 'string' || typeof b === 'string') {
      result.skipped.push(`${j.name}: ${typeof a === 'string' ? a : (b as string)}`);
      continue;
    }
    const m = mirrorJoint(j, plane, a, b);
    if (alreadyThere(all, m) || alreadyThere(newJoints, m)) {
      result.skipped.push(`${j.name}: its mirror image already exists`);
      continue;
    }
    newJoints.push({
      ...m,
      id: uid('j'),
      name: store.uniqueName(`${j.name.replace(/ \d+$/, '')} mirrored`),
      components: cloneComponents(m.components, idMap),
    });
  }

  const created: Entity[] = [...newBodies, ...newJoints];
  if (created.length) {
    store.add(created, 'Mirror', false);
    store.setSelection(created.map((e) => e.id));
  }
  result.bodies = newBodies.length;
  result.joints = newJoints.length;
  return result;
}
