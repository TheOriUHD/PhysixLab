/**
 * Viewport gizmos of every joint type (JT-20): each type builds a view with its pick sphere(s), the new types draw their
 * mechanism, a frame (edit and live) leaves every transform finite, and `dispose()` frees every geometry and material.
 */
import { describe, expect, it } from 'vitest';
import { Group, Object3D, PerspectiveCamera, type Material, type BufferGeometry } from 'three';
import { createJoint } from '../src/model/factory';
import { hasIndependentAnchors, JT_A_TYPES } from '../src/model/jointParams';
import type { JointType } from '../src/model/types';
import { J, JOINT_STRIDE } from '../src/physics/protocol';
import type { BodyViews } from '../src/render/bodyViews';
import { JOINT_COLORS, JointViews } from '../src/render/jointViews';

const TYPES = Object.keys(JOINT_COLORS) as JointType[];

/** Two body views are all `JointViews` reads: a mesh with a pose. */
function fakeBodies(): BodyViews {
  const a = new Object3D();
  a.position.set(0, 2, 0);
  const b = new Object3D();
  b.position.set(1.5, 1, 0.5);
  b.rotation.set(0.3, 0.2, 0.1);
  const views = new Map([
    ['a', { mesh: a }],
    ['b', { mesh: b }],
  ]);
  return { get: (id: string) => views.get(id) } as unknown as BodyViews;
}

function makeJoint(type: JointType) {
  const j = createJoint({
    type,
    bodyA: 'a',
    bodyB: 'b',
    anchorA: [0, 0, 0],
    anchorB: [0.2, -0.3, 0],
    axis: [0, 1, 0],
  });
  j.limit = { enabled: true, min: -1, max: 0.8 };
  j.params.dof[0].mode = 'limited';
  j.params.dof[1].mode = 'free';
  j.params.dof[3].mode = 'limited';
  j.params.dof[4].mode = 'free';
  j.params.pulleyA = [0, 4, 0];
  j.params.pulleyB = [1, 4, 0];
  return j;
}

/** Counts of `dispose` events so a leak shows up as a type name. */
function trackDisposal(root: Object3D): { total: number; freed: () => number } {
  let total = 0;
  let freed = 0;
  const watch = (r: BufferGeometry | Material) => {
    total++;
    r.addEventListener('dispose', () => freed++);
  };
  root.traverse((o) => {
    const m = o as { geometry?: BufferGeometry; material?: Material | Material[] };
    // the geometries shared by every view (unit shapes) are deliberately never freed
    if (m.geometry && (m.geometry.type === 'LineGeometry' || m.geometry.userData.ownedByGizmo)) watch(m.geometry);
    if (m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) watch(mat);
  });
  return { total, freed: () => freed };
}

describe('joint gizmos', () => {
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 200);
  camera.position.set(4, 3, 8);
  camera.lookAt(0, 1.5, 0);
  camera.updateMatrixWorld();

  it.each(TYPES)('%s: builds a view with its pick spheres and survives a frame', (type) => {
    const group = new Group();
    const jv = new JointViews(group, fakeBodies());
    jv.setResolution(1600, 900);
    const def = makeJoint(type);
    jv.add(def);
    const v = jv.views.get(def.id)!;
    expect(v.hit.userData.entityId).toBe(def.id);
    expect(v.hit.userData.end).toBe('A');
    expect(!!v.hitB, `${type} hitB`).toBe(hasIndependentAnchors(type));
    if (JT_A_TYPES.includes(type)) {
      expect(v.gizmo, `${type} has a gizmo`).not.toBeNull();
      expect(v.gizmo!.polys.length + v.gizmo!.meshes.length, `${type} draws something`).toBeGreaterThan(0);
    }
    jv.setSelected(new Set([def.id]));
    // edit-mode frame, then a live one
    jv.updateFrame(camera, null, () => undefined, new Set());
    const state = new Float32Array(JOINT_STRIDE);
    state[J.value] = 0.4;
    state[J.speed] = 0.1;
    state[J.force] = 30;
    jv.updateFrame(camera, state, () => 0, new Set());
    expect(v.root.visible).toBe(true);
    v.root.updateMatrixWorld(true);
    v.gizmo?.group.updateMatrixWorld(true);
    const bad: string[] = [];
    for (const root of [v.root, v.gizmo?.group]) {
      root?.traverse((o) => {
        if (![...o.position.toArray(), ...o.scale.toArray(), ...o.quaternion.toArray()].every(Number.isFinite))
          bad.push(o.type);
      });
    }
    expect(bad, `${type} has non-finite transforms`).toEqual([]);
    const pick = jv.pickables();
    expect(pick).toContain(v.hit);
    if (v.hitB) {
      expect(pick).toContain(v.hitB);
      // end B sits at the second anchor in world space, not on top of A
      expect(v.hitB.position.length()).toBeGreaterThan(0.01);
    }
    jv.remove(def.id);
    expect(group.children.length).toBe(0);
  });

  it('end B of independent-anchor types is the body-B anchor in world space', () => {
    const jv = new JointViews(new Group(), fakeBodies());
    for (const type of TYPES.filter(hasIndependentAnchors)) {
      const d = makeJoint(type);
      const f = jv.frameOf(d, {
        a: camera.position.clone(),
        b: camera.position.clone(),
        axis: camera.position.clone(),
      })!;
      expect(f.b.distanceTo(f.a), type).toBeGreaterThan(0.1);
    }
  });

  it('dispose frees every owned geometry and material', () => {
    for (const type of TYPES) {
      const group = new Group();
      const jv = new JointViews(group, fakeBodies());
      const def = makeJoint(type);
      jv.add(def);
      const v = jv.views.get(def.id)!;
      const t = trackDisposal(v.root);
      const tg = v.gizmo ? trackDisposal(v.gizmo.group) : { total: 0, freed: () => 0 };
      jv.remove(def.id);
      expect(t.freed(), `${type} view`).toBe(t.total);
      expect(tg.freed(), `${type} gizmo`).toBe(tg.total);
    }
  });
});
