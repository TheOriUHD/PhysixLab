/**
 * glTF 2.0 / GLB writer. Meshes are written once per distinct (geometry, material) list and shared by every node
 * that uses them; positions carry min/max as the spec requires; lights use KHR_lights_punctual; an optional baked
 * animation becomes translation / rotation channels on the entity nodes (LINEAR sampler, quaternion slerp is the
 * viewer's job). Coordinates are metres, Y up, right handed — the same as the scene.
 */
import { qnorm, type Quat } from '../../core/math';
import { relativePose, walkNodes } from './scene';
import type { AnimationFrames, ExportMaterial, ExportNode, ExportScene, MeshData, Pose } from './types';

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_INT = 5125;

/** Loosely typed glTF root — the writer only emits what the spec allows; tests parse it back structurally. */
export interface GltfJson {
  asset: { version: string; generator: string; extras?: Record<string, unknown> };
  scene: number;
  scenes: { name?: string; nodes: number[] }[];
  nodes: GltfNode[];
  // The five arrays below are omitted when empty (the spec forbids empty arrays).
  meshes?: { name?: string; primitives: GltfPrimitive[] }[];
  materials?: GltfMaterial[];
  accessors?: GltfAccessor[];
  bufferViews?: { buffer: number; byteOffset: number; byteLength: number; target?: number }[];
  buffers?: { byteLength: number; uri?: string }[];
  animations?: {
    name: string;
    samplers: { input: number; output: number; interpolation: string }[];
    channels: GltfChannel[];
  }[];
  extensionsUsed?: string[];
  extensions?: { KHR_lights_punctual?: { lights: GltfLight[] } };
}
export interface GltfNode {
  name: string;
  children?: number[];
  mesh?: number;
  translation?: number[];
  rotation?: number[];
  extensions?: { KHR_lights_punctual?: { light: number } };
}
export interface GltfPrimitive {
  attributes: { POSITION: number; NORMAL: number };
  indices: number;
  material: number;
  mode: 4;
}
export interface GltfMaterial {
  name: string;
  pbrMetallicRoughness: { baseColorFactor: number[]; metallicFactor: number; roughnessFactor: number };
  alphaMode?: 'BLEND';
  doubleSided?: boolean;
}
export interface GltfAccessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC3' | 'VEC4';
  min?: number[];
  max?: number[];
}
export interface GltfChannel {
  sampler: number;
  target: { node: number; path: 'translation' | 'rotation' };
}
export interface GltfLight {
  type: 'point' | 'spot' | 'directional';
  name?: string;
  color: number[];
  intensity: number;
  range?: number;
  spot?: { innerConeAngle: number; outerConeAngle: number };
}

export interface GltfOptions {
  /** Baked animation: world poses of entities over time (entities whose pose never changes are skipped). */
  animation?: AnimationFrames;
  /** Name of the animation clip. */
  animationName?: string;
}

export interface GltfResult {
  json: GltfJson;
  /** The single binary buffer (already padded to a multiple of 4). */
  bin: Uint8Array;
  /** Number of animation channels written (0 for a static scene). */
  animatedChannels: number;
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

class BinWriter {
  private chunks: { data: Uint8Array }[] = [];
  length = 0;

  /** Append bytes (4-byte aligned) and return the byte offset. */
  add(data: Uint8Array): { offset: number; length: number } {
    const offset = this.length;
    const padded = (data.byteLength + 3) & ~3;
    const copy = new Uint8Array(padded);
    copy.set(data);
    this.chunks.push({ data: copy });
    this.length += padded;
    return { offset, length: data.byteLength };
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c.data, o);
      o += c.data.length;
    }
    return out;
  }
}

const bytesOf = (a: Float32Array | Uint32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

function materialJson(m: ExportMaterial): GltfMaterial {
  const [r, g, b] = m.color;
  const out: GltfMaterial = {
    name: m.name,
    pbrMetallicRoughness: {
      baseColorFactor: [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), m.opacity],
      metallicFactor: m.metalness,
      roughnessFactor: m.roughness,
    },
  };
  if (m.opacity < 0.999) {
    out.alphaMode = 'BLEND';
    out.doubleSided = true;
  }
  return out;
}

