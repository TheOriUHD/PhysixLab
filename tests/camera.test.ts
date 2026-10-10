/** CM-A cameras without a browser: pose maths, the dual perspective / orthographic camera, saved cameras. */
import { describe, expect, it } from 'vitest';
import { Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import { DualCamera } from '../src/render/dualCamera';
import { MapView, yawOf } from '../src/app/camera/minimap';
import {
  angleDelta,
  chasePose,
  dirOf,
  firstPersonPose,
  flyStep,
  headingOf,
  lookBy,
  lookQuaternion,
  newFollow,
  newPose,
  thirdPersonPose,
  type Subject,
} from '../src/app/camera/poses';
import { DEFAULT_CAMERA_SETTINGS, sanitizeCameraSettings } from '../src/app/camera/settings';
import { CAMERA_LIMITS, emptyCameras, sanitizeCameras } from '../src/model/sanitize/cameras';
import { SceneStore } from '../src/model/store';
import { parseDocument, serializeDocument } from '../src/model/serialize';

const subject = (over: Partial<Subject> = {}): Subject => ({
  position: new Vector3(0, 0.5, 0),
  quaternion: new Quaternion(),
  velocity: new Vector3(),
  top: 0.5,
  ...over,
});
const forwardOf = (q: Quaternion) => new Vector3(0, 0, -1).applyQuaternion(q);

describe('camera pose maths', () => {
  it('headings and angle differences', () => {
    expect(headingOf(new Quaternion(), '+x')).toBeCloseTo(Math.PI / 2, 9);
    expect(headingOf(new Quaternion(), '+z')).toBeCloseTo(0, 9);
    const turned = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2); // +X → −Z
    expect(headingOf(turned, '+x')).toBeCloseTo(Math.PI, 6);
    // a body that points straight up has no heading: the fallback is kept
    const up = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    expect(headingOf(up, '+x', 1.25)).toBe(1.25);
    expect(angleDelta(0.1, Math.PI * 2 - 0.1)).toBeCloseTo(-0.2, 9);
    expect(angleDelta(-3, 3)).toBeCloseTo(6 - Math.PI * 2, 9);
    expect(dirOf(Math.PI / 2, new Vector3()).x).toBeCloseTo(1, 9);
  });

  it('lookQuaternion points the camera (−Z) along a heading and pitch', () => {
    const f = forwardOf(lookQuaternion(Math.PI / 2, 0, new Quaternion()));
    expect(f.x).toBeCloseTo(1, 9);
    expect(f.z).toBeCloseTo(0, 9);
    const up = forwardOf(lookQuaternion(0, 0.5, new Quaternion()));
    expect(up.y).toBeCloseTo(Math.sin(0.5), 9);
    expect(up.z).toBeCloseTo(Math.cos(0.5), 9);
  });

  it('fly: moves at the set speed along the view direction, ×4 with boost, up is world-up, mouse look clamps pitch', () => {
    const s = { position: new Vector3(), yaw: Math.PI / 2, pitch: 0, velocity: new Vector3() };
    for (let i = 0; i < 200; i++) flyStep(s, { forward: 1, right: 0, up: 0, boost: false }, 8, 0.01);
    expect(s.velocity.length()).toBeCloseTo(8, 2);
    expect(s.velocity.x / s.velocity.length()).toBeCloseTo(1, 3); // heading +X
    const t = { position: new Vector3(), yaw: 0, pitch: 1, velocity: new Vector3() };
    for (let i = 0; i < 300; i++) flyStep(t, { forward: 0, right: 0, up: 1, boost: true }, 5, 0.01);
    expect(t.velocity.y).toBeCloseTo(20, 1);
    expect(Math.hypot(t.velocity.x, t.velocity.z)).toBeLessThan(1e-6);
    const look = { yaw: 0, pitch: 0 };
    lookBy(look, 100, -100000);
    expect(look.pitch).toBe(1.5);
    expect(look.yaw).toBeCloseTo(-0.35, 9);
  });

  it('first person: eye above the body, looking along the chosen forward axis, following its roll', () => {
    const out = newPose();
    firstPersonPose(subject(), '+x', { yaw: 0, pitch: 0 }, 55, out);
    expect(out.position.y).toBeCloseTo(0.5 + 0.4, 9);
    const f = forwardOf(out.quaternion);
    expect(f.x).toBeCloseTo(1, 9);
    expect(out.fov).toBe(55);
    // look 90° to the left (positive yaw): forward becomes −Z
    firstPersonPose(subject(), '+x', { yaw: Math.PI / 2, pitch: 0 }, 55, out);
    expect(forwardOf(out.quaternion).z).toBeCloseTo(-1, 9);
    // a body turned to face +Z looks along +Z
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);
    firstPersonPose(subject({ quaternion: q }), '+x', { yaw: 0, pitch: 0 }, 55, out);
    expect(forwardOf(out.quaternion).z).toBeCloseTo(1, 9);
  });

  it('third person: settles behind and above the heading, shortens at once for an obstacle, lengthens slowly', () => {
    const s = newFollow();
    const out = newPose();
    const sub = subject();
    for (let i = 0; i < 300; i++) thirdPersonPose(s, sub, '+x', { distance: 6, height: 2.2 }, null, 48, 0.02, out);
    expect(out.position.x).toBeLessThan(-4); // behind a body that faces +X
    expect(out.position.y).toBeGreaterThan(1.5);
    expect(Math.abs(out.position.z)).toBeLessThan(0.05);
    // the camera looks at the body
    const toBody = new Vector3().subVectors(new Vector3(0, 0.95, 0), out.position).normalize();
    expect(forwardOf(out.quaternion).dot(toBody)).toBeGreaterThan(0.999);
    const full = s.arm;
    const wall = () => 2; // an obstacle 2 m from the pivot
    thirdPersonPose(s, sub, '+x', { distance: 6, height: 2.2 }, wall, 48, 0.02, out);
    expect(s.arm).toBeLessThanOrEqual(2 - 0.25 + 1e-9);
    const shortArm = s.arm;
    thirdPersonPose(s, sub, '+x', { distance: 6, height: 2.2 }, null, 48, 0.02, out);
    expect(s.arm).toBeGreaterThan(shortArm);
    expect(s.arm).toBeLessThan(full); // no popping back
  });

  it('chase: sits behind the direction of travel, widens the lens with speed, swings round to look behind', () => {
    const s = newFollow();
    const out = newPose();
    const moving = subject({ velocity: new Vector3(0, 0, 12) });
    for (let i = 0; i < 400; i++) chasePose(s, moving, '+x', { distance: 7, height: 2.6 }, false, 48, 0.02, out);
    expect(out.position.z).toBeLessThan(-6); // behind a body travelling toward +Z, whatever its nose points at
    expect(forwardOf(out.quaternion).z).toBeGreaterThan(0.9);
    expect(out.fov).toBeGreaterThan(48 + 3);
    for (let i = 0; i < 400; i++) chasePose(s, moving, '+x', { distance: 7, height: 2.6 }, true, 48, 0.02, out);
    expect(out.position.z).toBeGreaterThan(6); // in front, looking back
    expect(forwardOf(out.quaternion).z).toBeLessThan(-0.9);
    // standing still: the camera follows the nose and the lens returns to normal
    const still = subject();
    for (let i = 0; i < 600; i++) chasePose(s, still, '+x', { distance: 7, height: 2.6 }, false, 48, 0.02, out);
    expect(out.position.x).toBeLessThan(-6);
    expect(out.fov).toBeCloseTo(48, 3);
  });
});

