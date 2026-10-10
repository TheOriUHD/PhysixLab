/**
 * The events channel of the world: collider ownership, the engine's event queue, `sensor` events (a body entering
 * or leaving a sensor collider) and aggregated, rate-limited `contact` events.
 *
 * The engine reports *started* / *stopped* collision events per collider pair after every (sub-)step. Sensor pairs
 * become `enter` / `exit` events at once. A started contact between two solid colliders becomes a pending contact;
 * while it is pending its impulse is re-read every fixed step (the strongest value wins) and at the end of the frame
 * (`flushContacts`) pending contacts are filtered (`minImpulse`), rate-limited per pair (`pairInterval`), capped
 * (`maxPerFrame`, strongest first) and turned into `ContactEvent`s. Contact events are only generated while
 * `contactEventsOn(s)`; the engine's per-collider event flags are switched with `applyEventFlags`.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3 } from '../../core/math';
import { GROUND_ID, type ContactEvent, type EventConfig } from '../protocol';
import type { BodyRec, ColliderOwner, PendingContact, WorldState } from './state';

const COLLISION_EVENTS = RAPIER.ActiveEvents.COLLISION_EVENTS;

/** Contact events are generated when configured or when a component watches contacts. */
export function contactEventsOn(s: WorldState): boolean {
  return s.eventCfg.contacts || s.contactWatchers > 0;
}

/** Engine event flags a collider needs: sensors always report; solid colliders only while contact events are on. */
function flagsFor(s: WorldState, o: ColliderOwner): number {
  return o.sensor || contactEventsOn(s) ? COLLISION_EVENTS : 0;
}

/** Record who owns each collider of `rec` and switch on the events they need. */
export function registerColliders(s: WorldState, rec: BodyRec): void {
  rec.cols.forEach((col, i) => {
    const part = rec.colParts[i];
    const owner: ColliderOwner = { id: rec.id, part: part?.id, rec, sensor: col.isSensor() };
    s.owners.set(col.handle, owner);
    const f = flagsFor(s, owner);
    if (f) col.setActiveEvents(f);
  });
}

/** Forget the colliders of a body that is being removed (kept briefly so their final `exit` events can still be named). */
export function unregisterColliders(s: WorldState, rec: BodyRec): void {
  for (const col of rec.cols) {
    const owner = s.owners.get(col.handle);
    if (!owner) continue;
    s.owners.delete(col.handle);
    s.retired.set(col.handle, { ...owner, rec: null });
    for (const [key, p] of s.pendingContacts)
      if (p.h1 === col.handle || p.h2 === col.handle) s.pendingContacts.delete(key);
  }
}

/** The ground slab is owned by nobody but reports contacts as `GROUND_ID`. */
export function registerGround(s: WorldState): void {
  if (!s.ground) return;
  const owner: ColliderOwner = { id: GROUND_ID, part: undefined, rec: null, sensor: false };
  s.owners.set(s.ground.col.handle, owner);
  const f = flagsFor(s, owner);
  if (f) s.ground.col.setActiveEvents(f);
}

export function unregisterGround(s: WorldState): void {
  if (s.ground) s.owners.delete(s.ground.col.handle);
}

/** Re-apply the event flags to every collider (the contact-event switch changed). */
export function applyEventFlags(s: WorldState): void {
  for (const [handle, owner] of s.owners) {
    const col = s.world.getCollider(handle);
    col.setActiveEvents(flagsFor(s, owner));
  }
}

/** `{ op: 'events' }`: merge a configuration change. */
export function configureEvents(s: WorldState, patch: Partial<EventConfig>): void {
  const was = contactEventsOn(s);
  s.eventCfg = {
    contacts: patch.contacts ?? s.eventCfg.contacts,
    minImpulse: Math.max(0, patch.minImpulse ?? s.eventCfg.minImpulse),
    pairInterval: Math.max(0, patch.pairInterval ?? s.eventCfg.pairInterval),
    maxPerFrame: Math.max(1, Math.floor(patch.maxPerFrame ?? s.eventCfg.maxPerFrame)),
  };
  if (contactEventsOn(s) !== was) {
    applyEventFlags(s);
    if (!contactEventsOn(s)) s.pendingContacts.clear();
  }
}