const samePose = (a: Pose, b: Pose, eps = 1e-6): boolean =>
  Math.abs(a.position[0] - b.position[0]) < eps &&
  Math.abs(a.position[1] - b.position[1]) < eps &&
  Math.abs(a.position[2] - b.position[2]) < eps &&
  Math.abs(a.rotation[0] - b.rotation[0]) < eps &&
  Math.abs(a.rotation[1] - b.rotation[1]) < eps &&
  Math.abs(a.rotation[2] - b.rotation[2]) < eps &&
  Math.abs(a.rotation[3] - b.rotation[3]) < eps;

export function buildGltf(scene: ExportScene, options: GltfOptions = {}): GltfResult {
  const bin = new BinWriter();
  const meshes: NonNullable<GltfJson['meshes']> = [];
  const accessors: NonNullable<GltfJson['accessors']> = [];
  const bufferViews: NonNullable<GltfJson['bufferViews']> = [];
  const json: GltfJson = {
    asset: { version: '2.0', generator: 'PhysicsLab', extras: { name: scene.name } },
    scene: 0,
    scenes: [{ name: scene.name, nodes: [] }],
    nodes: [],
  };
  const materials = scene.materials.map(materialJson);

  const addView = (data: Uint8Array, target?: number): number => {
    const { offset, length } = bin.add(data);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: length, ...(target ? { target } : {}) });
    return bufferViews.length - 1;
  };
  const addAccessor = (a: GltfAccessor): number => accessors.push(a) - 1;

  // Geometry accessors are shared per MeshData object.
  const geo = new Map<MeshData, { position: number; normal: number; indices: number }>();
  const geometryOf = (m: MeshData) => {
    let g = geo.get(m);
    if (g) return g;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = m.positions[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    const pv = addView(bytesOf(m.positions), ARRAY_BUFFER);
    const nv = addView(bytesOf(m.normals), ARRAY_BUFFER);
    const iv = addView(bytesOf(m.indices), ELEMENT_ARRAY_BUFFER);
    g = {
      position: addAccessor({
        bufferView: pv,
        componentType: FLOAT,
        count: m.positions.length / 3,
        type: 'VEC3',
        min,
        max,
      }),
      normal: addAccessor({ bufferView: nv, componentType: FLOAT, count: m.normals.length / 3, type: 'VEC3' }),
      indices: addAccessor({ bufferView: iv, componentType: UNSIGNED_INT, count: m.indices.length, type: 'SCALAR' }),
    };
    geo.set(m, g);
    return g;
  };

  // Meshes shared by identical primitive lists.
  const meshIds = new Map<string, number>();
  const meshObjIds = new Map<MeshData, number>();
  const objId = (m: MeshData): number => {
    let i = meshObjIds.get(m);
    if (i === undefined) {
      i = meshObjIds.size;
      meshObjIds.set(m, i);
    }
    return i;
  };
  const meshFor = (n: ExportNode): number => {
    const key = n.primitives.map((p) => `${objId(p.mesh)}:${p.material}`).join('|');
    let id = meshIds.get(key);
    if (id === undefined) {
      id = meshes.length;
      meshes.push({
        name: n.name,
        primitives: n.primitives.map((p) => {
          const g = geometryOf(p.mesh);
          return {
            attributes: { POSITION: g.position, NORMAL: g.normal },
            indices: g.indices,
            material: p.material,
            mode: 4,
          };
        }),
      });
      meshIds.set(key, id);
    }
    return id;
  };

  const lights: GltfLight[] = [];
  const nodeIndex = new Map<ExportNode, number>();
  const entityNode = new Map<string, number>();
  const emit = (n: ExportNode): number => {
    const idx = json.nodes.length;
    const node: GltfNode = { name: n.name };
    json.nodes.push(node);
    nodeIndex.set(n, idx);
    if (n.entityId) entityNode.set(n.entityId, idx);
    const t = n.translation;
    if (t[0] !== 0 || t[1] !== 0 || t[2] !== 0) node.translation = [t[0], t[1], t[2]];
    const q = n.rotation;
    if (q[0] !== 0 || q[1] !== 0 || q[2] !== 0 || q[3] !== 1) node.rotation = [q[0], q[1], q[2], q[3]];
    if (n.primitives.length > 0) node.mesh = meshFor(n);
    if (n.light) {
      const l = n.light;
      const gl: GltfLight = {
        type: l.type,
        name: n.name,
        color: l.color.map(srgbToLinear),
        intensity: l.intensity,
      };
      if (l.type !== 'directional' && l.range > 0) gl.range = l.range;
      if (l.type === 'spot') {
        gl.spot = { innerConeAngle: l.angle * (1 - l.penumbra), outerConeAngle: l.angle };
      }
      lights.push(gl);
      node.extensions = { KHR_lights_punctual: { light: lights.length - 1 } };
    }
    if (n.children.length > 0) node.children = n.children.map(emit);
    return idx;
  };
  json.scenes[0].nodes = scene.roots.map(emit);

  if (lights.length > 0) {
    json.extensionsUsed = ['KHR_lights_punctual'];
    json.extensions = { KHR_lights_punctual: { lights } };
  }

  // ---- baked animation ----------------------------------------------------------------------
  let channels = 0;
  const anim = options.animation;
  if (anim && anim.times.length >= 2) {
    const parentWorld = new Map<ExportNode, Pose | null>();
    walkNodes(scene, (n, parent) => parentWorld.set(n, parent ? parent.world : null));
    const nodeByEntity = new Map<string, ExportNode>();
    walkNodes(scene, (n) => {
      if (n.entityId) nodeByEntity.set(n.entityId, n);
    });

    const timeAccessor = addAccessor({
      bufferView: addView(bytesOf(Float32Array.from(anim.times))),
      componentType: FLOAT,
      count: anim.times.length,
      type: 'SCALAR',
      min: [anim.times[0]],
      max: [anim.times[anim.times.length - 1]],
    });
    const samplers: NonNullable<GltfJson['animations']>[number]['samplers'] = [];
    const chans: GltfChannel[] = [];
    for (const [id, poses] of anim.poses) {
      const node = nodeByEntity.get(id);
      const idx = entityNode.get(id);
      if (!node || idx === undefined || poses.length !== anim.times.length) continue;
      if (poses.every((p) => samePose(p, poses[0]))) continue; // never moves
      const parent = parentWorld.get(node) ?? null;
      const trans = new Float32Array(poses.length * 3);
      const rots = new Float32Array(poses.length * 4);
      let prev: Quat | null = null;
      poses.forEach((p, i) => {
        const rel = relativePose(parent, p);
        trans.set(rel.translation, i * 3);
        // Keep consecutive quaternions in the same hemisphere so interpolation takes the short way round.
        let q: Quat = qnorm(rel.rotation);
        if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) {
          q = [-q[0], -q[1], -q[2], -q[3]];
        }
        prev = q;
        rots.set(q, i * 4);
      });
      const tAcc = addAccessor({
        bufferView: addView(bytesOf(trans)),
        componentType: FLOAT,
        count: poses.length,
        type: 'VEC3',
      });
      const rAcc = addAccessor({
        bufferView: addView(bytesOf(rots)),
        componentType: FLOAT,
        count: poses.length,
        type: 'VEC4',
      });
      samplers.push({ input: timeAccessor, output: tAcc, interpolation: 'LINEAR' });
      chans.push({ sampler: samplers.length - 1, target: { node: idx, path: 'translation' } });
      samplers.push({ input: timeAccessor, output: rAcc, interpolation: 'LINEAR' });
      chans.push({ sampler: samplers.length - 1, target: { node: idx, path: 'rotation' } });
    }
    if (chans.length > 0) {
      json.animations = [{ name: options.animationName ?? 'Simulation', samplers, channels: chans }];
      channels = chans.length;
    }
  }

  const binary = bin.finish();
  if (meshes.length > 0) json.meshes = meshes;
  if (materials.length > 0) json.materials = materials;
  if (accessors.length > 0) json.accessors = accessors;
  if (bufferViews.length > 0) json.bufferViews = bufferViews;
  if (binary.length > 0) json.buffers = [{ byteLength: binary.length }];
  return { json, bin: binary, animatedChannels: channels };
}

/** Pack JSON + binary chunk into a .glb container. */
export function packGlb(json: GltfJson, bin: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = (text.length + 3) & ~3;
  const binLen = (bin.length + 3) & ~3;
  const hasBin = bin.length > 0;
  const total = 12 + 8 + jsonLen + (hasBin ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLen);
  if (hasBin) {
    const o = 20 + jsonLen;
    dv.setUint32(o, binLen, true);
    dv.setUint32(o + 4, 0x004e4942, true); // "BIN\0"
    out.set(bin, o + 8);
  }
  return out;
}

/** The whole thing in one call. */
export function buildGlb(scene: ExportScene, options: GltfOptions = {}): { glb: Uint8Array; animatedChannels: number } {
  const { json, bin, animatedChannels } = buildGltf(scene, options);
  return { glb: packGlb(json, bin), animatedChannels };
}
