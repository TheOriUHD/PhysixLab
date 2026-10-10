/**
 * The geometry provider backed by the shape registry and three.js: the same factories the viewport draws with
 * (`shapeGeometry` + `shapeVisualScale`), so an exported shape is exactly the shape on screen. three.js geometries
 * are disposed as soon as their arrays are copied out.
 */
import type { BufferAttribute } from 'three';
import { GEOMETRY_KIT } from '../../render/geometryKit';
import { shapeGeometry, shapeGeometryKey, shapeVisualScale } from '../../model/shapeRegistry';
import type { ShapeSpec } from '../../model/types';
import type { GeometryProvider, MeshData } from './types';

export function createThreeGeometryProvider(): GeometryProvider {
  const cache = new Map<string, MeshData>();
  return {
    shape(spec: ShapeSpec): MeshData {
      const s = shapeVisualScale(spec);
      const key = `${shapeGeometryKey(spec)}|${s.join(',')}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const geo = shapeGeometry(GEOMETRY_KIT, spec);
      try {
        geo.scale(s[0], s[1], s[2]); // transforms the normals with the inverse transpose
        if (!geo.getAttribute('normal')) geo.computeVertexNormals();
        const pos = geo.getAttribute('position') as BufferAttribute;
        const nor = geo.getAttribute('normal') as BufferAttribute;
        const positions = new Float32Array(pos.count * 3);
        const normals = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
          positions[i * 3] = pos.getX(i);
          positions[i * 3 + 1] = pos.getY(i);
          positions[i * 3 + 2] = pos.getZ(i);
          normals[i * 3] = nor.getX(i);
          normals[i * 3 + 1] = nor.getY(i);
          normals[i * 3 + 2] = nor.getZ(i);
        }
        const idx = geo.getIndex();
        let indices: Uint32Array;
        if (idx) {
          indices = new Uint32Array(idx.count);
          for (let i = 0; i < idx.count; i++) indices[i] = idx.getX(i);
        } else {
          indices = new Uint32Array(pos.count);
          for (let i = 0; i < pos.count; i++) indices[i] = i;
        }
        const mesh: MeshData = { positions, normals, indices };
        cache.set(key, mesh);
        return mesh;
      } finally {
        geo.dispose();
      }
    },
  };
}
