/**
 * Ghost placement: the maths behind where a dragged / armed tile lands (surface hit, flush offset along the normal,
 * snapping with and without Alt, rotation and height stepping, tilt alignment, world-bounds validity, overlap), the
 * geometry of the ghosts, and the placeables that create the real objects.
 */
import { describe, expect, it, vi } from 'vitest';
import { qrot, type Quat, type Vec3 } from '../src/core/math';
import { surfaceDropPose, boundsOfShape } from '../src/app/edit/surfaceDrop';
import type { App } from '../src/app/app';
import {
  lightPlaceable,
  pathPlaceable,
  prefabPlaceable,
  shapePlaceable,
  softPlaceable,
  zonePlaceable,
} from '../src/app/placeables';
import { listPrefabs } from '../src/model/content';
import {
  FAR_LIMIT,
  OVERLAP_TOLERANCE,
  boxOfBounds,
  footprintRadius,
  formatPoint,
  formatSize,
  liftAlong,
  liftStep,
  obbPenetration,
  placementViolation,
  stepAngle,
  stepLift,
  worldAabb,
  wrapDeg,
  yawQuat,
} from '../src/model/edit/placeMath';
import { gapAboveSurface } from '../src/model/edit/snap';
import { supportOfShape } from '../src/model/edit/shapeSupport';
import { createLight, createSoft } from '../src/model/factory';
import { halfHeight } from '../src/model/shapes';
import { makeShapeSpec } from '../src/model/shapeRegistry';
import { buildGhostGeometry } from '../src/render/ghostGeometry';
import { ZONE_ACTIONS } from '../src/model/zones';
import type { SoftType } from '../src/model/types';

// ── a stand-in for the parts of the app that `surfaceDropPose` reads ───────────────────────────────

interface Hit {
  point: Vec3;
  normal: Vec3;
}
const prefsBase = {
  snap: false,
  snapGrid: 0.5,
  snapVertex: false,
  snapEdge: false,
  snapFace: false,
  snapBounds: false,
  snapSurface: true,
  snapAlignNormal: false,
};

/** An app whose pointer ray hits `body` (a surface hit) when given, else the ground at `ground`. */
function fakeApp(opts: { ground?: Vec3; body?: Hit; prefs?: Partial<typeof prefsBase> }): App {
  const v = (p: Vec3) => ({ x: p[0], y: p[1], z: p[2] });
  const app = {
    bodies: { pickables: () => [] },
    picker: {
      pick: () =>
        opts.body ? { entityId: 'b', point: v(opts.body.point), normal: v(opts.body.normal), distance: 5 } : null,
      groundPoint: () => (opts.ground ? v(opts.ground) : null),
    },
    camera: { position: { distanceTo: () => 8 } },
    prefs: { value: { ...prefsBase, ...opts.prefs } },
    viewport: { controls: { target: { x: 0, y: 0, z: 0 } } },
    store: { bodies: () => [] },
    sim: { poseOf: () => null },
  };
  return app as unknown as App;
}

const ID: Quat = [0, 0, 0, 1];
const dropShape = (app: App, type: string, extra: Parameters<typeof surfaceDropPose>[4] = {}) =>
  surfaceDropPose(app, 0, 0, boundsOfShape(makeShapeSpec(type)), extra);

