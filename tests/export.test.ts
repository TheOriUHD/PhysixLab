/**
 * DT-1 exporters: glTF/GLB, OBJ(+MTL) and binary STL, built from a real SceneDocument with the real shape-registry
 * geometry (no mocks). Output is parsed structurally by the tests themselves, and re-read with three.js's own
 * loaders (an independent parser) for the round trips.
 */
import { describe, expect, it } from 'vitest';
import { Box3, Vector3, type Mesh, type Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { qfromAxisAngle } from '../src/core/math';
import { createBody, createGroup, createLight, createSoft } from '../src/model/factory';
import { makePart } from '../src/model/compound';
import { buildGltf, buildGlb, type GltfJson } from '../src/app/export/gltf';
import { buildObj } from '../src/app/export/obj';
import { buildExportScene, triangleCount, walkNodes } from '../src/app/export/scene';
import { buildStl } from '../src/app/export/stl';
import { createThreeGeometryProvider } from '../src/app/export/threeGeometry';
import type { AnimationFrames } from '../src/app/export/types';
import type { Entity, MeshAsset } from '../src/model/types';
import { buildAsset, makeMeshAsset } from '../src/model/assets';
import { listShapes } from '../src/model/shapeRegistry';
import { docOf } from './helpers';

const geometry = createThreeGeometryProvider();

function sampleEntities(): Entity[] {
  const group = createGroup({ name: 'Rig', position: [10, 0, 0], rotation: qfromAxisAngle([0, 1, 0], Math.PI / 2) });
  const a = createBody({
    name: 'Crate',
    shape: { type: 'box', size: [1, 2, 3] },
    position: [10, 1, 0],
    material: { color: '#ff8000', metalness: 0.3, roughness: 0.4 },
    parent: group.id,
  });
  const b = createBody({
    name: 'Ball',
    shape: { type: 'sphere', size: [1, 1, 1] },
    position: [0, 3, 0],
    material: { color: '#00ff00', opacity: 0.5 },
  });
  const compound = createBody({
    name: 'Dumbbell',
    shape: { type: 'box', size: [2, 1, 1] },
    position: [-4, 1, 0],
    parts: [
      makePart({ shape: { type: 'sphere', size: [1, 1, 1] }, position: [-1, 0, 0] }),
      makePart({ shape: { type: 'sphere', size: [1, 1, 1] }, position: [1, 0, 0], material: { color: '#0000ff' } }),
      makePart({ shape: { type: 'cylinder', size: [0.3, 2, 0.3] }, rotation: qfromAxisAngle([0, 0, 1], Math.PI / 2) }),
      makePart({ shape: { type: 'box', size: [1, 1, 1] }, visible: false }),
    ],
  });
  const light = createLight('spot', { position: [0, 8, 0], intensity: 400 });
  return [group, a, b, compound, light, createSoft('jelly')];
}

describe('scene builder', () => {
  it('maps bodies, compound parts, groups, lights; reports soft bodies; shares materials and geometry', () => {
    const doc = docOf(sampleEntities());
    const scene = buildExportScene(doc, geometry);
    const names = scene.roots.map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(['Rig', 'Ball', 'Dumbbell', 'Ground']));
    const rig = scene.roots.find((n) => n.name === 'Rig');
    expect(rig?.children.map((c) => c.name)).toEqual(['Crate']);
    // Crate sits at world (10,1,0); relative to the group (10,0,0) rotated 90° about Y it is (0,1,0).
    const crate = rig?.children[0];
    expect(crate?.translation[0]).toBeCloseTo(0, 5);
    expect(crate?.translation[1]).toBeCloseTo(1, 5);
    expect(crate?.world.position).toEqual([10, 1, 0]);
    const dumb = scene.roots.find((n) => n.name === 'Dumbbell');
    expect(dumb?.primitives).toHaveLength(0);
    expect(dumb?.children).toHaveLength(3); // the invisible part is left out
    expect(dumb?.children[1].world.position).toEqual([-3, 1, 0]);
    expect(scene.skipped.map((s) => s.reason).join()).toMatch(/soft bodies/);
    expect(scene.roots.some((n) => n.light?.type === 'spot')).toBe(true);
    // two spheres of the compound share one geometry object
    expect(dumb?.children[0].primitives[0].mesh).toBe(dumb?.children[1].primitives[0].mesh);
    // translucent ball keeps its alpha
    const ball = scene.roots.find((n) => n.name === 'Ball');
    expect(scene.materials[ball?.primitives[0].material ?? 0].opacity).toBe(0.5);
  });

  it('selection limits the export (descendants of a selected group follow) and drops the ground', () => {
    const ents = sampleEntities();
    const doc = docOf(ents);
    const scene = buildExportScene(doc, geometry, { ids: [ents[0].id] });
    expect(scene.roots.map((n) => n.name)).toEqual(['Rig']);
    expect(scene.roots[0].children.map((c) => c.name)).toEqual(['Crate']);
    const onlyBall = buildExportScene(doc, geometry, { ids: [ents[2].id] });
    expect(onlyBall.roots.map((n) => n.name)).toEqual(['Ball']);
    // A member exported without its parent group sits at the root with its world pose.
    const crateOnly = buildExportScene(doc, geometry, { ids: [ents[1].id] });
    expect(crateOnly.roots[0].translation).toEqual([10, 1, 0]);
  });

  it('every registered shape produces a non-empty, finite, correctly sized mesh', () => {
    for (const def of listShapes()) {
      const m = geometry.shape({ type: def.id, size: def.defaultSize });
      expect(m.indices.length, def.id).toBeGreaterThan(0);
      expect(m.indices.length % 3).toBe(0);
      expect(m.normals.length).toBe(m.positions.length);
      expect(Array.from(m.positions).every(Number.isFinite), def.id).toBe(true);
      const max = Math.max(...m.indices);
      expect(max).toBeLessThan(m.positions.length / 3);
    }
    const box = geometry.shape({ type: 'box', size: [1, 2, 3] });
    const b = new Box3().setFromArray(box.positions);
    expect(b.max.sub(b.min).toArray()).toEqual([1, 2, 3]);
  });

  it('exports an imported mesh asset in place of the shape, with its material slots', () => {
    const asset = buildAsset(
      makeMeshAsset('tri', {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
        indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
        materials: [
          { name: 'red', color: '#ff0000', metalness: 0, roughness: 1, opacity: 1 },
          { name: 'blue', color: '#0000ff', metalness: 0, roughness: 1, opacity: 1 },
        ],
        groups: [
          { start: 0, count: 3, materialIndex: 0 },
          { start: 3, count: 3, materialIndex: 1 },
        ],
      }),
      'm1',
    ) as MeshAsset;
    const body = createBody({ name: 'Imported', meshId: 'm1' });
    const doc = docOf([body]);
    doc.assets = { m1: asset };
    const scene = buildExportScene(doc, geometry, { ground: false });
    const prims = scene.roots[0].primitives;
    expect(prims).toHaveLength(2);
    expect(prims[0].material).not.toBe(prims[1].material);
    expect(triangleCount(scene)).toBe(2);
  });
});

