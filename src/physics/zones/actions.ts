/**
 * What a zone does (ZN-2): the code behind each `action` of the `zone` component. The component runtime
 * (`physics/components/zone.ts`) tracks who is inside and decides *when*; this file decides *what happens*:
 *
 *   fire(...)           once per entering unit — race actions, kill, respawn point, teleport, launch, spawn, sound,
 *                       score / label, enable / disable, custom event;
 *   applyField(...)     every step for each body inside — gravity override and force field;
 *   timerSpawn(...)     the spawner's steady rate.
 *
 * Actions are queued by the sensor event and run at the end of the same fixed step (`poststep`), never from inside
 * the engine's event drain.
 */
import { qconj, qmul, qnorm, qrot, vadd, vlen, vscale, vsub, type Quat, type Vec3 } from '../../core/math';
import { bodyBoundingRadius } from '../../model/compound';
import type { BodyEntity } from '../../model/types';
import type { ComponentContext } from '../components/context';
import type { EventSource, ZoneRec } from './system';

/** Actions that fire once for each unit that enters. */
export const INSTANT_ACTIONS = new Set([
  'kill',
  'respawnAt',
  'teleport',
  'launch',
  'spawn',
  'sound',
  'score',
  'toggle',
  'custom',
]);
/** Actions where `unit: group` applies. */
export const UNIT_ACTIONS = new Set(['checkpoint', 'start', 'finish', 'kill', 'respawnAt', 'teleport', 'launch']);

/** A unit entered (queued by the sensor event, run by `fire` at the end of the step). */
export interface Job {
  /** The body that entered (the first of its unit). */
  body: string;
  /** The unit it counts as: the body, or its group. */
  unit: string;
  /** Simulation time of the event (the end of the step the overlap began in). */
  t: number;
}

/** Per-instance state of a zone component. */
export interface ZoneState {
  rec: ZoneRec;
  /** Overlapping collider pairs per body (a body is inside while it has at least one). */
  overlaps: Map<string, number>;
  /** Bodies of each unit that are inside; a unit enters when its first body does, leaves with its last. */
  units: Map<string, number>;
  unitOfBody: Map<string, string>;
  lastStay: Map<string, number>;
  lastFire: Map<string, number>;
  entered: number;
  fired: number;
  queue: Job[];
  spawnAcc: number;
  spawnN: number;
  template: BodyEntity | null;
  templateTried: boolean;
  /** For "undo on exit": what to switch back. */
  revert: { target: string; type: string; enabled: boolean } | null;
  /** The last unit left: switch the components back at the end of the step. */
  revertDue: boolean;
}

export function newZoneState(rec: ZoneRec): ZoneState {
  return {
    rec,
    overlaps: new Map(),
    units: new Map(),
    unitOfBody: new Map(),
    lastStay: new Map(),
    lastFire: new Map(),
    entered: 0,
    fired: 0,
    queue: [],
    spawnAcc: 0,
    spawnN: 0,
    template: null,
    templateTried: false,
    revert: null,
    revertDue: false,
  };
}