describe('DualCamera', () => {
  it('is perspective by default and orthographic on demand, with the flags three.js and the orbit controls read', () => {
    const c = new DualCamera(48, 2, 0.05, 2000);
    expect((c as unknown as { isPerspectiveCamera: boolean }).isPerspectiveCamera).toBe(true);
    expect((c as unknown as { isOrthographicCamera: boolean }).isOrthographicCamera).toBe(false);
    c.ortho = true;
    c.orthoSize = 10;
    c.updateProjectionMatrix();
    expect((c as unknown as { isPerspectiveCamera: boolean }).isPerspectiveCamera).toBe(false);
    expect((c as unknown as { isOrthographicCamera: boolean }).isOrthographicCamera).toBe(true);
  });

  it('orthographic projection: visible height = orthoSize / zoom, no perspective shrink, parallel picking rays', () => {
    const c = new DualCamera(48, 2, 0.05, 2000);
    c.ortho = true;
    c.orthoSize = 10;
    c.position.set(0, 0, 50);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    // 5 m above the axis = the top edge of the view, whatever the depth
    const near = new Vector3(0, 5, 10).project(c);
    const far = new Vector3(0, 5, -100).project(c);
    expect(near.y).toBeCloseTo(1, 9);
    expect(far.y).toBeCloseTo(1, 9);
    expect(new Vector3(10, 0, 0).project(c).x).toBeCloseTo(1, 9); // aspect 2 → half width 10
    c.zoom = 2;
    c.updateProjectionMatrix();
    expect(new Vector3(0, 2.5, 0).project(c).y).toBeCloseTo(1, 9);
    c.zoom = 1;
    c.updateProjectionMatrix();
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(-0.5, 0.3), c);
    const d1 = ray.ray.direction.clone();
    ray.setFromCamera(new Vector2(0.7, -0.2), c);
    expect(ray.ray.direction.distanceTo(d1)).toBeLessThan(1e-9);
    // back to perspective restores the usual lens
    c.ortho = false;
    c.updateProjectionMatrix();
    expect(new Vector3(0, 5, 10).project(c).y).not.toBeCloseTo(new Vector3(0, 5, -100).project(c).y, 3);
  });
});

