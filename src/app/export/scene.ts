/**
 * `buildExportScene`: the SceneDocument (+ a geometry provider) -> a neutral node tree the writers share.
 *
 *  - every body becomes a node at its world pose whose primitives are the body's shape (or its imported mesh), or —
 *    for a compound body — one child node per visible collider part;
 *  - groups (and any other entity a member points at through `parent`) become parent nodes. The document stores the
 *    members' *world* poses, so a member's local transform is derived (inverse of the parent's world pose);
 *  - lights become light nodes; joints, paths and soft bodies carry no triangles of ours and are reported in `skipped`
 *    (soft bodies) or left out silently (joints, paths — they are editor helpers).
 * Pure TypeScript: no three.js, no DOM.
 */
import { qconj, qmul, qnorm, qrot, vadd, vsub, type Quat, type Vec3 } from '../../core/math';
import { decodeMesh } from '../../model/assets';
import { isCompound, partMaterial } from '../../model/compound';
import { withDescendants } from '../../model/groups';
import type { BodyEntity, Entity, LightEntity, MaterialSpec, MeshAsset, SceneDocument } from '../../model/types';
import type {
  ExportLight,
  ExportMaterial,
  ExportNode,
  ExportPrimitive,
  ExportScene,
  GeometryProvider,
  MeshData,
  Pose,
  SceneExportOptions,
} from './types';

/** `#rrggbb` (or `#rgb`) -> sRGB 0..1; anything unparsable becomes mid grey. */
export function parseHexColor(hex: string): Vec3 {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.5, 0.5, 0.5];
  let s = m[1];
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** Pose of a node given the world pose of its parent: the parent's inverse applied to the child's world pose. */
export function relativePose(parent: Pose | null, world: Pose): { translation: Vec3; rotation: Quat } {
  if (!parent) return { translation: [...world.position], rotation: qnorm(world.rotation) };
  const inv = qconj(parent.rotation);
  return {
    translation: qrot(inv, vsub(world.position, parent.position)),
    rotation: qnorm(qmul(inv, world.rotation)),
  };
}

/** World pose of a node whose local pose is `local`, under a parent at `parent`. */
export function composePose(parent: Pose, local: Pose): Pose {
  return {
    position: vadd(parent.position, qrot(parent.rotation, local.position)),
    rotation: qnorm(qmul(parent.rotation, local.rotation)),
  };
}

/** Translate a mesh asset into the writers' mesh type (normals computed per vertex when the asset has none). */
export function meshFromAsset(a: MeshAsset): MeshData {
  const d = decodeMesh(a);
  const normals = d.normals ? Float32Array.from(d.normals) : computeNormals(d.positions, d.indices);
  return { positions: Float32Array.from(d.positions), normals, indices: Uint32Array.from(d.indices) };
}