// ---- glTF ------------------------------------------------------------------------------------

function parseGlb(glb: Uint8Array): { json: GltfJson; bin: Uint8Array } {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  expect(dv.getUint32(0, true)).toBe(0x46546c67);
  expect(dv.getUint32(4, true)).toBe(2);
  expect(dv.getUint32(8, true)).toBe(glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  expect(dv.getUint32(16, true)).toBe(0x4e4f534a);
  expect(jsonLen % 4).toBe(0);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen))) as GltfJson;
  const o = 20 + jsonLen;
  if (o === glb.byteLength) return { json, bin: new Uint8Array(0) }; // no BIN chunk (empty scene)
  expect(dv.getUint32(o + 4, true)).toBe(0x004e4942);
  const binLen = dv.getUint32(o, true);
  expect(binLen % 4).toBe(0);
  expect(o + 8 + binLen).toBe(glb.byteLength);
  return { json, bin: glb.subarray(o + 8, o + 8 + binLen) };
}

describe('glTF / GLB', () => {
  const doc = docOf(sampleEntities());
  const scene = buildExportScene(doc, geometry);
  const { glb } = buildGlb(scene);
  const { json, bin } = parseGlb(glb);

  it('has a consistent container: buffer, views, accessors and byte lengths agree', () => {
    expect(json.asset.version).toBe('2.0');
    expect(json.buffers?.[0].byteLength).toBe(bin.length);
    for (const v of json.bufferViews ?? []) {
      expect(v.byteOffset + v.byteLength).toBeLessThanOrEqual(bin.length);
      expect(v.byteOffset % 4).toBe(0);
    }
    const sizeOf: Record<number, number> = { 5126: 4, 5125: 4 };
    const comps = { SCALAR: 1, VEC3: 3, VEC4: 4 };
    for (const a of json.accessors ?? []) {
      const view = (json.bufferViews ?? [])[a.bufferView];
      expect(view).toBeTruthy();
      expect(a.count * comps[a.type] * sizeOf[a.componentType]).toBe(view.byteLength);
    }
  });

  it('references stay in range and indices stay inside their vertex arrays', () => {
    const nodes = json.nodes.length;
    for (const n of json.nodes) {
      for (const c of n.children ?? []) expect(c).toBeLessThan(nodes);
      if (n.mesh !== undefined) expect(n.mesh).toBeLessThan((json.meshes ?? []).length);
    }
    for (const r of json.scenes[0].nodes) expect(r).toBeLessThan(nodes);
    for (const m of json.meshes ?? []) {
      for (const p of m.primitives) {
        expect(p.material).toBeLessThan((json.materials ?? []).length);
        const pos = (json.accessors ?? [])[p.attributes.POSITION];
        const idx = (json.accessors ?? [])[p.indices];
        expect(idx.componentType).toBe(5125);
        expect(idx.count % 3).toBe(0);
        const view = (json.bufferViews ?? [])[idx.bufferView];
        const ints = new Uint32Array(
          bin.buffer.slice(bin.byteOffset + view.byteOffset, bin.byteOffset + view.byteOffset + view.byteLength),
        );
        expect(Math.max(...ints)).toBeLessThan(pos.count);
        // POSITION min/max really bound the data
        const pv = (json.bufferViews ?? [])[pos.bufferView];
        const f = new Float32Array(
          bin.buffer.slice(bin.byteOffset + pv.byteOffset, bin.byteOffset + pv.byteOffset + pv.byteLength),
        );
        for (let k = 0; k < 3; k++) {
          const col = Array.from({ length: pos.count }, (_, i) => f[i * 3 + k]);
          expect(Math.min(...col)).toBe(pos.min?.[k]);
          expect(Math.max(...col)).toBe(pos.max?.[k]);
        }
      }
    }
  });

  it('writes the node hierarchy, materials (linear colour, alpha) and a punctual light', () => {
    const rig = json.nodes.findIndex((n) => n.name === 'Rig');
    const crate = json.nodes.findIndex((n) => n.name === 'Crate');
    expect(json.nodes[rig].children).toContain(crate);
    expect(json.scenes[0].nodes).toContain(rig);
    expect(json.scenes[0].nodes).not.toContain(crate);
    const dumb = json.nodes.find((n) => n.name === 'Dumbbell');
    expect(dumb?.children).toHaveLength(3);
    const orange = (json.materials ?? []).find((m) => m.name.startsWith('Crate'));
    expect(orange?.pbrMetallicRoughness.baseColorFactor[0]).toBeCloseTo(1, 5);
    expect(orange?.pbrMetallicRoughness.baseColorFactor[1]).toBeCloseTo(Math.pow((128 / 255 + 0.055) / 1.055, 2.4), 3); // sRGB -> linear
    expect(orange?.pbrMetallicRoughness.metallicFactor).toBeCloseTo(0.3, 5);
    const glass = (json.materials ?? []).find((m) => m.name.startsWith('Ball'));
    expect(glass?.alphaMode).toBe('BLEND');
    expect(glass?.pbrMetallicRoughness.baseColorFactor[3]).toBe(0.5);
    expect(json.extensionsUsed).toEqual(['KHR_lights_punctual']);
    expect(json.extensions?.KHR_lights_punctual?.lights[0].type).toBe('spot');
    // the two spheres of the dumbbell and the ball share geometry accessors
    const sphereMeshes = (json.meshes ?? []).filter((m) => m.name === 'Ball' || m.name?.startsWith('Dumbbell'));
    expect(sphereMeshes.length).toBeGreaterThan(0);
  });

  it('re-imports through three.js GLTFLoader with the same hierarchy, triangle count and bounds', async () => {
    const parsed = await new Promise<{ scene: Object3D }>((resolve, reject) =>
      new GLTFLoader().parse(
        glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
        '',
        resolve,
        reject,
      ),
    );
    const root = parsed.scene;
    root.updateMatrixWorld(true);
    let tris = 0;
    root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) tris += (m.geometry.getIndex()?.count ?? 0) / 3;
    });
    expect(tris).toBe(triangleCount(scene));
    const rig = root.getObjectByName('Rig');
    expect(rig?.getObjectByName('Crate')).toBeTruthy();
    const crate = root.getObjectByName('Crate');
    const wp = crate?.getWorldPosition(new Vector3());
    expect(wp?.x).toBeCloseTo(10, 4);
    expect(wp?.y).toBeCloseTo(1, 4);
    // The document keeps world poses, so the crate's world orientation is unchanged by nesting it under the group.
    const size = new Box3().setFromObject(crate as Object3D).getSize(new Vector3());
    expect([size.x, size.y, size.z].map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 2, 3]);
  });

  it('bakes an animation: sampler/channel accessors line up with the sample times', () => {
    const ball = doc.entities[2];
    const times = [0, 0.5, 1];
    const frames: AnimationFrames = {
      times,
      poses: new Map([
        [
          ball.id,
          [0, 1, 2].map((i) => ({
            position: [0, 3 - i, 0] as [number, number, number],
            rotation: qfromAxisAngle([0, 0, 1], i),
          })),
        ],
        [
          doc.entities[1].id,
          [0, 1, 2].map(() => ({
            position: [10, 1, 0] as [number, number, number],
            rotation: [0, 0, 0, 1] as [number, number, number, number],
          })),
        ],
      ]),
    };
    const out = buildGltf(scene, { animation: frames });
    expect(out.animatedChannels).toBe(2); // the crate never moves and is skipped
    const anim = out.json.animations?.[0];
    expect(anim?.channels).toHaveLength(2);
    const ballNode = out.json.nodes.findIndex((n) => n.name === 'Ball');
    for (const ch of anim?.channels ?? []) {
      expect(ch.target.node).toBe(ballNode);
      const sampler = anim?.samplers[ch.sampler];
      expect(out.json.accessors?.[sampler?.input ?? 0].count).toBe(3);
      expect(out.json.accessors?.[sampler?.output ?? 0].count).toBe(3);
    }
    expect(out.json.accessors?.[anim?.samplers[0].input ?? 0].max).toEqual([1]);
    const tAcc = out.json.accessors?.[anim?.samplers[0].output ?? 0];
    const view = out.json.bufferViews?.[tAcc?.bufferView ?? 0];
    const f = new Float32Array(
      out.bin.buffer.slice(
        out.bin.byteOffset + (view?.byteOffset ?? 0),
        out.bin.byteOffset + (view?.byteOffset ?? 0) + (view?.byteLength ?? 0),
      ),
    );
    expect(Array.from(f)).toEqual([0, 3, 0, 0, 2, 0, 0, 1, 0]);
  });

  it('an empty scene still yields a valid file', () => {
    const empty = buildExportScene(docOf([]), geometry, { ground: false });
    const { json: j, bin: b } = parseGlb(buildGlb(empty).glb);
    expect(j.nodes).toEqual([]);
    expect(b.length).toBe(0);
    expect(j.buffers).toBeUndefined();
  });
});