describe('camera settings and saved cameras', () => {
  it('sanitises settings', () => {
    expect(sanitizeCameraSettings(null)).toEqual(DEFAULT_CAMERA_SETTINGS);
    const s = sanitizeCameraSettings({ fov: 999, flySpeed: -3, forwardAxis: 'up', shake: 'x', motion: 'reduce' });
    expect(s.fov).toBe(110);
    expect(s.flySpeed).toBe(0.5);
    expect(s.forwardAxis).toBe('+x');
    expect(s.shake).toBe(1);
    expect(s.motion).toBe('reduce');
  });

  it('sanitises bookmarks, shots and view setups', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      id: `b${i}`,
      name: `n${i}`,
      position: [1, 2, 3],
      target: [0, 0, 0],
    }));
    const c = sanitizeCameras({
      bookmarks: [...many, { id: 'b0', name: 'dup' }],
      shots: [{ id: 's', pathId: 'p', duration: -5, keys: [{ t: 99, u: 7, fov: 1, ease: 'wobble' }] }, 'junk'],
      split: 9,
      panes: [{ mode: 'nope', fov: 500, subject: 5 }],
      pips: [{ mode: 'mount', offset: [1000, 0, 0], x: 5 }],
      minimap: { enabled: 'yes', range: -1, corner: 'zz' },
    });
    expect(c.bookmarks).toHaveLength(CAMERA_LIMITS.bookmarks);
    expect(new Set(c.bookmarks.map((b) => b.id)).size).toBe(c.bookmarks.length);
    expect(c.shots).toHaveLength(1);
    expect(c.shots[0].duration).toBe(0.5);
    expect(c.shots[0].keys.length).toBeGreaterThanOrEqual(2); // a shot always has a start and an end
    expect(c.shots[0].keys.every((k) => k.u >= 0 && k.u <= 1 && k.t <= c.shots[0].duration)).toBe(true);
    expect(c.shots[0].keys.every((k) => ['linear', 'in', 'out', 'inOut'].includes(k.ease))).toBe(true);
    expect(c.split).toBe(1);
    expect(c.panes[0]).toMatchObject({ mode: 'chase', fov: 120, subject: null });
    expect(c.pips[0].offset[0]).toBe(100);
    expect(c.pips[0].x).toBe(0.95);
    expect(c.minimap).toEqual({ enabled: false, range: 2, rotate: false, corner: 'br' });
    expect(sanitizeCameras(undefined)).toEqual(emptyCameras());
    // only small image data URLs survive as thumbnails
    const ok = 'data:image/jpeg;base64,/9j/4AAQ';
    const t = sanitizeCameras({
      bookmarks: [
        { id: 'a', thumb: ok },
        { id: 'b', thumb: 'javascript:alert(1)' },
        { id: 'c', thumb: `data:image/png;base64,${'A'.repeat(30000)}` },
      ],
    });
    expect(t.bookmarks.map((b) => b.thumb)).toEqual([ok, undefined, undefined]);
  });

  it('bookmarks are part of the scene: undo / redo, save and load round trip', () => {
    const store = new SceneStore();
    expect(store.cameras.bookmarks).toHaveLength(0);
    const view = {
      position: [1, 2, 3] as [number, number, number],
      target: [0, 1, 0] as [number, number, number],
      fov: 40,
      ortho: false,
      orthoSize: 12,
    };
    store.setCameras({ ...store.cameras, bookmarks: [{ id: 'cb1', name: 'Hero', ...view }] }, 'Save camera bookmark');
    expect(store.cameras.bookmarks[0].name).toBe('Hero');
    const text = serializeDocument(store.toDocument());
    const back = parseDocument(text);
    expect(back.cameras?.bookmarks[0]).toMatchObject({ id: 'cb1', name: 'Hero', fov: 40 });
    store.undo();
    expect(store.cameras.bookmarks).toHaveLength(0);
    store.redo();
    expect(store.cameras.bookmarks).toHaveLength(1);
    const other = new SceneStore();
    other.load(back);
    expect(other.cameras.bookmarks[0].name).toBe('Hero');
    // a file from before the camera package loads with empty cameras
    const old = JSON.parse(text) as Record<string, unknown>;
    delete old.cameras;
    expect(parseDocument(JSON.stringify(old)).cameras).toBeUndefined();
    // …and nothing is written for default cameras (keeps files and share links short)
    expect(
      (JSON.parse(serializeDocument(new SceneStore().toDocument())) as { cameras?: unknown }).cameras,
    ).toBeUndefined();
    const fresh = new SceneStore();
    fresh.load(parseDocument(JSON.stringify(old)));
    expect(fresh.cameras).toEqual(emptyCameras());
  });
});