describe('ghost pose: a thing rests flush on the surface under the pointer', () => {
  const shapes = ['box', 'sphere', 'cylinder', 'cone', 'capsule', 'ellipsoid', 'rounded-box'];
  for (const type of shapes) {
    it(`${type}: on the ground its bottom is at the hit point (half height up)`, () => {
      const app = fakeApp({ ground: [1.3, 0, 2.1] });
      const pose = dropShape(app, type);
      expect(pose.where).toBe('ground');
      expect(pose.position[0]).toBeCloseTo(1.3, 9);
      expect(pose.position[2]).toBeCloseTo(2.1, 9);
      expect(pose.position[1]).toBeCloseTo(halfHeight(makeShapeSpec(type)) + 0.001, 6);
      expect(pose.point).toEqual([1.3, 0, 2.1]);
    });
  }

  it('on top of a body the offset is measured from that surface, along its normal', () => {
    const app = fakeApp({ body: { point: [0.4, 1.5, -0.2], normal: [0, 1, 0] }, ground: [0.4, 0, -0.2] });
    const pose = dropShape(app, 'cylinder');
    expect(pose.where).toBe('surface');
    const hh = halfHeight(makeShapeSpec('cylinder'));
    expect(pose.position[1]).toBeCloseTo(1.5 + hh + 0.002, 6);
  });

  it('on a slope it stays upright by default and touches the surface exactly (no gap, no penetration)', () => {
    const n: Vec3 = [Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0];
    const app = fakeApp({ body: { point: [0, 1, 0], normal: n }, ground: [0, 0, 0] });
    for (const type of ['box', 'sphere', 'cone']) {
      const spec = makeShapeSpec(type);
      const pose = surfaceDropPose(app, 0, 0, boundsOfShape(spec));
      expect(pose.rotation).toEqual(ID);
      const gap = gapAboveSurface(supportOfShape(spec), pose.position, pose.rotation, [0, 1, 0], n);
      expect(gap).toBeCloseTo(0.002, 6);
    }
  });

  it('with "align to surface normal" its up axis becomes the normal and the offset is the half height', () => {
    const n: Vec3 = [Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0];
    const app = fakeApp({ body: { point: [0, 1, 0], normal: n }, ground: [0, 0, 0] });
    const spec = makeShapeSpec('box');
    const pose = surfaceDropPose(app, 0, 0, boundsOfShape(spec), { alignNormal: true });
    const up = qrot(pose.rotation, [0, 1, 0]);
    expect(up[0]).toBeCloseTo(n[0], 9);
    expect(up[1]).toBeCloseTo(n[1], 9);
    const along = (pose.position[0] - 0) * n[0] + (pose.position[1] - 1) * n[1] + pose.position[2] * n[2];
    expect(along).toBeCloseTo(halfHeight(spec) + 0.002, 6);
    // the preference is honoured when the option is absent
    const pref = fakeApp({ body: { point: [0, 1, 0], normal: n }, prefs: { snapAlignNormal: true } });
    const p2 = surfaceDropPose(pref, 0, 0, boundsOfShape(spec));
    expect(qrot(p2.rotation, [0, 1, 0])[0]).toBeCloseTo(n[0], 9);
  });

  it('the turn the user gave is kept (and kept relative to the surface when aligned)', () => {
    const app = fakeApp({ ground: [0, 0, 0] });
    const q = yawQuat(30);
    const pose = surfaceDropPose(app, 0, 0, boundsOfShape(makeShapeSpec('box')), { rotation: q });
    expect(pose.rotation).toEqual(q);
    const x = qrot(pose.rotation, [1, 0, 0]);
    expect(Math.atan2(-x[2], x[0])).toBeCloseTo((30 * Math.PI) / 180, 9);
  });

  it('nothing under the pointer (the sky) is reported as the view fallback, which placement refuses', () => {
    const pose = dropShape(fakeApp({}), 'box');
    expect(pose.where).toBe('view');
  });

  it('prefab bounds: the lowest point of the assembly sits on the surface, whatever its own origin', () => {
    const app = fakeApp({ ground: [0, 0, 0] });
    const pose = surfaceDropPose(app, 0, 0, { min: [-1, 0.2, -0.5], max: [1, 1.4, 0.5] });
    expect(pose.position[1]).toBeCloseTo(-0.2 + 0.001, 6);
  });
});

