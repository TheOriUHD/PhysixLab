/**
 * Helpers shared by the package-SH shape tests (kept out of `helpers.ts`, which every package shares): the engine's
 * integrated mass for a shape spec, and the volume enclosed by a shape's mesh once the renderer's scale is applied.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3 } from '../src/core/math';
import { makeShapeSpec, shapeColliders, shapeGeometry, shapeVisualScale } from '../src/model/shapeRegistry';
import type { ShapeParams, ShapeSpec } from '../src/model/types';
import { GEOMETRY_KIT } from '../src/render/geometryKit';

/** Mass the engine integrates for the registry colliders of `spec` at a uniform density. */
export function engineMassOfSpec(spec: ShapeSpec, density = 1000): number {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
  for (const c of shapeColliders(RAPIER, spec)) {
    const d = c.desc.setDensity(density).setTranslation(...c.localPos);
    d.setRotation({ x: c.localRot[0], y: c.localRot[1], z: c.localRot[2], w: c.localRot[3] });
    world.createCollider(d, rb);
  }
  const m = rb.mass();
  world.free();
  return m;
}

export function engineMass(type: string, size?: Vec3, params?: ShapeParams): number {
  return engineMassOfSpec(makeShapeSpec(type, size, params));
}

/** Signed volume enclosed by the shape's non-indexed triangle mesh, after the renderer's visual scale. */
export function meshVolumeOfSpec(spec: ShapeSpec): number {
  const geo = shapeGeometry(GEOMETRY_KIT, spec);
  const s = shapeVisualScale(spec);
  const p = geo.getAttribute('position');
  let v = 0;
  for (let i = 0; i + 2 < p.count; i += 3) {
    const a = [p.getX(i) * s[0], p.getY(i) * s[1], p.getZ(i) * s[2]];
    const b = [p.getX(i + 1) * s[0], p.getY(i + 1) * s[1], p.getZ(i + 1) * s[2]];
    const c = [p.getX(i + 2) * s[0], p.getY(i + 2) * s[1], p.getZ(i + 2) * s[2]];
    v +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  geo.dispose();
  return v;
}

export function meshVolume(type: string, size?: Vec3, params?: ShapeParams): number {
  return meshVolumeOfSpec(makeShapeSpec(type, size, params));
}