/** A component starts / stops watching contacts (reference-counted). */
export function watchContacts(s: WorldState, on: boolean): void {
  const was = contactEventsOn(s);
  s.contactWatchers = Math.max(0, s.contactWatchers + (on ? 1 : -1));
  if (contactEventsOn(s) !== was) {
    applyEventFlags(s);
    if (!contactEventsOn(s)) s.pendingContacts.clear();
  }
}

/**
 * Unordered pair of collider handles as a map key. Engine handles are doubles that carry an index and a generation
 * in their raw bits (denormal numbers: 0, 5e-324, …), so arithmetic on them is not exact — compare and print them only.
 */
const pairKey = (a: number, b: number): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Drain the engine's event queue after an engine step. `t` is the simulation time at the end of the step.
 * Sensor events are appended to `s.events` (and offered to the components of the bodies involved) right away;
 * started contacts between solid colliders are queued as pending.
 */
export function collectEvents(s: WorldState, t: number): void {
  s.eventQueue.drainCollisionEvents((h1, h2, started) => {
    const o1 = s.owners.get(h1) ?? s.retired.get(h1);
    const o2 = s.owners.get(h2) ?? s.retired.get(h2);
    if (!o1 || !o2) return;
    if (o1.sensor || o2.sensor) {
      if (o1.sensor && o2.sensor) return;
      const [sensor, other] = o1.sensor ? [o1, o2] : [o2, o1];
      const ev = {
        kind: 'sensor' as const,
        phase: started ? ('enter' as const) : ('exit' as const),
        t,
        sensor: sensor.id,
        ...(sensor.part !== undefined ? { part: sensor.part } : {}),
        other: other.id,
      };
      s.events.push(ev);
      s.host.dispatch(ev);
      return;
    }
    if (!started || !contactEventsOn(s)) return;
    const key = pairKey(h1, h2);
    const blank = (): PendingContact => ({
      h1,
      h2,
      o1,
      o2,
      t,
      count: 1,
      impulse: 0,
      speed: 0,
      point: [0, 0, 0],
      normal: [0, 1, 0],
    });
    const agg = s.pendingContacts.get(key);
    if (agg) agg.count++;
    else s.pendingContacts.set(key, blank());
    // Watching components see every contact start, un-aggregated (see `stepPending`).
    if (s.contactWatchers > 0) s.freshContacts.push(blank());
  });
  // Owners of colliders removed since the last drain were only needed to name the events just collected. They are
  // forgotten here, not at the end of a frame: a frame without a step (paused, or shorter than a fixed step) must not
  // lose the exit event of a body that was removed while inside a sensor.
  s.retired.clear();
}

/** Read the manifold of a contact pair into `p` (impulse, strongest-so-far, point, normal, approach speed). */
function readContact(s: WorldState, p: PendingContact): void {
  const c1 = s.world.getCollider(p.h1);
  const c2 = s.world.getCollider(p.h2);
  s.world.contactPair(c1, c2, (m, flipped) => {
    const nc = m.numContacts();
    let impulse = 0;
    for (let i = 0; i < nc; i++) impulse += m.contactImpulse(i);
    if (m.numSolverContacts() === 0 || impulse <= p.impulse) return;
    const sp = m.solverContactPoint(0);
    const n = m.normal();
    // The manifold normal runs from its first collider to its second; `flipped` says our `c1` is the second one.
    // Store it pointing out of collider 2 toward collider 1.
    const sgn = flipped ? 1 : -1;
    p.impulse = impulse;
    p.normal = [n.x * sgn, n.y * sgn, n.z * sgn];
    if (sp) p.point = [sp.x, sp.y, sp.z];
    p.speed = approachSpeed(s, p, impulse);
  });
}