/** `"a, b ,c"` → `['a', 'b', 'c']`. */
export function parseList(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Does a body pass the zone's filter (kind of body, tags, layers)? */
export function qualifies(ctx: ComponentContext, def: BodyEntity): boolean {
  switch (ctx.str('types')) {
    case 'dynamic':
      if (def.bodyType !== 'dynamic') return false;
      break;
    case 'kinematic':
      if (def.bodyType !== 'kinematic') return false;
      break;
    default:
      if (def.bodyType === 'static') return false;
  }
  const only = parseList(ctx.str('tags'));
  if (only.length && !def.tags.some((t) => only.includes(t))) return false;
  const not = parseList(ctx.str('notTags'));
  if (not.length && def.tags.some((t) => not.includes(t))) return false;
  const layers = parseList(ctx.str('layers'));
  if (layers.length && !layers.includes(def.layer)) return false;
  return true;
}

export function zoneLabel(ctx: ComponentContext): string {
  const label = ctx.str('label').trim();
  if (label) return label;
  const body = ctx.body;
  return body?.alive ? body.def.name : 'Zone';
}

export function zoneSource(ctx: ComponentContext): EventSource {
  return { owner: ctx.ownerId, component: ctx.componentId, type: 'zone', zone: zoneLabel(ctx) };
}

// ── one-shot actions ───────────────────────────────────────────────────────────────────────────────────

export function fire(st: ZoneState, ctx: ComponentContext, job: Job): void {
  const action = ctx.str('action');
  if (action === 'none' || action === 'gravity' || action === 'force') return;
  const zones = ctx.zones;
  if (!zones.isActive(job.body)) return;
  const group = ctx.str('unit') === 'group' && UNIT_ACTIONS.has(action);
  if (INSTANT_ACTIONS.has(action)) {
    const limit = ctx.num('maxTriggers');
    if (limit > 0 && st.fired >= limit) return;
    const cooldown = ctx.num('cooldown');
    const last = st.lastFire.get(job.unit);
    if (cooldown > 0 && last !== undefined && job.t - last < cooldown) return;
    if (action === 'teleport' && zones.isImmune(job.body)) return;
    st.lastFire.set(job.unit, job.t);
  }
  st.fired++;
  const src = zoneSource(ctx);
  const ref = { body: job.body, unit: job.unit, zone: src.zone };
  const raceRef = { race: ctx.str('race'), racer: job.unit, body: job.body, zone: src.zone };
  switch (action) {
    case 'start': {
      const race = ctx.str('race');
      const out = zones.races.start(race, job.unit, job.t, zones.raceSpec(race), zones.born(job.unit));
      if (out.kind === 'started') zones.emit(src, 'start', { ...raceRef, time: out.time });
      zones.touch();
      break;
    }
    case 'checkpoint': {
      const race = ctx.str('race');
      const index = Math.round(ctx.num('index'));
      const out = zones.races.checkpoint(race, job.unit, index, job.t, zones.raceSpec(race), zones.born(job.unit));
      if (out.kind === 'passed') {
        zones.captureRespawn(job.body, group);
        zones.emit(src, 'checkpoint', {
          ...raceRef,
          index,
          split: out.split,
          delta: out.delta,
          lap: out.lap,
        });
      } else if (out.kind === 'skipped')
        zones.emit(src, 'skipped', { ...raceRef, index: out.index, expected: out.expected });
      zones.touch();
      break;
    }
    case 'finish': {
      const race = ctx.str('race');
      const out = zones.races.finishLine(
        race,
        job.unit,
        job.t,
        { laps: Math.round(ctx.num('laps')), requireAll: ctx.bool('requireAll'), startsClock: ctx.bool('startsClock') },
        zones.raceSpec(race),
        zones.born(job.unit),
      );
      if (out.kind === 'started') zones.emit(src, 'start', { ...raceRef, time: out.time });
      else if (out.kind === 'lap') {
        zones.captureRespawn(job.body, group);
        zones.emit(src, 'lap', { ...raceRef, ...out.lap });
        if (out.finish) zones.emit(src, 'finish', { ...raceRef, ...out.finish });
      } else if (out.kind === 'skipped')
        zones.emit(src, 'skipped', { ...raceRef, index: out.index, expected: out.expected });
      zones.touch();
      break;
    }
    case 'kill':
      zones.lose(job.body, {
        mode: ctx.str('killMode') === 'respawn' ? 'respawn' : 'remove',
        to: ctx.str('respawnTo') === 'start' ? 'start' : 'checkpoint',
        delay: ctx.num('respawnDelay'),
        penalty: ctx.num('penalty'),
        penaltyPoints: ctx.num('penaltyPoints'),
        max: Math.round(ctx.num('maxRespawns')),
        cause: 'zone',
        group,
        source: src,
      });
      break;
    case 'respawnAt': {
      const dest = destination(ctx, job.body);
      if (!dest) break;
      zones.setRespawnUnit(job.body, group, dest.position, dest.rotation);
      if (ctx.bool('moveNow')) {
        const from = ctx.bodyById(job.body)?.position() ?? dest.position;
        zones.moveUnit(job.body, group, dest.position, dest.rotation, 'stop');
        zones.emit(src, 'teleport', { ...ref, from, to: dest.position });
      }
      break;
    }
    case 'teleport':
      teleportUnit(ctx, src, ref, job, group);
      break;
    case 'launch':
      launchUnit(ctx, src, ref, job, group);
      break;
    case 'spawn':
      if (ctx.str('when') === 'enter') spawnCopy(st, ctx, job.t);
      break;
    case 'sound': {
      const zb = ctx.body;
      zones.emit(src, 'sound', {
        sound: ctx.str('sound'),
        volume: ctx.num('volume'),
        pitch: ctx.num('pitch'),
        at: zb?.position() ?? [0, 0, 0],
        body: job.body,
      });
      break;
    }
    case 'score': {
      const points = ctx.num('points');
      const message = ctx.str('message');
      zones.addScore(points, job.unit);
      zones.flash(message);
      zones.emit(src, 'score', { ...ref, points, total: zones.score.total, message });
      break;
    }
    case 'toggle':
      toggleComponents(st, ctx, src, job);
      break;
    case 'custom':
      zones.emit(src, 'custom', { ...ref, event: ctx.str('customEvent'), payload: ctx.str('payload'), phase: 'enter' });
      break;
  }
}

/** Where a respawn point / teleport sends a body: the target body's pose with the offset in its frame, or the world position. */
function destination(ctx: ComponentContext, bodyId: string): { position: Vec3; rotation: Quat; frame: Quat } | null {
  const targetId = ctx.str('target');
  const offset = ctx.vec3('offset');
  if (targetId) {
    const t = ctx.bodyById(targetId);
    if (!t?.alive) return null;
    const q = t.rotation();
    return { position: vadd(t.position(), qrot(q, offset)), rotation: q, frame: q };
  }
  const body = ctx.bodyById(bodyId);
  if (!body) return null;
  return { position: [...offset], rotation: body.rotation(), frame: ctx.body?.rotation() ?? [0, 0, 0, 1] };
}

function teleportUnit(
  ctx: ComponentContext,
  src: EventSource,
  ref: { body: string; unit: string; zone: string },
  job: Job,
  group: boolean,
): void {
  const zones = ctx.zones;
  const zoneBody = ctx.body;
  const body = ctx.bodyById(job.body);
  const dest = destination(ctx, job.body);
  if (!zoneBody || !body || !dest) return;
  const zq = zoneBody.rotation();
  // The portal's turn: the target frame relative to the zone's (none when teleporting to a point).
  const turn: Quat = ctx.str('target') ? qnorm(qmul(dest.frame, qconj(zq))) : [0, 0, 0, 1];
  const from = body.position();
  let position = dest.position;
  if (ctx.str('mapping') === 'relative') {
    position = vadd(dest.position, qrot(turn, vsub(from, zoneBody.position())));
  }
  const bq = body.rotation();
  const orientation = ctx.str('orientation');
  const rotation: Quat =
    orientation === 'match' ? dest.rotation : orientation === 'rotate' ? qnorm(qmul(turn, bq)) : bq;
  const velocity = ctx.str('velocity');
  zones.moveUnit(
    job.body,
    group,
    position,
    rotation,
    velocity === 'stop' ? 'stop' : velocity === 'rotate' ? 'rotate' : 'keep',
    turn,
  );
  const until = job.t + Math.max(0.5, ctx.num('cooldown'));
  for (const m of zones.membersOf(job.body, group)) zones.setImmune(m.id, until);
  zones.emit(src, 'teleport', { ...ref, from, to: position });
}

function launchUnit(
  ctx: ComponentContext,
  src: EventSource,
  ref: { body: string; unit: string; zone: string },
  job: Job,
  group: boolean,
): void {
  const zones = ctx.zones;
  const zq = ctx.body?.rotation() ?? [0, 0, 0, 1];
  const raw = ctx.vec3('launch');
  const vec = ctx.str('space') === 'world' ? raw : qrot(zq, raw);
  const members = zones
    .membersOf(job.body, group)
    .map((m) => ctx.bodyById(m.id))
    .filter((b) => b && b.alive && b.type === 'dynamic' && zones.isActive(b.id));
  if (!members.length) return;
  const mode = ctx.str('launchMode') === 'impulse' ? 'impulse' : 'deltaV';
  const total = members.reduce((m, b) => m + (b?.mass ?? 0), 0);
  for (const b of members) {
    if (!b) continue;
    if (mode === 'deltaV') {
      const v = b.linvel();
      b.setVelocity([v[0] + vec[0], v[1] + vec[1], v[2] + vec[2]]);
    } else if (total > 0) b.applyImpulse(vscale(vec, b.mass / total));
  }
  zones.emit(src, 'launch', { ...ref, mode, vector: vec });
}

function toggleComponents(st: ZoneState, ctx: ComponentContext, src: EventSource, job: Job): void {
  const zones = ctx.zones;
  const target = ctx.str('target');
  const rec = zones.rec(target);
  if (!rec) return;
  const type = ctx.str('componentType');
  const matching = rec.def.components.filter((c) => (type === '' ? c.type !== 'zone' : c.type === type));
  if (!matching.length) return;
  const mode = ctx.str('switchTo');
  const enabled = mode === 'enable' ? true : mode === 'disable' ? false : !matching.some((c) => c.enabled);
  const changed = zones.setComponentsEnabled(target, type, enabled);
  if (ctx.bool('revertOnExit')) st.revert = { target, type, enabled: !enabled };
  zones.emit(src, 'toggle', { target, componentType: type, enabled, changed, body: job.body });
}

/** The last unit left: put switched components back ("undo on exit"). */
export function revertToggle(st: ZoneState, ctx: ComponentContext): void {
  const r = st.revert;
  if (!r) return;
  st.revert = null;
  const changed = ctx.zones.setComponentsEnabled(r.target, r.type, r.enabled);
  ctx.zones.emit(zoneSource(ctx), 'toggle', {
    target: r.target,
    componentType: r.type,
    enabled: r.enabled,
    changed,
    body: '',
  });
}

// ── spawning ───────────────────────────────────────────────────────────────────────────────────────────

/** Capture the template on the first step (every body of the scene exists by then) and hide the original if asked. */
export function captureTemplate(st: ZoneState, ctx: ComponentContext): void {
  if (st.templateTried || ctx.str('action') !== 'spawn') return;
  const id = ctx.str('template');
  if (!id || id === ctx.ownerId) return;
  const b = ctx.bodyById(id);
  if (!b?.alive) return; // not there (yet): try again next step
  st.templateTried = true;
  st.template = b.def;
  if (ctx.bool('consume')) ctx.zones.removeBody(id, 'kill');
}

/** Make a copy of the template at the zone (if fewer than `maxAlive` copies of this spawner are alive). */
export function spawnCopy(st: ZoneState, ctx: ComponentContext, _t: number): void {
  const tpl = st.template;
  const zb = ctx.body;
  if (!tpl || !zb) return;
  const zones = ctx.zones;
  if (zones.aliveFrom(ctx.componentId) >= Math.round(ctx.num('maxAlive'))) return;
  const n = ++st.spawnN;
  const id = `s_${ctx.componentId}_${n}`.slice(0, 60);
  const zq = zb.rotation();
  const position = vadd(zb.position(), qrot(zq, ctx.vec3('spawnOffset')));
  const sv = ctx.vec3('spawnVelocity');
  const velocity: Vec3 = vlen(sv) > 0 ? qrot(zq, sv) : [...tpl.velocity];
  const def: BodyEntity = {
    ...tpl,
    id,
    position,
    velocity,
    hidden: false,
    locked: false,
    parent: undefined,
    components: tpl.components.map((c, i) => ({ ...c, id: `${id}_${i}`.slice(0, 64), params: { ...c.params } })),
  };
  zones.spawnBody(def, ctx.componentId, ctx.num('lifetime'));
  zones.emit(zoneSource(ctx), 'spawn', {
    body: id,
    def,
    source: ctx.componentId,
    alive: zones.aliveFrom(ctx.componentId),
  });
}

/** The steady rate of a timer spawner. */
export function timerSpawn(st: ZoneState, ctx: ComponentContext, dt: number): void {
  if (ctx.str('action') !== 'spawn' || ctx.str('when') !== 'timer') return;
  st.spawnAcc += dt;
  const every = Math.max(0.05, ctx.num('interval'));
  if (st.spawnAcc + 1e-9 < every) return;
  st.spawnAcc -= every;
  if (st.spawnAcc > every) st.spawnAcc = 0; // fell behind: do not burst
  spawnCopy(st, ctx, ctx.time);
}

// ── continuous actions ─────────────────────────────────────────────────────────────────────────────────

const F: Vec3 = [0, 0, 0];
const P: Vec3 = [0, 0, 0];

/** Gravity override and force field: acts on every body inside, every step (no allocation per body). */
export function applyField(st: ZoneState, ctx: ComponentContext): void {
  const action = ctx.str('action');
  if (action !== 'gravity' && action !== 'force') return;
  const inside = st.rec.inside;
  if (!inside.size) return;
  const zb = ctx.body;
  if (!zb) return;
  const zones = ctx.zones;
  if (action === 'gravity') {
    const g = ctx.vec3('gravity');
    const world = zones.gravity;
    for (const id of inside.keys()) {
      if (zones.gravityWinner(id) !== ctx.componentId) continue;
      const b = ctx.bodyById(id);
      if (!b?.alive || b.type !== 'dynamic' || !zones.isActive(id)) continue;
      // The engine already applies gravityScale·g; add what is missing to reach the zone's gravity.
      const k = b.def.gravityScale;
      const m = b.mass;
      F[0] = m * (g[0] - world[0] * k);
      F[1] = m * (g[1] - world[1] * k);
      F[2] = m * (g[2] - world[2] * k);
      if (F[0] !== 0 || F[1] !== 0 || F[2] !== 0) b.applyForce(F);
    }
    return;
  }
  const mode = ctx.str('forceMode');
  const perMass = ctx.bool('perMass');
  const centre = zb.position();
  const radius = Math.max(0.01, bodyBoundingRadius(zb.def));
  const falloff = ctx.str('falloff');
  const strength = ctx.num('strength');
  let uniform: Vec3 = [0, 0, 0];
  if (mode === 'uniform') {
    const raw = ctx.vec3('force');
    uniform = ctx.str('space') === 'world' ? raw : qrot(zb.rotation(), raw);
  }
  for (const id of inside.keys()) {
    const b = ctx.bodyById(id);
    if (!b?.alive || b.type !== 'dynamic' || !zones.isActive(id)) continue;
    const m = perMass ? b.mass : 1;
    if (mode === 'uniform') {
      F[0] = uniform[0] * m;
      F[1] = uniform[1] * m;
      F[2] = uniform[2] * m;
    } else {
      // toward (attract) or away from (repel) the zone's centre, scaled by the falloff at the body's distance
      const p = b.position(P);
      const dx = centre[0] - p[0];
      const dy = centre[1] - p[1];
      const dz = centre[2] - p[2];
      const r = Math.hypot(dx, dy, dz);
      const fall =
        falloff === 'linear'
          ? Math.max(0, 1 - r / radius)
          : falloff === 'inverse'
            ? Math.min(16, (radius / Math.max(r, 0.25 * radius)) ** 2)
            : 1;
      const k = r > 1e-9 ? ((mode === 'attract' ? 1 : -1) * strength * fall * m) / r : 0;
      F[0] = dx * k;
      F[1] = dy * k;
      F[2] = dz * k;
    }
    b.applyForce(F);
  }
}
