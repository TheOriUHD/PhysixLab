/**
 * A hash of the simulation state, for the determinism checks (TM-7) and the replay checkpoints (TM-4): two worlds
 * that hash equal at the same step are, for every practical purpose, in the same state. It folds in the exact bits
 * of every body's pose and velocity, joint break state and angle, soft-body particles, the clock, the RNG and the
 * state the components save.
 */
import type { WorldState } from './state';

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

class Acc {
  a = 0x811c9dc5 | 0;
  b = 0x01000193 | 0;
  num(v: number): void {
    f64[0] = v;
    this.word(u32[0]);
    this.word(u32[1]);
  }
  word(w: number): void {
    this.a = Math.imul(this.a ^ w, 16777619);
    this.a ^= this.a >>> 15;
    this.b = Math.imul(this.b + w, 0x85ebca6b);
    this.b ^= this.b >>> 13;
  }
  str(t: string): void {
    for (let i = 0; i < t.length; i++) this.word(t.charCodeAt(i));
  }
  get hex(): string {
    return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
  }
}

export function stateHash(s: WorldState): string {
  const h = new Acc();
  h.num(s.stepCount);
  h.num(s.simTime);
  h.word(s.rng.state);
  for (const r of s.order) {
    h.word(r.disabled ? 1 : 0);
    const t = r.rb.translation();
    const q = r.rb.rotation();
    const v = r.rb.linvel();
    const w = r.rb.angvel();
    h.num(t.x);
    h.num(t.y);
    h.num(t.z);
    h.num(q.x);
    h.num(q.y);
    h.num(q.z);
    h.num(q.w);
    h.num(v.x);
    h.num(v.y);
    h.num(v.z);
    h.num(w.x);
    h.num(w.y);
    h.num(w.z);
  }
  for (const j of s.jointOrder) {
    h.word(j.broken ? 1 : 0);
    h.num(j.angle);
    h.num(j.motorTarget);
  }
  for (const sb of s.world.softBodies.getAll()) {
    const p = sb.particlePositions();
    for (let i = 0; i < p.length; i++) h.num(p[i]);
  }
  const comps = s.host.saveStates();
  // in execution order, without the ids, so equal states hash equal whatever the entities are called
  for (const saved of Object.values(comps)) h.str(JSON.stringify(saved) ?? '');
  return h.hex;
}