describe('ghost pose: snapping', () => {
  const ground: Vec3 = [1.3, 0, 2.1];

  it('grid snapping rounds the landing point to the grid on flat ground', () => {
    const app = fakeApp({ ground, prefs: { snap: true, snapGrid: 0.5 } });
    const pose = dropShape(app, 'box');
    expect(pose.position[0]).toBeCloseTo(1.5, 9);
    expect(pose.position[2]).toBeCloseTo(2.0, 9);
    expect(pose.point[0]).toBeCloseTo(1.5, 9);
  });

  it('Alt (noSnap) suspends the grid but the thing still rests flush', () => {
    const app = fakeApp({ ground, prefs: { snap: true, snapGrid: 0.5 } });
    const pose = dropShape(app, 'box', { noSnap: true });
    expect(pose.position[0]).toBeCloseTo(1.3, 9);
    expect(pose.position[2]).toBeCloseTo(2.1, 9);
    expect(pose.position[1]).toBeCloseTo(0.501, 6);
  });

  it('Alt also wins when surface snapping is switched off in the preferences', () => {
    const app = fakeApp({ ground, prefs: { snap: true, snapSurface: false } });
    const pose = dropShape(app, 'sphere', { noSnap: true });
    expect(pose.position[1]).toBeCloseTo(halfHeight(makeShapeSpec('sphere')) + 0.001, 6); // flush, not the legacy hover
  });

  it('Ctrl inverts: with snapping on it is suspended', () => {
    const app = fakeApp({ ground, prefs: { snap: true, snapGrid: 0.5 } });
    const pose = dropShape(app, 'box', { invert: true });
    expect(pose.position[0]).toBeCloseTo(1.3, 9);
  });

  it('a slope is never grid-snapped (it would leave the surface)', () => {
    const n: Vec3 = [Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0];
    const app = fakeApp({ body: { point: [0.37, 1, 0.61], normal: n }, prefs: { snap: true, snapGrid: 0.5 } });
    const pose = dropShape(app, 'box');
    expect(pose.point).toEqual([0.37, 1, 0.61]);
  });
});

describe('ghost keys: rotation and height stepping', () => {
  it('a coarse step moves to the next multiple of 15 degrees in that direction', () => {
    expect(stepAngle(0, 1)).toBe(15);
    expect(stepAngle(0, -1)).toBe(-15);
    expect(stepAngle(15, 1)).toBe(30);
    expect(stepAngle(15, -1)).toBe(0);
    expect(stepAngle(7, 1)).toBe(15);
    expect(stepAngle(7, -1)).toBe(0);
    expect(stepAngle(-7, 1)).toBe(0);
    expect(stepAngle(-7, -1)).toBe(-15);
  });

  it('Shift is one degree, and turning wraps to (-180, 180]', () => {
    expect(stepAngle(0, 1, true)).toBe(1);
    expect(stepAngle(0, -1, true)).toBe(-1);
    expect(stepAngle(15, 1, true)).toBe(16);
    expect(stepAngle(180, 1)).toBe(-165);
    expect(stepAngle(-180, -1)).toBe(165);
    expect(wrapDeg(540)).toBe(180);
    expect(wrapDeg(-180)).toBe(180);
    let a = 0;
    for (let i = 0; i < 24; i++) a = stepAngle(a, 1);
    expect(a).toBe(0); // a full circle in 24 presses
  });

  it('yawQuat turns about the world up axis', () => {
    const x = qrot(yawQuat(90), [1, 0, 0]);
    expect(x[0]).toBeCloseTo(0, 9);
    expect(x[2]).toBeCloseTo(-1, 9);
    expect(qrot(yawQuat(37), [0, 1, 0])).toEqual([0, 1, 0]);
  });

  it('a raise / lower step is the grid step (a tenth of it with Shift), 10 cm without a grid', () => {
    expect(liftStep(0.25, true)).toBe(0.25);
    expect(liftStep(0.25, true, true)).toBeCloseTo(0.025, 12);
    expect(liftStep(0.25, false)).toBe(0.1);
    expect(stepLift(0, 1, 0.25)).toBe(0.25);
    expect(stepLift(0.25, 1, 0.25)).toBe(0.5);
    expect(stepLift(0.3, 1, 0.25)).toBe(0.5);
    expect(stepLift(0.3, -1, 0.25)).toBe(0.25);
    expect(stepLift(0, -1, 0.25)).toBe(-0.25);
    expect(stepLift(1e9, 1, 0.25)).toBeLessThanOrEqual(50);
    expect(stepLift(-1e9, -1, 0.25)).toBeGreaterThanOrEqual(-5);
  });

  it('lifting moves along the given direction (the surface normal when aligned)', () => {
    expect(liftAlong([1, 2, 3], [0, 1, 0], 0.5)).toEqual([1, 2.5, 3]);
    const n: Vec3 = [0.6, 0.8, 0];
    const p = liftAlong([0, 0, 0], n, 2);
    expect(p[0]).toBeCloseTo(1.2, 12);
    expect(p[1]).toBeCloseTo(1.6, 12);
  });
});

