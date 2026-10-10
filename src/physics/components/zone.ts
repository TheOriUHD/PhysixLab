/**
 * Runtime of the `zone` component (definition: `src/model/components/zone.ts`, vocabulary: `src/model/zones.ts`).
 *
 * The engine reports sensor overlaps as `enter` / `exit` events (protocol v2); the host routes them to the components
 * of the sensor's body. This runtime keeps the set of bodies inside (one count per overlapping collider pair, so a
 * compound body or a compound zone is "inside" until its last collider leaves), applies the zone's filter, raises the
 * `enter` / `exit` / `stay` events for logic, scripts and the game layer, and hands each *unit* that enters (a body, or
 * its whole group) to `fire` — queued here, run at the end of the same fixed step, never from inside the engine's event
 * drain. Continuous actions (gravity override, force field, timer spawner) run in `prestep`.
 */
import {
  applyField,
  captureTemplate,
  fire,
  newZoneState,
  qualifies,
  revertToggle,
  timerSpawn,
  UNIT_ACTIONS,
  zoneSource,
  type ZoneState,
} from '../zones/actions';
import type { BodyEntity } from '../../model/types';
import type { ZoneRec } from '../zones/system';
import type { ComponentContext } from './context';
import type { ComponentRuntime } from './registry';

const groupMode = (ctx: ComponentContext): boolean =>
  ctx.str('unit') === 'group' && UNIT_ACTIONS.has(ctx.str('action'));

/** A body is now inside (its first overlapping collider pair began). */
function join(st: ZoneState, ctx: ComponentContext, id: string, t: number, announce: boolean): void {
  st.rec.inside.set(id, t);
  st.lastStay.set(id, t);
  const unit = ctx.zones.unitOf(id, groupMode(ctx));
  st.unitOfBody.set(id, unit);
  const count = (st.units.get(unit) ?? 0) + 1;
  st.units.set(unit, count);
  if (!announce) return; // already inside when the zone started: no enter event, no action
  st.entered++;
  if (ctx.bool('emitEnter')) {
    const src = zoneSource(ctx);
    ctx.zones.emit(src, 'enter', { body: id, unit, zone: src.zone, inside: st.rec.inside.size }, t);
  }
  if (count === 1) st.queue.push({ body: id, unit, t });
}

/** A body left (its last overlapping collider pair ended, or it was switched off). */
function leave(st: ZoneState, ctx: ComponentContext, id: string, t?: number): void {
  if (!st.rec.inside.delete(id)) return;
  st.lastStay.delete(id);
  const unit = st.unitOfBody.get(id) ?? id;
  st.unitOfBody.delete(id);
  const c = (st.units.get(unit) ?? 1) - 1;
  if (c <= 0) st.units.delete(unit);
  else st.units.set(unit, c);
  if (ctx.bool('emitExit')) {
    const src = zoneSource(ctx);
    ctx.zones.emit(src, 'exit', { body: id, unit, zone: src.zone, inside: st.rec.inside.size }, t);
  }
  if (!st.units.size && st.revert && ctx.bool('revertOnExit')) st.revertDue = true;
}

