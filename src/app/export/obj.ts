/**
 * Wavefront OBJ + MTL writer. OBJ has no hierarchy or instancing, so every primitive is written in world space as
 * one `o` object (named after its node) with `usemtl`, `v` / `vn` lines and `f v//vn` faces. Indices are 1-based and
 * global across the file. Lights, animation and the node tree are not representable and are dropped.
 */
import { qrot, vadd, type Vec3 } from '../../core/math';
import { walkNodes } from './scene';
import type { ExportMaterial, ExportNode, ExportScene } from './types';

export interface ObjOptions {
  /** File name of the .mtl the .obj points to. Default `scene.mtl`. */
  mtlName?: string;
  /** Write `mtllib` / `usemtl` lines (default true). */
  materials?: boolean;
  /** Multiply all coordinates (1 = metres). */
  scale?: number;
}

export interface ObjResult {
  obj: string;
  mtl: string;
  vertexCount: number;
  triangleCount: number;
}

const num = (x: number): string => {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

/** MTL material names must be single tokens. */
const token = (s: string): string => s.replace(/\s+/g, '_').replace(/[^\w.-]/g, '') || 'material';

export function buildObj(scene: ExportScene, options: ObjOptions = {}): ObjResult {
  const mtlName = options.mtlName ?? 'scene.mtl';
  const k = options.scale ?? 1;
  const withMtl = options.materials !== false;
  const lines: string[] = [`# PhysixLab: ${scene.name.replace(/[\r\n]+/g, ' ')}`];
  if (withMtl) lines.push(`mtllib ${mtlName}`);
  let vBase = 0;
  let triangles = 0;
  const used = new Set<number>();
  const objNames = new Map<string, number>();

  walkNodes(scene, (node: ExportNode) => {
    node.primitives.forEach((prim, pi) => {
      const m = prim.mesh;
      const nv = m.positions.length / 3;
      let base = token(node.name);
      const seen = objNames.get(base) ?? 0;
      objNames.set(base, seen + 1);
      if (seen > 0) base = `${base}.${seen}`;
      lines.push(`o ${node.primitives.length > 1 ? `${base}_${pi}` : base}`);
      if (withMtl) lines.push(`usemtl ${token(scene.materials[prim.material].name)}`);
      used.add(prim.material);
      const q = node.world.rotation;
      const p = node.world.position;
      for (let i = 0; i < nv; i++) {
        const w = vadd(p, qrot(q, [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]] as Vec3));
        lines.push(`v ${num(w[0] * k)} ${num(w[1] * k)} ${num(w[2] * k)}`);
      }
      for (let i = 0; i < nv; i++) {
        const w = qrot(q, [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]] as Vec3);
        lines.push(`vn ${num(w[0])} ${num(w[1])} ${num(w[2])}`);
      }
      for (let t = 0; t + 2 < m.indices.length; t += 3) {
        const a = vBase + m.indices[t] + 1,
          b = vBase + m.indices[t + 1] + 1,
          c = vBase + m.indices[t + 2] + 1;
        lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
        triangles++;
      }
      vBase += nv;
    });
  });

  return {
    obj: lines.join('\n') + '\n',
    mtl: buildMtl(scene.materials, used),
    vertexCount: vBase,
    triangleCount: triangles,
  };
}

function buildMtl(materials: readonly ExportMaterial[], used: ReadonlySet<number>): string {
  const lines = ['# PhysixLab materials'];
  materials.forEach((m, i) => {
    if (!used.has(i)) return;
    const [r, g, b] = m.color;
    // Blinn-Phong approximation of the PBR surface: shininess grows as roughness falls, metals tint the specular.
    const shin = Math.round(Math.max(1, (1 - m.roughness) * 128));
    const spec = 0.04 + 0.5 * m.metalness;
    lines.push(
      `newmtl ${token(m.name)}`,
      `Kd ${num(r)} ${num(g)} ${num(b)}`,
      `Ka ${num(r * 0.2)} ${num(g * 0.2)} ${num(b * 0.2)}`,
      `Ks ${num(spec * (1 - m.metalness + m.metalness * r))} ${num(spec * (1 - m.metalness + m.metalness * g))} ${num(spec * (1 - m.metalness + m.metalness * b))}`,
      `Ns ${shin}`,
      `d ${num(m.opacity)}`,
      'illum 2',
      '',
    );
  });
  return lines.join('\n');
}