describe('minimap geometry', () => {
  it('maps the centre to the middle, north (−Z) up, and round-trips at any rotation', () => {
    const v = new MapView(10, -4, 25, 200, 0);
    expect(v.toMap(10, -4)).toEqual([100, 100]);
    const north = v.toMap(10, -4 - 25);
    expect(north[0]).toBeCloseTo(100, 9);
    expect(north[1]).toBeCloseTo(0, 9);
    const east = v.toMap(10 + 25, -4);
    expect(east[0]).toBeCloseTo(200, 9);
    for (const rot of [0, 0.7, -2.2, Math.PI]) {
      v.rotation = rot;
      const [x, z] = v.toWorld(...v.toMap(3.3, 7.1));
      expect(x).toBeCloseTo(3.3, 9);
      expect(z).toBeCloseTo(7.1, 9);
    }
  });

  it('rotate-with-camera puts the camera heading at screen-up', () => {
    for (const psi of [0, Math.PI / 2, 2.4, -1]) {
      const v = new MapView(0, 0, 10, 200, psi - Math.PI);
      const ahead = v.toMap(Math.sin(psi) * 5, Math.cos(psi) * 5);
      expect(ahead[0]).toBeCloseTo(100, 9);
      expect(ahead[1]).toBeCloseTo(50, 9); // 5 m ahead = 50 px above the centre
    }
  });

  it('yaw of a body from its quaternion', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.9);
    expect(yawOf([q.x, q.y, q.z, q.w])).toBeCloseTo(0.9, 9);
  });
});
