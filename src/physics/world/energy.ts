/**
 * Energy and momentum accounting, computed from engine state each frame:
 * ½mv² (translational), ½ΣIᵢωᵢ² in the principal frame (rotational), −m·g·r about the centre of mass
 * (gravitational potential) and ½kx² for springs. Soft bodies contribute per-particle kinetic energy
 * and a centre-of-mass potential.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { qmul, qrotInv, type Quat, type Vec3 } from '../../core/math';
import type { EnergyStats } from '../protocol';
import type { BodyRec, JointRec } from './state';

/** Running totals for one `readPoses` pass; reused between frames so the per-body loop adds no garbage. */
export class RigidEnergy {
  kinetic = 0;
  rotational = 0;
  potential = 0;
  readonly momentum: Vec3 = [0, 0, 0];

  reset(): void {
    this.kinetic = this.rotational = this.potential = 0;
    this.momentum[0] = this.momentum[1] = this.momentum[2] = 0;
  }

  /** Add one awake-or-asleep dynamic body; returns its total kinetic energy (translational + rotational). */
  addBody(r: BodyRec, lv: RAPIER.Vector, av: RAPIER.Vector, q: RAPIER.Rotation, g: Vec3): number {
    const v2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
    const com = r.rb.worldCom();
    // rotational KE in the principal frame: ½ Σ Iᵢ ωᵢ²
    const qb: Quat = [q.x, q.y, q.z, q.w];
    const pf = r.rb.principalInertiaLocalFrame();
    const pi = r.rb.principalInertia();
    const wl = qrotInv(qmul(qb, [pf.x, pf.y, pf.z, pf.w]), [av.x, av.y, av.z]);
    const rot = 0.5 * (pi.x * wl[0] * wl[0] + pi.y * wl[1] * wl[1] + pi.z * wl[2] * wl[2]);
    const tr = 0.5 * r.mass * v2;
    this.kinetic += tr;
    this.rotational += rot;
    this.potential += -r.mass * r.def.gravityScale * (g[0] * com.x + g[1] * com.y + g[2] * com.z);
    this.momentum[0] += r.mass * lv.x;
    this.momentum[1] += r.mass * lv.y;
    this.momentum[2] += r.mass * lv.z;
    return tr + rot;
  }

  /** Close the pass: add the spring energy and produce the stats object published to the main thread. */
  finish(elastic: number): EnergyStats {
    return {
      kinetic: this.kinetic,
      rotational: this.rotational,
      potential: this.potential,
      elastic,
      momentum: [this.momentum[0], this.momentum[1], this.momentum[2]],
    };
  }
}

/** Σ ½·k·x² over the intact springs (extension x comes from the last per-step measurement). */
export function springElasticEnergy(joints: JointRec[]): number {
  let elastic = 0;
  for (const j of joints)
    if (j.def.type === 'spring' && !j.broken) {
      const x = j.value - j.def.spring.restLength;
      elastic += 0.5 * j.def.spring.stiffness * x * x;
    }
  return elastic;
}

/** Per-engine-body cache for the elastic energy: rest lengths, which edges are bend edges, and the two spring rates. */
export interface SoftEdgeCache {
  topo: number;
  len: Float32Array;
  bend: Uint8Array;
  /** Natural angular frequencies (rad/s) of the stretch and bend softness. */
  wStretch: number;
  wBend: number;
}

/**
 * Running totals for the soft-body part of a frame. The elastic term is the edge-spring energy ½·k·(l − l₀)² with
 * k = ω²·m_eff, ω = 2π·(natural frequency of the edge softness) and m_eff = half a particle's mass (two equal
 * particles' reduced mass). Volume and shape-matching constraints store energy too but have no closed form in the
 * engine, so they are not counted (documented in docs/LIMITATIONS.md).
 */
export class SoftEnergy {
  kinetic = 0;
  potential = 0;
  elastic = 0;
  readonly momentum: Vec3 = [0, 0, 0];

  /** Add one engine soft body (the root, or a piece after tearing). Particles share the mass equally. */
  addBlock(b: RAPIER.SoftBody, gravityScale: number, g: Vec3, cache?: Map<number, SoftEdgeCache>): void {
    const np = b.numParticles();
    if (cache) this.elastic += softElastic(b, cache);
    const m = b.mass();
    const v = b.particleVelocities();
    let vv = 0,
      vx = 0,
      vy = 0,
      vz = 0;
    for (let i = 0; i < np; i++) {
      const x = v[3 * i],
        y = v[3 * i + 1],
        z = v[3 * i + 2];
      vv += x * x + y * y + z * z;
      vx += x;
      vy += y;
      vz += z;
    }
    this.kinetic += 0.5 * (m / Math.max(1, np)) * vv;
    this.momentum[0] += (m * vx) / Math.max(1, np);
    this.momentum[1] += (m * vy) / Math.max(1, np);
    this.momentum[2] += (m * vz) / Math.max(1, np);
    const com = b.centerOfMass();
    this.potential += -m * gravityScale * (g[0] * com.x + g[1] * com.y + g[2] * com.z);
  }

  /** The rigid-body totals of this frame with the soft-body contribution added. */
  addTo(e: EnergyStats): EnergyStats {
    return {
      ...e,
      elastic: e.elastic + this.elastic,
      kinetic: e.kinetic + this.kinetic,
      potential: e.potential + this.potential,
      momentum: [e.momentum[0] + this.momentum[0], e.momentum[1] + this.momentum[1], e.momentum[2] + this.momentum[2]],
    };
  }
}

/** Σ ½·k·(l − l₀)² over the edges of one engine soft body (see `SoftEnergy`). */
export function softElastic(b: RAPIER.SoftBody, cache: Map<number, SoftEdgeCache>): number {
  const edges = b.edges();
  const ne = edges.length >> 1;
  const np = Math.max(1, b.numParticles());
  let c = cache.get(b.handle);
  if (!c || c.topo !== b.topologyVersion() || c.len.length !== ne) {
    const mat = b.material();
    c = {
      topo: b.topologyVersion(),
      len: new Float32Array(ne),
      bend: new Uint8Array(ne),
      wStretch: 2 * Math.PI * mat.edgeSoftness.naturalFrequency,
      wBend: 2 * Math.PI * mat.bendSoftness.naturalFrequency,
    };
    for (let e = 0; e < ne; e++) {
      c.len[e] = b.edgeRestLength(e);
      c.bend[e] = b.isEdgeBend(e) ? 1 : 0;
    }
    cache.set(b.handle, c);
  }
  const pos = b.particlePositions();
  const mEff = b.mass() / np / 2;
  let sum = 0;
  for (let e = 0; e < ne; e++) {
    const i = edges[2 * e] * 3,
      j = edges[2 * e + 1] * 3;
    const l = Math.hypot(pos[i] - pos[j], pos[i + 1] - pos[j + 1], pos[i + 2] - pos[j + 2]);
    const x = l - c.len[e];
    const w = c.bend[e] ? c.wBend : c.wStretch;
    sum += 0.5 * w * w * mEff * x * x;
  }
  return sum;
}
