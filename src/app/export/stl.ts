/**
 * Binary STL writer: an 80-byte header, a uint32 triangle count, then 50 bytes per triangle (normal, three vertices,
 * a zero attribute word), all little-endian — so the file size is exactly 84 + 50 × triangles. Geometry is written in
 * world space, merged into one solid. STL has no colours, units or hierarchy.
 */
import { qrot, vadd, vcross, vsub, type Vec3 } from '../../core/math';
import { walkNodes } from './scene';
import type { ExportScene } from './types';

export interface StlOptions {
  /** Multiply coordinates: 1 = metres, 1000 = millimetres (what slicers assume). Default 1. */
  scale?: number;
  /** Rotate the Y-up scene to Z-up, the CAD / 3D-printing convention (x, y, z) -> (x, -z, y). Default false. */
  zUp?: boolean;
}

export interface StlResult {
  data: Uint8Array;
  triangleCount: number;
}

export const STL_HEADER_BYTES = 80;
export const STL_TRIANGLE_BYTES = 50;

export function buildStl(scene: ExportScene, options: StlOptions = {}): StlResult {
  const k = options.scale ?? 1;
  const zUp = options.zUp ?? false;
  let count = 0;
  walkNodes(scene, (n) => {
    for (const p of n.primitives) count += Math.floor(p.mesh.indices.length / 3);
  });
  const data = new Uint8Array(STL_HEADER_BYTES + 4 + count * STL_TRIANGLE_BYTES);
  const dv = new DataView(data.buffer);
  // The header must not start with "solid" or some readers mistake the file for ASCII STL.
  data.set(new TextEncoder().encode('PhysixLab binary STL'), 0);
  dv.setUint32(STL_HEADER_BYTES, count, true);

  let o = STL_HEADER_BYTES + 4;
  const tri: Vec3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  walkNodes(scene, (node) => {
    const q = node.world.rotation;
    const p = node.world.position;
    for (const prim of node.primitives) {
      const m = prim.mesh;
      for (let t = 0; t + 2 < m.indices.length; t += 3) {
        for (let c = 0; c < 3; c++) {
          const i = m.indices[t + c] * 3;
          const w = vadd(p, qrot(q, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]));
          tri[c] = zUp ? [w[0] * k, -w[2] * k, w[1] * k] : [w[0] * k, w[1] * k, w[2] * k];
        }
        const n = vcross(vsub(tri[1], tri[0]), vsub(tri[2], tri[0]));
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        dv.setFloat32(o, n[0] / l, true);
        dv.setFloat32(o + 4, n[1] / l, true);
        dv.setFloat32(o + 8, n[2] / l, true);
        for (let c = 0; c < 3; c++) {
          dv.setFloat32(o + 12 + c * 12, tri[c][0], true);
          dv.setFloat32(o + 16 + c * 12, tri[c][1], true);
          dv.setFloat32(o + 20 + c * 12, tri[c][2], true);
        }
        o += STL_TRIANGLE_BYTES; // attribute byte count stays 0
      }
    }
  });
  return { data, triangleCount: count };
}
