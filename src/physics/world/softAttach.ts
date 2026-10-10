/**
 * Soft ↔ rigid fastenings (SF-1). The document stores `SoftAttachment`s (region + body id + body-local offset);
 * here they are resolved against the engine: the particles of the region are moved so the region centre sits at the
 * stored offset on the body, then `attachParticle` fastens them. Resolution is lazy (the body may be created after
 * the soft body, or rebuilt by an edit), and fastenings are released when the linked joint breaks or the body goes.
 */
import { qrot, vadd, vlen, vsub, type Vec3 } from '../../core/math';
import { tyreGeometry } from '../../model/softMesh';
import type { SoftAttachment } from '../../model/types';
import type { SoftRec, WorldState } from './state';
import { rv } from './util';

/** World position of a body-local point. */
function bodyPoint(s: WorldState, bodyId: string, local: Vec3): { world: Vec3; handle: number } | null {
  const b = s.bodies.get(bodyId);
  if (!b) return null;
  const t = b.rb.translation(),
    q = b.rb.rotation();
  return { world: vadd([t.x, t.y, t.z], qrot([q.x, q.y, q.z, q.w], local)), handle: b.rb.handle };
}

/** World-space position of particle `i` as built (current position when the build pose is unknown). */
function restWorld(rec: SoftRec, i: number): Vec3 {
  if (rec.rest) return [rec.rest[3 * i], rec.rest[3 * i + 1], rec.rest[3 * i + 2]];
  const p = rec.root.particlePosition(i);
  return [p.x, p.y, p.z];
}

/** Rest-lattice indices of the particles an attachment covers. */
export function particlesOfAttachment(rec: SoftRec, att: SoftAttachment): number[] {
  const def = rec.def;
  const root = rec.root;
  const n = root.numParticles();
  const out: number[] = [];
  const c = vadd(def.position, qrot(def.rotation, att.center));
  if (att.kind === 'rim' && def.type === 'tyre') {
    // Particles on the inner half of the tube: distance from the axle (local Y through the centre) below the tube axis.
    const g = tyreGeometry(def.size);
    const inv: [number, number, number, number] = [
      -def.rotation[0],
      -def.rotation[1],
      -def.rotation[2],
      def.rotation[3],
    ];
    for (let i = 0; i < n; i++) {
      const p = restWorld(rec, i);
      const rel = qrot(inv, [p[0] - def.position[0], p[1] - def.position[1], p[2] - def.position[2]]);
      if (Math.hypot(rel[0], rel[2]) <= g.rimRadius + g.radial * 0.3) out.push(i);
    }
    return out;
  }
  let best = -1,
    bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const d = vlen(vsub(restWorld(rec, i), c));
    if (d <= att.radius) out.push(i);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  // A click between particles still grabs the nearest one.
  if (!out.length && best >= 0) out.push(best);
  return out;
}

function fasten(s: WorldState, rec: SoftRec, att: SoftAttachment): boolean {
  const b = s.bodies.get(att.body);
  if (!b || rec.released.has(att.id)) return false;
  const target = bodyPoint(s, att.body, att.offset);
  if (!target) return false;
  const particles = particlesOfAttachment(rec, att);
  if (!particles.length) return false;
  const def = rec.def;
  // Move the region so its centre meets the stored offset on the body (the document wins over the lattice pose).
  const centre = vadd(def.position, qrot(def.rotation, att.center));
  const delta = vsub(target.world, centre);
  const shift = vlen(delta) > 1e-4;
  for (const i of particles) {
    if (shift) {
      const p = rec.root.particlePosition(i);
      rec.root.setParticlePosition(i, rv([p.x + delta[0], p.y + delta[1], p.z + delta[2]]));
    }
    rec.root.attachParticle(i, b.rb);
  }
  rec.attached.push({ att, particles, bodyHandle: b.rb.handle });
  b.rb.wakeUp();
  return true;
}

/** Try to fasten every attachment that is not fastened yet (called on build, after bodies appear, and per step). */
export function resolveAttachments(s: WorldState, rec: SoftRec): void {
  for (const att of rec.def.attachments) {
    if (rec.released.has(att.id) || rec.attached.some((a) => a.att.id === att.id)) continue;
    fasten(s, rec, att);
  }
}

export function releaseAttachment(rec: SoftRec, id: string): void {
  for (const a of rec.attached)
    if (a.att.id === id && rec.root.isValid()) for (const i of a.particles) rec.root.detachParticle(i);
  rec.attached = rec.attached.filter((a) => a.att.id !== id);
  rec.released.add(id);
}

/** Release every fastening of one soft body (all ids, or one). */
export function releaseSoftAttachments(s: WorldState, id: string, attachmentId?: string): void {
  const rec = s.softs.get(id);
  if (!rec) return;
  const ids = attachmentId ? [attachmentId] : rec.def.attachments.map((a) => a.id);
  for (const a of ids) releaseAttachment(rec, a);
}

/** Per-step upkeep: broken joints and removed / rebuilt bodies release their fastenings; late bodies get fastened. */
export function updateAttachments(s: WorldState): void {
  for (const rec of s.softOrder) {
    const atts = rec.def.attachments;
    if (!atts.length) continue;
    for (const a of [...rec.attached]) {
      const body = s.bodies.get(a.att.body);
      const jointBroken = a.att.joint ? (s.joints.get(a.att.joint)?.broken ?? true) : false;
      if (jointBroken) releaseAttachment(rec, a.att.id);
      else if (!body || body.rb.handle !== a.bodyHandle) {
        // body removed → release for good; body rebuilt by an edit → fasten again to the new one
        for (const i of a.particles) if (rec.root.isValid()) rec.root.detachParticle(i);
        rec.attached = rec.attached.filter((x) => x !== a);
        if (!body) rec.released.add(a.att.id);
      }
    }
    if (rec.attached.length < atts.length) resolveAttachments(s, rec);
  }
}

/** Release every fastening to a body that is about to be removed (the engine would leave a dangling attachment). */
export function detachBody(s: WorldState, bodyId: string): void {
  for (const rec of s.softOrder)
    for (const a of [...rec.attached])
      if (a.att.body === bodyId) {
        for (const i of a.particles) if (rec.root.isValid()) rec.root.detachParticle(i);
        rec.attached = rec.attached.filter((x) => x !== a);
        rec.released.add(a.att.id);
      }
}
