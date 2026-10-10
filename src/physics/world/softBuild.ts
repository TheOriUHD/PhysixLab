/**
 * Engine descriptions for the soft-body recipes (jelly, balloon, cloth, cable, volumetric mesh, tyre) and the material
 * model (stiffness in Hz + damping, Poisson ratio, permanent set, surface friction) — SF-5/6/7.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { qrot, vadd } from '../../core/math';
import { softSurface, torusSurface, TYRE_ACROSS, tyreGeometry } from '../../model/softMesh';
import { softParticleRadius } from '../../model/shapes';
import type { SoftEntity } from '../../model/types';
import { rv } from './util';

export interface SoftBuild {
  desc: RAPIER.SoftBodyDesc;
  /** True when the pose (rotation, position) is already baked into the particle positions. */
  baked: boolean;
}

/** Pose a local-space vertex array into world space (rotation then translation). */
function bake(v: Float32Array, def: SoftEntity): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    const p = vadd(qrot(def.rotation, [v[i], v[i + 1], v[i + 2]]), def.position);
    out[i] = p[0];
    out[i + 1] = p[1];
    out[i + 2] = p[2];
  }
  return out;
}

function material(def: SoftEntity): RAPIER.SoftBodyMaterial {
  const mat = RAPIER.SoftBodyMaterial.uniform(def.stiffness, def.damping);
  if (def.tearStrain > 0) mat.tearStrain = def.tearStrain;
  mat.poissonRatio = def.poisson;
  if (def.plasticYield > 0) {
    // Permanent set: both the lattice cells and the edges keep the deformation beyond the yield strain.
    mat.plasticYield = def.plasticYield;
    mat.edgePlasticYield = def.plasticYield;
    mat.edgePlasticCreep = 1;
    mat.plasticCreep = 1;
    mat.edgePlasticMax = 1;
    mat.plasticMax = 1;
  }
  return mat;
}

/** The generator desc for the recipe plus its pinned particles. */
function generate(def: SoftEntity): { desc: RAPIER.SoftBodyDesc; pins: number[]; baked: boolean } {
  const c = def.position;
  const n = def.resolution;
  let pins: number[] = [];
  switch (def.type) {
    case 'jelly':
      return {
        desc: RAPIER.SoftBodyDesc.cuboid(rv(c), rv([def.size[0] / 2, def.size[1] / 2, def.size[2] / 2]), n, n, n),
        pins,
        baked: false,
      };
    case 'balloon':
      return { desc: RAPIER.SoftBodyDesc.sphere(rv(c), def.size[0] / 2, n), pins, baked: false };
    case 'cloth': {
      const w = def.size[0],
        d = def.size[2];
      // Particle index = i·n + j with i along the width (x) and j along the depth (z).
      const desc = RAPIER.SoftBodyDesc.cloth(
        rv([c[0] - w / 2, c[1], c[2] - d / 2]),
        rv([w / (n - 1), 0, 0]),
        rv([0, 0, d / (n - 1)]),
        n,
        n,
      );
      // The pinned "edge" is the back edge (local z = −depth/2): j = 0 for every i. Stand the cloth
      // up by rotating +90° about X and that edge becomes its top, like a hanging banner.
      if (def.pin === 'edge') pins = Array.from({ length: n }, (_, i) => i * n);
      else if (def.pin === 'corners') pins = [0, (n - 1) * n];
      else if (def.pin === 'corners4') pins = [0, n - 1, (n - 1) * n, n * n - 1];
      return { desc, pins, baked: false };
    }
    case 'cable': {
      const L = def.size[0];
      const desc = RAPIER.SoftBodyDesc.rope(rv([c[0] - L / 2, c[1], c[2]]), rv([c[0] + L / 2, c[1], c[2]]), n);
      if (def.pin === 'ends') pins = [0, n - 1];
      else if (def.pin === 'one-end') pins = [0];
      return { desc, pins, baked: false };
    }
    case 'mesh': {
      const surf = softSurface({ ...def.shape, size: def.size }, def.cell);
      const built = surf
        ? RAPIER.SoftBodyDesc.volumetric(bake(surf.vertices, def), surf.indices, def.cell, true)
        : null;
      if (built) return { desc: built, pins, baked: true };
      // Degenerate shape: fall back to a jelly block of the same extents.
      return {
        desc: RAPIER.SoftBodyDesc.cuboid(rv(c), rv([def.size[0] / 2, def.size[1] / 2, def.size[2] / 2]), 5, 5, 5),
        pins,
        baked: false,
      };
    }
    case 'tyre': {
      const g = tyreGeometry(def.size);
      const around = Math.max(8, n);
      const surf = torusSurface(g.major, g.radial, g.axial, around, TYRE_ACROSS);
      const verts = bake(surf.vertices, def);
      const desc = def.pneumatic
        ? RAPIER.SoftBodyDesc.trimesh(verts, surf.indices)
        : RAPIER.SoftBodyDesc.volumetric(verts, surf.indices, Math.max(0.03, Math.min(g.radial, g.axial) * 0.9), true);
      if (!desc) throw new Error('tyre mesh could not be built');
      return { desc, pins, baked: true };
    }
  }
}

export function buildSoft(def: SoftEntity): SoftBuild {
  const g = generate(def);
  let desc = g.desc
    .setMass(def.mass)
    .setMaterial(material(def))
    .setParticleRadius(softParticleRadius(def))
    .setLinearDamping(def.linearDamping)
    .setGravityScale(def.gravityScale)
    .setSelfContacts(def.selfCollide);
  // A volumetric mesh collides through its true surface (the lattice voxelises beyond it) and is drawn from it.
  if (def.type === 'mesh' && g.baked) desc = desc.setSkinCollision(true);
  desc = desc.setVolumePreservation(def.volumePreserve).setVolumeFactor(def.volumeFactor);
  if (def.friction !== 0.8) desc = desc.setSurfaceCollider(RAPIER.ColliderDesc.ball(0.5).setFriction(def.friction));
  if (g.pins.length) desc = desc.setPinnedParticles(g.pins);
  return { desc, baked: g.baked };
}
