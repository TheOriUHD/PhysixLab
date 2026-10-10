/**
 * `car.wheel` (VZ-42): tyre with sidewall and tread, rim with twin spokes, hub, lug nuts and a drilled brake disc.
 * The skin is authored around the cylinder body's local Y axis (the axle) and lives on the physics wheel body, so
 * spin and steering come from the simulation. The outer face points to world +Z or −Z depending on which side of
 * the car the wheel was authored on (the template mirrors nothing: both sides use the same rotated cylinder).
 */
import {
  CylinderGeometry,
  DataTexture,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  RepeatWrapping,
  SphereGeometry,
  UnsignedByteType,
  Vector2,
} from 'three';
import type { BufferGeometry } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Batch, Lease, tm } from './carKit';
import type { SkinDef, SkinInstance } from './types';

export const TYRE_RADIUS = 0.36;

/** Chevron tread bump map, one repeat per tread block (tiny, generated: no assets). */
function treadTexture(): DataTexture {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const v = j / n;
      const d = (((u + Math.abs(v - 0.5) * 0.9) % 1) + 1) % 1;
      const groove = d < 0.2 || Math.abs(v - 0.5) < 0.02;
      const val = groove ? 40 : 235;
      const o = (j * n + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = val;
      data[o + 3] = 255;
    }
  const t = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(28, 1);
  t.needsUpdate = true;
  return t;
}

function tyreGeometry(): BufferGeometry {
  // (radius, height along the axle), bead to bead. Three circumferential grooves in the tread.
  const half: [number, number][] = [
    [0.36, 0.0],
    [0.36, 0.03],
    [0.352, 0.034],
    [0.352, 0.05],
    [0.36, 0.054],
    [0.36, 0.088],
    [0.352, 0.092],
    [0.352, 0.106],
    [0.358, 0.11],
    [0.357, 0.122],
    [0.348, 0.138],
    [0.332, 0.147],
    [0.305, 0.151],
    [0.272, 0.15],
    [0.245, 0.143],
    [0.233, 0.128],
    [0.231, 0.112],
  ];
  const pts: Vector2[] = [];
  for (let i = half.length - 1; i >= 1; i--) pts.push(new Vector2(half[i][0], -half[i][1]));
  for (let i = 0; i < half.length; i++) pts.push(new Vector2(half[i][0], half[i][1]));
  const g = new LatheGeometry(pts, 44);
  // Tread bump coordinate: across the tyre by height along the axle.
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setY(i, (pos.getY(i) + 0.15) / 0.3);
  return g;
}

function buildShared(lease: Lease) {
  const tread = lease.get('wheel:tyreMat', () => {
    const tex = treadTexture();
    const m = new MeshStandardMaterial({
      color: 0x1d1e22,
      roughness: 0.92,
      metalness: 0,
      bumpMap: tex,
      bumpScale: 2.2,
    });
    const dispose = m.dispose.bind(m);
    m.dispose = () => {
      tex.dispose();
      dispose();
    };
    return m;
  });
  const rimMat = lease.get(
    'wheel:rimMat',
    () => new MeshStandardMaterial({ color: 0xc9cdd3, metalness: 1, roughness: 0.26 }),
  );
  const darkMat = lease.get(
    'wheel:darkMat',
    () => new MeshStandardMaterial({ color: 0x15161a, metalness: 0.4, roughness: 0.6 }),
  );
  const discMat = lease.get(
    'wheel:discMat',
    () => new MeshStandardMaterial({ color: 0x8e9197, metalness: 0.9, roughness: 0.42 }),
  );
  const tyreGeo = lease.get('wheel:tyreGeo', tyreGeometry);
  const rimGeo = lease.get('wheel:rimGeo', () => {
    const b = new Batch();
    // Barrel with rolled lips.
    b.add(
      new LatheGeometry(
        [
          new Vector2(0.238, 0.122),
          new Vector2(0.23, 0.112),
          new Vector2(0.224, 0.095),
          new Vector2(0.224, -0.09),
          new Vector2(0.23, -0.108),
          new Vector2(0.238, -0.12),
        ].reverse(),
        48,
      ),
    );
    // Twin spokes, slightly dished toward the car.
    const spoke = new RoundedBoxGeometry(0.2, 0.026, 0.034, 1, 0.008);
    const m = new Matrix4();
    for (let k = 0; k < 5; k++)
      for (const o of [-0.1, 0.1]) {
        const a = (k / 5) * Math.PI * 2 + o;
        b.add(spoke, tm(0, 0.072, 0, 0, a, 0).multiply(tm(0.14, 0, 0, 0, 0, -0.1, 1, 1, 1, m)));
      }
    spoke.dispose();
    // Hub cap, dome and lug nuts.
    const cap = new CylinderGeometry(0.066, 0.07, 0.045, 24);
    b.add(cap, tm(0, 0.085, 0));
    cap.dispose();
    const dome = new SphereGeometry(0.04, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    b.add(dome, tm(0, 0.1, 0, 0, 0, 0, 1, 0.6, 1));
    dome.dispose();
    const nut = new CylinderGeometry(0.0095, 0.0095, 0.02, 6);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + 0.3;
      b.add(nut, tm(Math.cos(a) * 0.043, 0.103, Math.sin(a) * 0.043));
    }
    nut.dispose();
    return b.bake();
  });
  const darkGeo = lease.get('wheel:darkGeo', () => {
    const b = new Batch();
    const back = new CylinderGeometry(0.226, 0.226, 0.012, 40);
    b.add(back, tm(0, -0.078, 0));
    back.dispose();
    return b.bake();
  });
  const discGeo = lease.get('wheel:discGeo', () => {
    const b = new Batch();
    const disc = new CylinderGeometry(0.172, 0.172, 0.016, 40);
    b.add(disc, tm(0, -0.02, 0));
    disc.dispose();
    const hat = new CylinderGeometry(0.075, 0.085, 0.04, 24);
    b.add(hat, tm(0, -0.03, 0));
    hat.dispose();
    return b.bake();
  });
  const holesGeo = lease.get('wheel:holesGeo', () => {
    const b = new Batch();
    const hole = new CylinderGeometry(0.0105, 0.0105, 0.004, 6);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      b.add(hole, tm(Math.cos(a) * 0.128, -0.0115, Math.sin(a) * 0.128));
    }
    hole.dispose();
    return b.bake();
  });
  return { tread, rimMat, darkMat, discMat, tyreGeo, rimGeo, darkGeo, discGeo, holesGeo };
}

export const carWheelSkin: SkinDef = {
  id: 'car.wheel',
  label: 'Car wheel (tyre, rim, brake disc)',
  shapes: ['cylinder'],
  build(_size, _spec, def): SkinInstance {
    const lease = new Lease();
    const s = buildShared(lease);
    const root = new Group();
    root.name = 'car-wheel';
    const mk = (g: BufferGeometry, m: MeshStandardMaterial, shadow: boolean) => {
      const mesh = new Mesh(g, m);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      mesh.userData.skinPart = true;
      root.add(mesh);
    };
    mk(s.tyreGeo, s.tread, true);
    mk(s.rimGeo, s.rimMat, false);
    mk(s.darkGeo, s.darkMat, false);
    mk(s.discGeo, s.discMat, false);
    mk(s.holesGeo, s.darkMat, false);
    // The authored z of the wheel decides which face is the outer one (left side wheels face −Z).
    if (def.position[2] < 0) root.rotation.x = Math.PI;
    return {
      root,
      update() {
        /* spin and steering come from the physics body */
      },
      dispose() {
        root.clear();
        lease.release();
      },
    };
  },
};