describe('ghost validity', () => {
  const world = { enabled: true, min: [-10, -5, -10] as Vec3, max: [10, 20, 10] as Vec3 };
  it('a centre inside the world bounds is fine, outside is refused (a body leaving them is killed)', () => {
    expect(placementViolation([0, 1, 0], world)).toBeNull();
    expect(placementViolation([11, 1, 0], world)).toBe('Outside the world bounds');
    expect(placementViolation([0, 25, 0], world)).toBe('Outside the world bounds');
    expect(placementViolation([0, 1, -10.5], world)).toBe('Outside the world bounds');
  });
  it('switched-off bounds never refuse, but absurd distances and NaN still do', () => {
    const off = { ...world, enabled: false };
    expect(placementViolation([500, 1, 0], off)).toBeNull();
    expect(placementViolation([FAR_LIMIT + 1, 0, 0], off)).toBe('Too far from the origin');
    expect(placementViolation([NaN, 0, 0], null)).toBe('Too far from the origin');
    expect(placementViolation([0, 0, 0], null)).toBeNull();
  });
  it('the world box of a posed thing', () => {
    const a = worldAabb([-1, 0, -0.5], [1, 2, 0.5], [3, 1, 0], yawQuat(90));
    expect(a.min[0]).toBeCloseTo(2.5, 9);
    expect(a.max[0]).toBeCloseTo(3.5, 9);
    expect(a.min[2]).toBeCloseTo(-1, 9);
    expect(a.max[2]).toBeCloseTo(1, 9);
    expect(a.min[1]).toBeCloseTo(1, 9);
    expect(a.max[1]).toBeCloseTo(3, 9);
  });
  it('oriented boxes: flush contact is not an overlap, sinking in is, a gap is not', () => {
    const floor = { c: [0, -0.5, 0] as Vec3, q: ID, h: [5, 0.5, 5] as Vec3 };
    const flush = { c: [0, 0.502, 0] as Vec3, q: ID, h: [0.5, 0.5, 0.5] as Vec3 };
    const sunk = { c: [0, 0.2, 0] as Vec3, q: ID, h: [0.5, 0.5, 0.5] as Vec3 };
    const apart = { c: [0, 2, 0] as Vec3, q: ID, h: [0.5, 0.5, 0.5] as Vec3 };
    expect(obbPenetration(flush, floor)).toBeLessThan(OVERLAP_TOLERANCE);
    expect(obbPenetration(sunk, floor)).toBeGreaterThan(OVERLAP_TOLERANCE);
    expect(obbPenetration(apart, floor)).toBeLessThan(0);
    // a turned box standing on a floor corner-first is still flush
    const turned = { c: [0, 0.5 * Math.SQRT2 * 0.9 + 0.01, 0] as Vec3, q: yawQuat(45), h: [0.5, 0.5, 0.5] as Vec3 };
    expect(obbPenetration(turned, floor)).toBeLessThan(OVERLAP_TOLERANCE);
  });
  it('the numbers in the label', () => {
    expect(formatSize([-0.5, 0, -0.5], [0.5, 1, 0.5])).toBe('1 × 1 × 1 m');
    expect(formatSize([0, 0, 0], [2.4, 0, 2.4])).toBe('2.4 × 2.4 m');
    expect(formatPoint([1.234, 0, -2])).toBe('x 1.23  y 0  z −2');
    expect(footprintRadius([-1, 0, -1], [1, 1, 1])).toBeGreaterThan(1.4);
    expect(footprintRadius([0, 0, 0], [0, 0, 0])).toBe(0.18);
  });
  it('the box of any bounds description', () => {
    expect(boxOfBounds({ halfHeight: 0.5 })).toEqual({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
    const s = boxOfBounds({ support: supportOfShape(makeShapeSpec('sphere')) });
    expect(s.max[1]).toBeCloseTo(makeShapeSpec('sphere').size[1] / 2, 9);
    expect(s.min[1]).toBeCloseTo(-makeShapeSpec('sphere').size[1] / 2, 9);
  });
});

// ── the ghosts themselves and the things they create ───────────────────────────────────────────────

describe('ghost geometry', () => {
  it('a primitive: a translucent fill and an outline, freed on dispose', () => {
    const g = buildGhostGeometry(shapePlaceable('box').entities());
    expect(g.fill).not.toBeNull();
    expect(g.edges).not.toBeNull();
    expect(g.triangles).toBe(12);
    expect(g.objects).toBe(1);
    const spy = vi.spyOn(g.fill!, 'dispose');
    g.dispose();
    expect(spy).toHaveBeenCalled();
  });

  it('a prefab shows every body, and its joints as faint lines', () => {
    const car = listPrefabs().find((p) => p.name === 'Drivable car')!;
    const ents = car.build();
    const g = buildGhostGeometry(ents);
    expect(g.objects).toBe(ents.filter((e) => e.kind === 'body' && !e.hidden).length);
    expect(g.objects).toBeGreaterThan(3);
    expect(g.faint).not.toBeNull();
    g.dispose();
  });

  it('every built-in prefab and zone builds a non-empty ghost', () => {
    for (const p of listPrefabs()) {
      const g = buildGhostGeometry(p.build());
      expect(g.fill !== null || g.edges !== null || g.faint !== null, p.name).toBe(true);
      g.dispose();
    }
    for (const z of ZONE_ACTIONS) {
      const pl = zonePlaceable(z.id);
      const g = buildGhostGeometry(pl.entities());
      expect(g.objects, z.id).toBeGreaterThan(0);
      g.dispose();
    }
  });

  it('every soft body draws its surface mesh (a cable is a line)', () => {
    const types: SoftType[] = ['jelly', 'balloon', 'cloth', 'cable', 'mesh', 'tyre'];
    for (const t of types) {
      const g = buildGhostGeometry([createSoft(t, { position: [0, 0, 0] })]);
      if (t === 'cable') {
        expect(g.fill).toBeNull();
        expect(g.edges).not.toBeNull();
      } else {
        expect(g.fill, t).not.toBeNull();
        expect(g.triangles, t).toBeGreaterThan(0);
      }
      expect(g.objects).toBe(1);
      g.dispose();
    }
  });

  it('a light is an icon, never a body', () => {
    for (const t of ['point', 'spot', 'directional', 'area'] as const) {
      const g = buildGhostGeometry([createLight(t, { position: [0, 0, 0] })]);
      expect(g.fill).toBeNull();
      expect(g.faint).not.toBeNull();
      g.dispose();
    }
  });

  it('beyond the triangle budget the rest of an assembly is drawn as boxes', () => {
    const car = listPrefabs()
      .find((p) => p.name === 'Drivable car')!
      .build();
    const full = buildGhostGeometry(car);
    const cut = buildGhostGeometry(car, 1);
    expect(cut.triangles).toBeLessThan(full.triangles);
    expect(cut.objects).toBe(full.objects);
    full.dispose();
    cut.dispose();
  });
});

describe('placeables', () => {
  it('a shape rests on its own half height and reports its size', () => {
    const p = shapePlaceable('cylinder');
    const spec = makeShapeSpec('cylinder');
    expect(p.hover).toBe(0);
    expect(p.extent()).toEqual(spec.size);
    const hh = halfHeight(spec);
    expect(boxOfBounds(p.bounds()).max[1]).toBeCloseTo(hh, 9);
  });

  it('creating a shape is one editor call at the ghost pose, with its turn only when it has one', () => {
    const addShape = vi.fn();
    const app = { editor: { addShape }, store: { selection: ['x'] } } as unknown as App;
    shapePlaceable('box').commit(app, { position: [1, 2, 3], rotation: ID });
    expect(addShape).toHaveBeenLastCalledWith('box', [1, 2, 3], {});
    const q = yawQuat(30);
    shapePlaceable('box').commit(app, { position: [1, 2, 3], rotation: q });
    expect(addShape).toHaveBeenLastCalledWith('box', [1, 2, 3], { rotation: q });
  });

  it('a prefab is bounded by its bodies and inserted through the prefab command', () => {
    const first = listPrefabs()[0];
    const pl = prefabPlaceable(first.id)!;
    expect(pl.label).toBe(first.name);
    const b = boxOfBounds(pl.bounds());
    expect(b.max[0]).toBeGreaterThan(b.min[0]);
    const insertPrefab = vi.fn();
    const app = { insertPrefab, store: { selection: [] } } as unknown as App;
    pl.commit(app, { position: [4, 0, 1], rotation: ID });
    expect(insertPrefab).toHaveBeenCalledWith(first.id, { position: [4, 0, 1], rotation: ID });
    expect(prefabPlaceable('nope-no-such')).toBeNull();
  });

  it('cloth and cables hover above the surface; a jelly rests on it; lights hang above it', () => {
    expect(softPlaceable('cloth').hover).toBeGreaterThan(1);
    expect(softPlaceable('cable').hover).toBeGreaterThan(1);
    expect(softPlaceable('jelly').hover).toBe(0);
    expect(softPlaceable('balloon').hover).toBe(0);
    expect(lightPlaceable('point').hover).toBe(3);
    expect(lightPlaceable('directional').hover).toBe(6);
    expect(pathPlaceable().hover).toBeGreaterThan(0);
    // a jelly's bounds are its size box: it rests on its underside
    expect(boxOfBounds(softPlaceable('jelly').bounds()).min[1]).toBeCloseTo(-0.5, 9);
    // the label of a cloth shows its two real dimensions, not its thickness
    expect(formatSize([0, 0, 0], softPlaceable('cloth').extent()!)).toBe('2.4 × 2.4 m');
  });

  it('zones cannot be turned (their helper bodies are placed in world coordinates)', () => {
    for (const z of ZONE_ACTIONS) expect(zonePlaceable(z.id).rotatable, z.id).toBe(false);
    expect(shapePlaceable('box').rotatable).toBe(true);
  });

  it("a light keeps its own aim under the ghost's turn", () => {
    const addLight = vi.fn();
    const app = { editor: { addLight }, store: { selection: [], lights: () => [] } } as unknown as App;
    lightPlaceable('spot').commit(app, { position: [0, 3, 0], rotation: yawQuat(90) });
    const rot = (addLight.mock.calls[0][2] as { rotation: Quat }).rotation;
    // a spot light looks down; turning it about the vertical axis keeps it looking down
    const dir = qrot(rot, [0, 0, -1]);
    expect(dir[1]).toBeCloseTo(-1, 6);
    expect(
      lightPlaceable('point').blocked?.({ store: { lights: () => new Array(64).fill(0) } } as unknown as App),
    ).toMatch(/lights fit/);
  });
});