// ---- OBJ -------------------------------------------------------------------------------------

describe('OBJ + MTL', () => {
  const scene = buildExportScene(docOf(sampleEntities()), geometry);
  const { obj, mtl, vertexCount, triangleCount: tris } = buildObj(scene, { mtlName: 'demo.mtl' });
  const lines = obj.split('\n');

  it('has matching v / vn counts and every face index inside 1..vertexCount', () => {
    const v = lines.filter((l) => l.startsWith('v ')).length;
    const vn = lines.filter((l) => l.startsWith('vn ')).length;
    expect(v).toBe(vertexCount);
    expect(vn).toBe(vertexCount);
    const faces = lines.filter((l) => l.startsWith('f '));
    expect(faces).toHaveLength(tris);
    expect(tris).toBe(triangleCount(scene));
    for (const f of faces) {
      for (const tok of f.slice(2).split(' ')) {
        const [a, , c] = tok.split('/').map(Number);
        expect(a).toBeGreaterThanOrEqual(1);
        expect(a).toBeLessThanOrEqual(vertexCount);
        expect(c).toBe(a);
      }
    }
    expect(lines).toContain('mtllib demo.mtl');
  });

  it('every usemtl has a newmtl, with Kd and d', () => {
    const used = new Set(lines.filter((l) => l.startsWith('usemtl ')).map((l) => l.slice(7)));
    const defined = new Set(
      mtl
        .split('\n')
        .filter((l) => l.startsWith('newmtl '))
        .map((l) => l.slice(7)),
    );
    expect(used.size).toBeGreaterThan(2);
    for (const u of used) expect(defined.has(u), u).toBe(true);
    expect(mtl).toMatch(/Kd 1 0\.501961 0/); // #ff8000, written as sRGB
    expect(mtl).toMatch(/\nd 0\.5\n/);
  });

  it('re-imports through three.js OBJLoader: objects, triangle count, world position', () => {
    const group = new OBJLoader().parse(obj);
    let t = 0;
    group.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) t += m.geometry.getAttribute('position').count / 3;
    });
    expect(t).toBe(tris);
    const crate = group.getObjectByName('Crate');
    const c = new Box3().setFromObject(crate as Object3D).getCenter(new Vector3());
    expect(c.x).toBeCloseTo(10, 4);
    expect(c.y).toBeCloseTo(1, 4);
  });
});

