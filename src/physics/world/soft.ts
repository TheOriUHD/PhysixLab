/**
 * Soft bodies (jelly, balloon, cloth, cable): construction from the recipe, removal (including tear
 * pieces), the cursor grab spring on a single particle, and the per-frame particle readback.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { qrot, vadd, vlen, vscale, vsub, type Vec3 } from '../../core/math';
import { softParticleRadius } from '../../model/shapes';
import type { SoftEntity } from '../../model/types';
import type { SoftLayoutEntry } from '../protocol';
import { SoftEnergy } from './energy';
import type { SoftRec, WorldState } from './state';
import { rv } from './util';

/** Grab spring natural frequency (rad/s) and acceleration cap (m/s²) for soft bodies. */
const SOFT_GRAB_OMEGA = 10;
const SOFT_GRAB_MAX_ACCEL = 250;

function makeSoftDesc(def: SoftEntity): RAPIER.SoftBodyDesc {
  const c = def.position;
  const n = def.resolution;
  let desc: RAPIER.SoftBodyDesc;
  let pins: number[] = [];
  switch (def.type) {
    case 'jelly':
      desc = RAPIER.SoftBodyDesc.cuboid(rv(c), rv([def.size[0] / 2, def.size[1] / 2, def.size[2] / 2]), n, n, n);
      break;
    case 'balloon':
      desc = RAPIER.SoftBodyDesc.sphere(rv(c), def.size[0] / 2, n);
      break;
    case 'cloth': {
      const w = def.size[0],
        d = def.size[2];
      // Particle index = i·n + j with i along the width (x) and j along the depth (z).
      desc = RAPIER.SoftBodyDesc.cloth(
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
      break;
    }
    case 'cable': {
      const L = def.size[0];
      desc = RAPIER.SoftBodyDesc.rope(rv([c[0] - L / 2, c[1], c[2]]), rv([c[0] + L / 2, c[1], c[2]]), n);
      if (def.pin === 'ends') pins = [0, n - 1];
      else if (def.pin === 'one-end') pins = [0];
      break;
    }
  }
  const mat = RAPIER.SoftBodyMaterial.uniform(def.stiffness, def.damping);
  if (def.tearStrain > 0) mat.tearStrain = def.tearStrain;
  desc = desc
    .setMass(def.mass)
    .setMaterial(mat)
    .setParticleRadius(softParticleRadius(def))
    .setLinearDamping(def.linearDamping)
    .setGravityScale(def.gravityScale)
    .setSelfContacts(def.selfCollide);
  if (pins.length) desc = desc.setPinnedParticles(pins);
  return desc;
}

export function addSoft(s: WorldState, def: SoftEntity): void {
  const root = s.world.createSoftBody(makeSoftDesc(def));
  const q = def.rotation;
  if (q[0] !== 0 || q[1] !== 0 || q[2] !== 0) {
    // The generators are axis-aligned: rotate the freshly built particles about the entity centre.
    const p = root.particlePositions();
    for (let i = 0; i < root.numParticles(); i++) {
      const rel: Vec3 = [p[3 * i] - def.position[0], p[3 * i + 1] - def.position[1], p[3 * i + 2] - def.position[2]];
      const r = qrot(q, rel);
      root.setParticlePosition(i, rv([def.position[0] + r[0], def.position[1] + r[1], def.position[2] + r[2]]));
    }
  }
  const rec: SoftRec = { id: def.id, def, root };
  s.softs.set(def.id, rec);
  s.softOrder.push(rec);
  s.softSig = '';
  s.layoutVersion++;
}

/** All engine bodies (root + tear pieces) that belong to a soft entity. */
export function piecesOf(s: WorldState, rec: SoftRec): RAPIER.SoftBody[] {
  const out: RAPIER.SoftBody[] = [];
  for (const sb of s.world.softBodies.getAll()) {
    const origin = sb.origin();
    if (sb.handle === rec.root.handle || origin === rec.root.handle) out.push(sb);
  }
  return out.length ? out : [rec.root];
}

export function removeSoft(s: WorldState, id: string): void {
  const rec = s.softs.get(id);
  if (!rec) return;
  if (s.softGrab && piecesOf(s, rec).includes(s.softGrab.body)) s.softGrab = null;
  for (const sb of piecesOf(s, rec)) if (sb.isValid()) s.world.removeSoftBody(sb);
  s.softs.delete(id);
  s.softOrder = s.softOrder.filter((r) => r !== rec);
  s.softSig = '';
  s.layoutVersion++;
}

/** Start dragging particle `index` (entity-local, across all tear pieces) of soft entity `id`. */
export function beginSoftGrab(s: WorldState, id: string, index: number, target: Vec3, strength = 1): void {
  if (!s.softs.has(id)) return;
  const ei = s.softOrder.findIndex((r) => r.id === id);
  const blocks = s.softBlocks[ei];
  if (!blocks) return;
  let k = index;
  for (const b of blocks) {
    const n = b.numParticles();
    if (k < n) {
      b.wakeUp();
      s.softGrab = { body: b, local: k, target, strength };
      return;
    }
    k -= n;
  }
}

/** Spring force that drags the grabbed soft particle (and, through the lattice, its body) to the cursor. */
export function applySoftGrab(s: WorldState): void {
  const g = s.softGrab;
  if (!g) return;
  if (!g.body.isValid()) {
    s.softGrab = null;
    return;
  }
  const p = g.body.particlePosition(g.local);
  const v = g.body.particleVelocity(g.local);
  const err = vsub(g.target, [p.x, p.y, p.z]);
  const omega = SOFT_GRAB_OMEGA * Math.sqrt(g.strength);
  const maxAccel = SOFT_GRAB_MAX_ACCEL * g.strength;
  let acc = vsub(vscale(err, omega * omega), vscale([v.x, v.y, v.z], 2 * omega));
  const al = vlen(acc);
  if (al > maxAccel) acc = vscale(acc, maxAccel / al);
  const grav = vscale(s.settings.gravity, -1);
  const f = vscale(vadd(acc, grav), g.body.mass() * 0.4);
  g.body.resetForces(false);
  g.body.addParticleForce(g.local, rv(f), true);
}

export function releaseSoftGrab(s: WorldState): void {
  if (s.softGrab && s.softGrab.body.isValid()) s.softGrab.body.resetForces(false);
  s.softGrab = null;
}

/**
 * Snapshot of every soft body's particles. `layout` is returned only when the topology changed
 * (spawn, removal, tearing); positions are always returned. Also adds the soft bodies' energy to
 * the totals `readPoses` produced for the rigid bodies.
 */
export function readSoft(s: WorldState): { layout?: SoftLayoutEntry[]; positions: Float32Array } {
  if (!s.softOrder.length) {
    s.softBlocks = [];
    s.softParticles = 0;
    return { positions: new Float32Array(0) };
  }
  const all = s.world.softBodies.getAll();
  const byRoot = new Map<number, RAPIER.SoftBody[]>();
  for (const sb of all) {
    const key = sb.origin() ?? sb.handle;
    const list = byRoot.get(key);
    if (list) list.push(sb);
    else byRoot.set(key, [sb]);
  }
  s.softBlocks = s.softOrder.map((r) => byRoot.get(r.root.handle) ?? [r.root]);
  const sig = s.softBlocks
    .map((bs) => bs.map((b) => `${b.handle}:${b.topologyVersion()}:${b.numParticles()}`).join(','))
    .join('|');
  let layout: SoftLayoutEntry[] | undefined;
  if (sig !== s.softSig) {
    s.softSig = sig;
    layout = s.softOrder.map((rec, ei) => {
      const mode = rec.def.type === 'cable' ? 'line' : 'tri';
      const idx: number[] = [];
      let offset = 0;
      for (const b of s.softBlocks[ei]) {
        const src = mode === 'tri' ? b.boundary() : b.edges();
        for (let i = 0; i < src.length; i++) idx.push(src[i] + offset);
        offset += b.numParticles();
      }
      return { id: rec.id, mode, count: offset, indices: new Uint32Array(idx) };
    });
  }
  let total = 0;
  for (const bs of s.softBlocks) for (const b of bs) total += b.numParticles();
  s.softParticles = total;
  const positions = new Float32Array(total * 3);
  const energy = new SoftEnergy();
  let o = 0;
  for (let ei = 0; ei < s.softBlocks.length; ei++) {
    const gs = s.softOrder[ei].def.gravityScale;
    for (const b of s.softBlocks[ei]) {
      positions.set(b.particlePositions(), o * 3);
      o += b.numParticles();
      energy.addBlock(b, gs, s.settings.gravity);
    }
  }
  s.lastEnergy = energy.addTo(s.lastEnergy);
  return { layout, positions };
}