export const zone: ComponentRuntime<ZoneState> = {
  type: 'zone',

  create(ctx) {
    const rec: ZoneRec = { componentId: ctx.componentId, ownerId: ctx.ownerId, ctx, inside: new Map() };
    const st = newZoneState(rec);
    ctx.zones.register(rec);
    ctx.zones.armSensors(ctx.ownerId);
    // Bodies that already overlap the sensor (the component was switched on, or the zone rebuilt, while they are
    // inside) belong to the zone from now on, silently: they entered before.
    for (const [id, n] of ctx.zones.overlapping(ctx.ownerId)) {
      const b = ctx.zones.rec(id);
      if (!b || b.disabled || !qualifies(ctx, b.def)) continue;
      st.overlaps.set(id, n);
      join(st, ctx, id, ctx.time, false);
    }
    return st;
  },

  // Every parameter is read fresh from `ctx`, so edits made while the simulation runs need no work.
  paramsChanged: () => undefined,

  dispose(st, ctx) {
    ctx.zones.unregister(ctx.componentId);
    st.queue = [];
  },

  onEvent(st, ev, ctx) {
    if (ev.kind !== 'sensor' || ev.sensor !== ctx.ownerId) return;
    if (ev.phase === 'enter') {
      const b = ctx.zones.rec(ev.other);
      if (!b || b.disabled || b.id === ctx.ownerId || !qualifies(ctx, b.def)) return;
      const n = (st.overlaps.get(ev.other) ?? 0) + 1;
      st.overlaps.set(ev.other, n);
      if (n === 1) join(st, ctx, ev.other, ev.t, true);
      return;
    }
    const n = st.overlaps.get(ev.other);
    if (n === undefined) return; // never counted (filtered out, or it entered before a restore)
    if (n > 1) {
      st.overlaps.set(ev.other, n - 1);
      return;
    }
    st.overlaps.delete(ev.other);
    leave(st, ctx, ev.other, ev.t);
  },

  prestep(st, dt, ctx) {
    captureTemplate(st, ctx);
    timerSpawn(st, ctx, dt);
    applyField(st, ctx);
  },

  poststep(st, _dt, ctx) {
    if (st.queue.length) {
      const jobs = st.queue;
      st.queue = [];
      for (const job of jobs) fire(st, ctx, job);
    }
    if (st.revertDue) {
      st.revertDue = false;
      revertToggle(st, ctx);
    }
    const inside = st.rec.inside;
    if (inside.size) {
      // A body switched off (killed, held out of the world) while inside is gone as far as the zone is concerned.
      let gone: string[] | null = null;
      for (const id of inside.keys()) if (!ctx.zones.isActive(id)) (gone ??= []).push(id);
      if (gone) {
        for (const id of gone) {
          st.overlaps.delete(id);
          leave(st, ctx, id);
        }
      }
      const every = ctx.num('stayInterval');
      if (every > 0 && inside.size) {
        const t = ctx.time;
        for (const [id, since] of inside) {
          const last = st.lastStay.get(id) ?? since;
          if (t - last + 1e-9 < every) continue;
          st.lastStay.set(id, t);
          const src = zoneSource(ctx);
          ctx.zones.emit(src, 'stay', {
            body: id,
            unit: st.unitOfBody.get(id) ?? id,
            zone: src.zone,
            inside: inside.size,
            since,
            duration: t - since,
          });
        }
      }
    }
    ctx.state.set([inside.size, st.entered, st.fired]);
  },

  saveState(st) {
    return {
      overlaps: [...st.overlaps],
      inside: [...st.rec.inside],
      units: [...st.units],
      unitOfBody: [...st.unitOfBody],
      lastStay: [...st.lastStay],
      lastFire: [...st.lastFire],
      entered: st.entered,
      fired: st.fired,
      spawnAcc: st.spawnAcc,
      spawnN: st.spawnN,
      template: st.template,
      templateTried: st.templateTried,
      revert: st.revert,
    };
  },

  loadState(st, data) {
    const d = data as Partial<Record<string, unknown>> | null;
    if (!d || typeof d !== 'object') return;
    const pairs = <V>(v: unknown): [string, V][] => (Array.isArray(v) ? (v as [string, V][]) : []);
    st.overlaps = new Map(pairs<number>(d.overlaps));
    st.rec.inside.clear();
    for (const [id, t] of pairs<number>(d.inside)) st.rec.inside.set(id, t);
    st.units = new Map(pairs<number>(d.units));
    st.unitOfBody = new Map(pairs<string>(d.unitOfBody));
    st.lastStay = new Map(pairs<number>(d.lastStay));
    st.lastFire = new Map(pairs<number>(d.lastFire));
    st.entered = typeof d.entered === 'number' ? d.entered : 0;
    st.fired = typeof d.fired === 'number' ? d.fired : 0;
    st.spawnAcc = typeof d.spawnAcc === 'number' ? d.spawnAcc : 0;
    st.spawnN = typeof d.spawnN === 'number' ? d.spawnN : 0;
    st.template = (d.template as BodyEntity | null) ?? null;
    st.templateTried = d.templateTried === true;
    st.revert = (d.revert as ZoneState['revert']) ?? null;
    st.queue = [];
  },
};