/** Area-weighted smooth vertex normals. */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const n = new Float32Array(positions.length);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3,
      b = indices[t + 1] * 3,
      c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      n[i] += nx;
      n[i + 1] += ny;
      n[i + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

class MaterialTable {
  readonly list: ExportMaterial[] = [];
  private byKey = new Map<string, number>();

  get(m: ExportMaterial): number {
    const key = `${m.color.map(round6).join(',')}|${round6(m.metalness)}|${round6(m.roughness)}|${round6(m.opacity)}`;
    let i = this.byKey.get(key);
    if (i === undefined) {
      i = this.list.length;
      this.list.push({ ...m, name: `${m.name || 'material'}_${i}` });
      this.byKey.set(key, i);
    }
    return i;
  }
}

/** The surface a body (or one of its parts) is drawn with, as the viewport shows it (ghosts and sensors are see-through). */
function surface(name: string, m: MaterialSpec, ghostly: boolean): ExportMaterial {
  return {
    name,
    color: parseHexColor(m.color),
    metalness: m.metalness,
    roughness: m.roughness,
    opacity: ghostly ? Math.min(m.opacity, 0.35) : m.opacity,
  };
}

function lightOf(l: LightEntity): ExportLight | null {
  if (l.lightType === 'area') return null;
  return {
    type: l.lightType,
    color: parseHexColor(l.color),
    intensity: l.intensity,
    range: l.range,
    angle: l.angle,
    penumbra: l.penumbra,
  };
}

/**
 * Build the node tree. `ids` limits the export to those entities plus the descendants of selected groups; a member
 * whose parent is not exported is attached at the root with its world pose.
 */
export function buildExportScene(
  doc: SceneDocument,
  geometry: GeometryProvider,
  options: SceneExportOptions = {},
): ExportScene {
  const { ground = true, includeHidden = false, lights = true } = options;
  const materials = new MaterialTable();
  const skipped: ExportScene['skipped'] = [];
  const wanted = options.ids ? withDescendants(doc.entities, options.ids) : null;
  const byId = new Map<string, Entity>(doc.entities.map((e) => [e.id, e]));

  const include = (e: Entity): boolean => {
    if (wanted && !wanted.has(e.id)) return false;
    if (e.kind === 'joint' || e.kind === 'path') return false;
    if (!includeHidden && e.hidden) return false;
    return true;
  };

  const primitivesOfBody = (b: BodyEntity): ExportPrimitive[] => {
    if (b.meshId) {
      const a = doc.assets[b.meshId];
      if (a && a.kind === 'mesh') {
        const mesh = meshFromAsset(a);
        const slots = a.materials ?? [];
        if (a.groups && a.groups.length > 0 && slots.length > 0) {
          const out: ExportPrimitive[] = [];
          for (const g of a.groups) {
            const slot = slots[g.materialIndex] ?? slots[0];
            const sub: MeshData = {
              positions: mesh.positions,
              normals: mesh.normals,
              indices: mesh.indices.slice(g.start, g.start + g.count),
            };
            out.push({
              mesh: sub,
              material: materials.get({
                name: slot.name || b.name,
                color: parseHexColor(slot.color),
                metalness: slot.metalness,
                roughness: slot.roughness,
                opacity: slot.opacity,
              }),
            });
          }
          return out;
        }
        return [{ mesh, material: materials.get(surface(b.name, b.material, b.ghost)) }];
      }
    }
    return [{ mesh: geometry.shape(b.shape), material: materials.get(surface(b.name, b.material, b.ghost)) }];
  };

  const makeBody = (b: BodyEntity): ExportNode => {
    const node: ExportNode = {
      entityId: b.id,
      name: b.name,
      translation: [...b.position],
      rotation: [...b.rotation],
      world: { position: [...b.position], rotation: [...b.rotation] },
      primitives: [],
      children: [],
    };
    if (isCompound(b) && !b.meshId) {
      for (const part of b.parts ?? []) {
        if (part.visible === false) continue;
        node.children.push({
          name: `${b.name} ${part.id}`,
          translation: [...part.position],
          rotation: [...part.rotation],
          world: composePose(node.world, { position: part.position, rotation: part.rotation }),
          primitives: [
            {
              mesh: geometry.shape(part.shape),
              material: materials.get(surface(b.name, partMaterial(b, part), b.ghost || !!part.sensor)),
            },
          ],
          children: [],
        });
      }
    } else {
      node.primitives = primitivesOfBody(b);
    }
    return node;
  };

  const nodes = new Map<string, ExportNode>();
  for (const e of doc.entities) {
    if (e.kind === 'soft') {
      if ((!wanted || wanted.has(e.id)) && (includeHidden || !e.hidden)) {
        skipped.push({ id: e.id, name: e.name, reason: 'soft bodies are simulated particles and are not exported' });
      }
      continue;
    }
    if (!include(e)) continue;
    if (e.kind === 'body') nodes.set(e.id, makeBody(e));
    else if (e.kind === 'group') {
      nodes.set(e.id, {
        entityId: e.id,
        name: e.name,
        translation: [...e.position],
        rotation: [...e.rotation],
        world: { position: [...e.position], rotation: [...e.rotation] },
        primitives: [],
        children: [],
      });
    } else if (e.kind === 'light') {
      if (!lights) continue;
      const light = lightOf(e);
      if (!light) {
        skipped.push({ id: e.id, name: e.name, reason: 'area lights have no glTF equivalent' });
        continue;
      }
      nodes.set(e.id, {
        entityId: e.id,
        name: e.name,
        translation: [...e.position],
        rotation: [...e.rotation],
        world: { position: [...e.position], rotation: [...e.rotation] },
        primitives: [],
        light,
        children: [],
      });
    }
  }

  // Link members under their parent node (cycles and missing parents fall back to the root).
  const roots: ExportNode[] = [];
  const parentOk = (id: string, parentId: string | undefined): boolean => {
    const seen = new Set<string>([id]);
    let cur = parentId;
    while (cur) {
      if (seen.has(cur)) return false;
      seen.add(cur);
      const pe = byId.get(cur);
      cur = pe && pe.kind !== 'joint' ? pe.parent : undefined;
    }
    return true;
  };
  for (const e of doc.entities) {
    const node = nodes.get(e.id);
    if (!node) continue;
    const parentId = e.kind === 'joint' ? undefined : e.parent;
    const parent = parentId && parentOk(e.id, parentId) ? nodes.get(parentId) : undefined;
    if (parent) {
      const rel = relativePose(parent.world, node.world);
      node.translation = rel.translation;
      node.rotation = rel.rotation;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  if (ground && doc.settings.ground.enabled && !wanted) {
    const g = doc.settings.ground;
    const size = g.halfSize * 2;
    roots.push({
      name: 'Ground',
      translation: [0, -1, 0],
      rotation: [0, 0, 0, 1],
      world: { position: [0, -1, 0], rotation: [0, 0, 0, 1] },
      primitives: [
        {
          mesh: geometry.shape({ type: 'box', size: [size, 2, size] }),
          material: materials.get({
            name: 'ground',
            color: parseHexColor(g.color),
            metalness: 0,
            roughness: 0.92,
            opacity: 1,
          }),
        },
      ],
      children: [],
    });
  }

  return { name: doc.name || 'Scene', roots, materials: materials.list, skipped };
}

/** Depth-first walk of every node. */
export function walkNodes(scene: ExportScene, fn: (n: ExportNode, parent: ExportNode | null) => void): void {
  const visit = (n: ExportNode, parent: ExportNode | null): void => {
    fn(n, parent);
    for (const c of n.children) visit(c, n);
  };
  for (const r of scene.roots) visit(r, null);
}

/** Total triangle count of all primitives. */
export function triangleCount(scene: ExportScene): number {
  let n = 0;
  walkNodes(scene, (node) => {
    for (const p of node.primitives) n += p.mesh.indices.length / 3;
  });
  return n;
}