/**
 * Re-read the manifold of every pending contact and keep the strongest impulse (the engine applies the bounce in
 * the step the contact starts, but a stack settling or a glancing hit may peak a step later).
 */
export function refreshPending(s: WorldState): void {
  for (const [key, p] of s.pendingContacts) {
    if (!s.owners.has(p.h1) || !s.owners.has(p.h2)) {
      s.pendingContacts.delete(key);
      continue;
    }
    readContact(s, p);
  }
}

/** Approach speed from the contact impulse: J = m_eff·(1 + e)·v for a central impact (restitution combines as a maximum). */
function approachSpeed(s: WorldState, p: PendingContact, impulse: number): number {
  const m1 = p.o1.rec ? p.o1.rec.mass : 0;
  const m2 = p.o2.rec ? p.o2.rec.mass : 0;
  const inv = (m1 > 0 ? 1 / m1 : 0) + (m2 > 0 ? 1 / m2 : 0);
  if (inv <= 0) return 0;
  const e = Math.max(restitutionOf(s, p.o1, p.h1), restitutionOf(s, p.o2, p.h2));
  return (impulse * inv) / (1 + e);
}

function restitutionOf(s: WorldState, o: ColliderOwner, handle: number): number {
  return o.rec || o.id === GROUND_ID ? s.world.getCollider(handle).restitution() : 0;
}

/**
 * Called once per fixed step after the engine events were collected. Components that watch contacts get theirs
 * here, at the end of the step the contact started in — step-synchronous, so their behaviour never depends on how
 * the page's frames happen to fall (the aggregated stream for the page is built per frame in `flushContacts`).
 */
export function stepPending(s: WorldState): void {
  refreshPending(s);
  const fresh = s.freshContacts;
  if (!fresh.length) return;
  s.freshContacts = [];
  for (const p of fresh) {
    if (!s.owners.has(p.h1) || !s.owners.has(p.h2)) continue;
    readContact(s, p);
    s.host.dispatch(toEvent(p));
  }
}

/**
 * End of frame: turn the pending contacts into events for the page (strongest first, at most `maxPerFrame`).
 */
export function flushContacts(s: WorldState): void {
  if (!s.pendingContacts.size) return;
  refreshPending(s);
  const cfg = s.eventCfg;
  const ready: ContactEvent[] = [];
  for (const [key, p] of s.pendingContacts) {
    if (p.impulse < cfg.minImpulse) continue;
    const last = s.lastContactAt.get(key);
    if (last !== undefined && p.t - last < cfg.pairInterval) continue;
    s.lastContactAt.set(key, p.t);
    ready.push(toEvent(p));
  }
  s.pendingContacts.clear();
  ready.sort((a, b) => b.impulse - a.impulse || a.t - b.t);
  if (ready.length > cfg.maxPerFrame) ready.length = cfg.maxPerFrame;
  for (const ev of ready) s.events.push(ev);
  if (s.lastContactAt.size > 4096) {
    for (const [k, at] of s.lastContactAt) if (s.simTime - at > 5) s.lastContactAt.delete(k);
  }
}

function toEvent(p: PendingContact): ContactEvent {
  // Order the pair: the ground last, otherwise the older body first. The stored normal points out of o2 toward o1.
  let [a, b, n]: [ColliderOwner, ColliderOwner, Vec3] = [p.o1, p.o2, p.normal];
  const rank = (o: ColliderOwner) => (o.rec ? o.rec.seq : Number.MAX_SAFE_INTEGER);
  if (rank(a) > rank(b)) {
    [a, b] = [b, a];
    n = [-n[0], -n[1], -n[2]];
  }
  return {
    kind: 'contact',
    t: p.t,
    a: a.id,
    b: b.id,
    point: p.point,
    normal: n,
    impulse: p.impulse,
    speed: p.speed,
    matA: a.rec ? a.rec.def.material.preset : 'ground',
    matB: b.rec ? b.rec.def.material.preset : 'ground',
    count: p.count,
  };
}
