/**
 * Soft bodies (jelly, balloon, cloth, cable): construction from the recipe, removal (including tear
 * pieces), the cursor grab spring on a single particle, and the per-frame particle readback.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { qrot, vadd, vlen, vscale, vsub, type Vec3 } from '../../core/math';
import type { SoftEntity } from '../../model/types';
import type { SoftLayoutEntry } from '../protocol';
import { SoftEnergy } from './energy';
import { resolveAttachments, updateAttachments } from './softAttach';
import { buildSoft } from './softBuild';
import type { SoftRec, WorldState } from './state';
import { rv } from './util';

/** Grab spring natural frequency (rad/s) and acceleration cap (m/s²) for soft bodies. */
const SOFT_GRAB_OMEGA = 10;
const SOFT_GRAB_MAX_ACCEL = 250;

export function addSoft(s: WorldState, def: SoftEntity): void {
  const built = buildSoft(def);
  const root = s.world.createSoftBody(built.desc);
  const q = def.rotation;
  if (!built.baked && (q[0] !== 0 || q[1] !== 0 || q[2] !== 0)) {
    // The generators are axis-aligned: rotate the freshly built particles about the entity centre.
    const p = root.particlePositions();
    for (let i = 0; i < root.numParticles(); i++) {
      const rel: Vec3 = [p[3 * i] - def.position[0], p[3 * i + 1] - def.position[1], p[3 * i + 2] - def.position[2]];
      const r = qrot(q, rel);
      root.setParticlePosition(i, rv([def.position[0] + r[0], def.position[1] + r[1], def.position[2] + r[2]]));
    }
  }
  const rec: SoftRec = {
    id: def.id,
    def,
    root,
    rest: root.particlePositions().slice(),
    attached: [],
    released: new Set(),
    volumeFactor: def.volumeFactor,
    restLen: new Map(),
  };
  s.softs.set(def.id, rec);
  s.softOrder.push(rec);
  s.softSig = '';
  s.layoutVersion++;
  resolveAttachments(s, rec); // -- SF-1: fasten to bodies that already exist; later ones are picked up per step --
}

/** Per-step soft upkeep (SF): attachment bookkeeping and the pressure decay of a punctured balloon / tyre. */
export function softPrestep(s: WorldState, dt: number): void {
  if (!s.softOrder.length) return;
  updateAttachments(s);
  for (const rec of s.softOrder) {
    const leak = rec.def.leakRate;
    if (leak <= 0 || !rec.def.volumePreserve) continue;
    rec.volumeFactor = Math.max(0.15, rec.volumeFactor - (rec.volumeFactor - 0.15) * leak * dt);
    for (const sb of piecesOf(s, rec)) sb.setVolumeFactor(rec.volumeFactor);
  }
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

/** True when the visible mesh of this engine body is the skin (volumetric meshes), not the lattice boundary. */
function usesSkin(def: SoftEntity, b: RAPIER.SoftBody): boolean {
  return def.type === 'mesh' && b.numMeshes() > 0 && b.isMeshSkinned(0);
}

/** Start dragging particle `index` (entity-local, across all tear pieces) of soft entity `id`. */
export function beginSoftGrab(s: WorldState, id: string, index: number, target: Vec3, strength = 1): void {
  if (!s.softs.has(id)) return;
  const ei = s.softOrder.findIndex((r) => r.id === id);
  const blocks = s.softBlocks[ei];
  if (!blocks) return;
  const def = s.softOrder[ei].def;
  let k = index;
  for (const b of blocks) {
    const skin = usesSkin(def, b);
    const n = skin ? b.meshVertices(0).length / 3 : b.numParticles();
    if (k < n) {
      b.wakeUp();
      let local = k;
      if (skin) {
        // The picked index is a skin vertex: drag the lattice particle nearest to it.
        const v = b.meshVertices(0);
        const pp = b.particlePositions();
        let best = Infinity;
        for (let i = 0; i < b.numParticles(); i++) {
          const d =
            (pp[3 * i] - v[3 * k]) ** 2 + (pp[3 * i + 1] - v[3 * k + 1]) ** 2 + (pp[3 * i + 2] - v[3 * k + 2]) ** 2;
          if (d < best) {
            best = d;
            local = i;
          }
        }
      }
      s.softGrab = { body: b, local, target, strength };
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
        const skin = usesSkin(rec.def, b);
        const src = skin ? b.meshIndices(0) : mode === 'tri' ? b.boundary() : b.edges();
        for (let i = 0; i < src.length; i++) idx.push(src[i] + offset);
        offset += skin ? b.meshVertices(0).length / 3 : b.numParticles();
      }
      return { id: rec.id, mode, count: offset, indices: new Uint32Array(idx) };
    });
  }
  let total = 0,
    lattice = 0;
  for (let ei = 0; ei < s.softBlocks.length; ei++)
    for (const b of s.softBlocks[ei]) {
      lattice += b.numParticles();
      total += usesSkin(s.softOrder[ei].def, b) ? b.meshVertices(0).length / 3 : b.numParticles();
    }
  s.softParticles = lattice;
  const positions = new Float32Array(total * 3);
  const energy = new SoftEnergy();
  let o = 0;
  for (let ei = 0; ei < s.softBlocks.length; ei++) {
    const gs = s.softOrder[ei].def.gravityScale;
    for (const b of s.softBlocks[ei]) {
      if (usesSkin(s.softOrder[ei].def, b)) {
        const v = b.meshVertices(0);
        positions.set(v, o * 3);
        o += v.length / 3;
      } else {
        positions.set(b.particlePositions(), o * 3);
        o += b.numParticles();
      }
      energy.addBlock(b, gs, s.settings.gravity, s.softOrder[ei].restLen);
    }
  }
  s.lastEnergy = energy.addTo(s.lastEnergy);
  return { layout, positions };
}