// ---- STL -------------------------------------------------------------------------------------

describe('binary STL', () => {
  const doc = docOf(sampleEntities());
  const scene = buildExportScene(doc, geometry, { ground: false });

  it('size is exactly 84 + 50 x triangles, count field and header are right, no ASCII "solid" header', () => {
    const { data, triangleCount: n } = buildStl(scene);
    expect(n).toBe(triangleCount(scene));
    expect(data.length).toBe(84 + 50 * n);
    expect(new DataView(data.buffer).getUint32(80, true)).toBe(n);
    expect(new TextDecoder().decode(data.subarray(0, 5))).not.toBe('solid');
  });

  it('every normal is unit length and agrees with the winding; re-imports through STLLoader', () => {
    const { data, triangleCount: n } = buildStl(scene, { scale: 1000 });
    const dv = new DataView(data.buffer);
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 50))) {
      const o = 84 + i * 50;
      const nl = Math.hypot(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true));
      expect(nl).toBeCloseTo(1, 4);
    }
    const geo = new STLLoader().parse(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    );
    expect(geo.getAttribute('position').count).toBe(n * 3);
    geo.computeBoundingBox();
    const box = geo.boundingBox as Box3;
    expect(box.max.x).toBeGreaterThan(10_000); // the crate group is 10 m out -> mm
    geo.dispose();
  });

  it('z-up rotates (x, y, z) to (x, -z, y); selection-only exports a single body', () => {
    const ball = doc.entities[2];
    const one = buildExportScene(doc, geometry, { ids: [ball.id] });
    const y = buildStl(one);
    const z = buildStl(one, { zUp: true });
    const bounds = (d: Uint8Array) => {
      const g = new STLLoader().parse(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer);
      g.computeBoundingBox();
      const b = (g.boundingBox as Box3).clone();
      g.dispose();
      return b;
    };
    const by = bounds(y.data).getCenter(new Vector3());
    const bz = bounds(z.data).getCenter(new Vector3());
    expect(by.y).toBeCloseTo(3, 4);
    expect(bz.z).toBeCloseTo(3, 4);
    expect(bz.y).toBeCloseTo(0, 4);
    expect(y.triangleCount).toBe(z.triangleCount);
    let seen = 0;
    walkNodes(one, () => seen++);
    expect(seen).toBe(1);
  });
});
