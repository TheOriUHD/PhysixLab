/**
 * The page side of the zones package: turns the worker's stream of `zone` / `bounds` events and the published race
 * state into one typed API (`app.zones`, also on `window.physicslab.zones`) for the HUD, the Zones panel, logic,
 * scripts and the game layer.
 *
 *   zones.on('event', (e) => …)     every zone / bounds event, with the body, racer and zone resolved to names
 *   zones.state                     the published state: score, message, races with their racers (or null)
 *   zones.log                       the last events as text (what the Zones panel lists), newest last
 *   zones.feed                      the events worth showing on screen for a few seconds (laps, finishes, losses …)
 *
 * It also does the two things only the page can: draw the bodies a spawner creates (the worker sends their
 * definition, the page registers them as simulation-only bodies) and play the sounds of the `sound` action.
 */
import { Emitter } from '../core/events';
import type { Vec3 } from '../core/math';
import {
  BOUNDS_EVENT_TYPE,
  ZONES_STATE_ID,
  ZONE_EVENT_TYPE,
  formatDelta,
  formatRaceTime,
  zoneActionInfo,
  type RacerPublic,
  type ZoneAction,
  type ZonesPublic,
} from '../model/zones';
import { isBody, type BodyEntity } from '../model/types';
import type { ComponentEvent, SimEvent } from '../physics/protocol';
import type { App } from './app';
import { addZone } from './zoneCommands';
import { zoneSound } from './zoneSound';

/** One line of the event log. */
export interface ZoneLogEntry {
  id: number;
  /** Simulation seconds. */
  t: number;
  source: 'zone' | 'bounds';
  name: string;
  /** Id of the zone body (or of the lost body, for the bounds). */
  owner: string;
  text: string;
  /** Shown on screen for a while (laps, finishes, losses, scores) rather than only listed. */
  notable: boolean;
  data: unknown;
}

/** A zone or bounds event as listeners get it. */
export interface ZoneBridgeEvent extends ZoneLogEntry {
  event: ComponentEvent;
}

interface BridgeEvents extends Record<string, unknown> {
  event: ZoneBridgeEvent;
  /** The log or the feed changed. */
  log: undefined;
}

/** One zone of the scene, for lists. */
export interface ZoneInfo {
  id: string;
  name: string;
  componentId: string;
  action: ZoneAction;
  label: string;
  race: string;
  index: number;
  enabled: boolean;
}

/** A value of an event payload as text (payloads are JSON: strings and numbers read as themselves, anything else as empty). */
const text = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

const MAX_LOG = 300;
const FEED_SECONDS = 5;

export class ZoneBridge extends Emitter<BridgeEvents> {
  readonly log: ZoneLogEntry[] = [];
  /** Entries still on screen: `until` is wall-clock milliseconds. */
  readonly feed: { entry: ZoneLogEntry; until: number }[] = [];
  private nextId = 1;
  /** Total events seen since the page loaded, by name (cheap counters for tests and the panel). */
  readonly counts: Record<string, number> = {};

  constructor(private readonly app: App) {
    super();
    app.sim.client.on('event', (ev) => this.onEvent(ev));
    app.sim.on('mode', (mode) => {
      // a new run starts with an empty log; a finished or reset run keeps its log to be read
      if (mode !== 'edit' && this.app.sim.client.frameNo === 0) this.clear();
    });
  }

  clear(): void {
    this.log.length = 0;
    this.feed.length = 0;
    this.emit('log', undefined);
  }

  /** The published state of the running simulation, or null (edit mode, or nothing happened yet). */
  get state(): ZonesPublic | null {
    const { client } = this.app.sim;
    if (!client.active) return null;
    return (client.jsonOf(ZONES_STATE_ID) as ZonesPublic | undefined) ?? null;
  }

  /** The sounds zones asked the page to play since it loaded (muted ones included), for tests and scripts. */
  get sounds(): readonly { sound: string; volume: number; pitch: number }[] {
    return zoneSound.requested;
  }

  /** Simulation seconds as of the last frame. */
  get now(): number {
    return this.app.sim.client.stats?.simTime ?? 0;
  }

  /** Display name of a body, a group, or a bare id. */
  nameOf(id: string): string {
    if (!id) return '';
    return this.app.store.get(id)?.name ?? this.app.sim.ephemeral.get(id)?.name ?? id;
  }

  /** The time the current lap has been running (penalties included); 0 before the clock starts. */
  lapTime(r: RacerPublic, now = this.now): number {
    if (r.finished) return r.lapTimes[r.lapTimes.length - 1] ?? 0;
    return r.lapStart === null ? 0 : Math.max(0, now - r.lapStart + r.lapPenalty);
  }

  /** The race time of a racer: the finishing time once done, otherwise the running clock. */
  raceTime(r: RacerPublic, now = this.now): number {
    if (r.finishTime !== null) return r.finishTime;
    return r.clockStart === null ? 0 : Math.max(0, now - r.clockStart + r.penalty);
  }

  /** Every zone component in the scene, in outliner order. */
  zones(): ZoneInfo[] {
    const out: ZoneInfo[] = [];
    for (const e of this.app.store.all()) {
      if (!isBody(e)) continue;
      for (const c of e.components) {
        if (c.type !== 'zone') continue;
        const action = (typeof c.params.action === 'string' ? c.params.action : 'none') as ZoneAction;
        out.push({
          id: e.id,
          name: e.name,
          componentId: c.id,
          action,
          label: typeof c.params.label === 'string' ? c.params.label : '',
          race: typeof c.params.race === 'string' ? c.params.race : '',
          index: typeof c.params.index === 'number' ? c.params.index : 0,
          enabled: c.enabled,
        });
      }
    }
    return out;
  }

  // ---- events ------------------------------------------------------------------------------

  private onEvent(ev: SimEvent): void {
    if (ev.kind !== 'component' || (ev.type !== ZONE_EVENT_TYPE && ev.type !== BOUNDS_EVENT_TYPE)) return;
    this.counts[ev.name] = (this.counts[ev.name] ?? 0) + 1;
    const data = (ev.data ?? {}) as Record<string, unknown>;
    // things only the page can do
    if (ev.name === 'spawn' && data.def) {
      const def = data.def as BodyEntity;
      this.app.sim.ephemeral.set(def.id, def);
      this.app.sim.emit('layout', undefined);
    } else if (ev.name === 'despawn' && typeof data.body === 'string') {
      if (this.app.sim.ephemeral.delete(data.body)) this.app.sim.emit('layout', undefined);
    } else if (ev.name === 'sound') {
      zoneSound.play(text(data.sound) || 'beep', Number(data.volume ?? 0.6), Number(data.pitch ?? 1));
    }
    const { text: line, notable } = this.describe(ev, data);
    const entry: ZoneLogEntry = {
      id: this.nextId++,
      t: ev.t,
      source: ev.type === BOUNDS_EVENT_TYPE ? 'bounds' : 'zone',
      name: ev.name,
      owner: ev.owner,
      text: line,
      notable,
      data: ev.data,
    };
    if (ev.name !== 'spawn' && ev.name !== 'despawn') {
      this.log.push(entry);
      if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
      if (notable) {
        this.feed.push({ entry, until: performance.now() + FEED_SECONDS * 1000 });
        if (this.feed.length > 5) this.feed.shift();
      }
      this.emit('log', undefined);
    }
    this.emit('event', { ...entry, event: ev });
  }

  /** A sentence for an event, and whether it belongs on screen. */
  private describe(ev: ComponentEvent, d: Record<string, unknown>): { text: string; notable: boolean } {
    const nm = (k: string) => this.nameOf(text(d[k]));
    const zone = typeof d.zone === 'string' && d.zone ? d.zone : this.nameOf(ev.owner);
    const racer = () => (d.racer ? this.nameOf(text(d.racer)) : nm('body'));
    switch (ev.name) {
      case 'enter':
        return { text: `${nm('body')} entered ${zone}`, notable: false };
      case 'exit':
        return { text: `${nm('body')} left ${zone}`, notable: false };
      case 'stay':
        return { text: `${nm('body')} stays in ${zone}`, notable: false };
      case 'start':
        return { text: `${racer()} started the clock`, notable: true };
      case 'checkpoint': {
        const delta = typeof d.delta === 'number' ? ` (${formatDelta(d.delta)})` : '';
        return {
          text: `${racer()} · checkpoint ${String(d.index)} · ${formatRaceTime(Number(d.split))}${delta}`,
          notable: true,
        };
      }
      case 'lap': {
        const tag = d.overall ? ' · record' : d.best ? ' · best' : '';
        return {
          text: `${racer()} · lap ${String(d.lap)} · ${formatRaceTime(Number(d.lapTime))}${tag}`,
          notable: true,
        };
      }
      case 'finish':
        return {
          text: `${racer()} finished ${ordinal(Number(d.rank))} · ${formatRaceTime(Number(d.time))}`,
          notable: true,
        };
      case 'skipped':
        return {
          text:
            Number(d.expected) > 0
              ? `${racer()} missed checkpoint ${String(d.expected)}`
              : `${racer()} crossed the line too early`,
          notable: true,
        };
      case 'kill': {
        const why = d.cause === 'drowned' ? 'drowned' : d.cause === 'bounds' ? 'left the world' : `hit ${zone}`;
        return { text: `${nm('body')} ${why}${d.mode === 'respawn' ? '' : ' and was removed'}`, notable: true };
      }
      case 'respawn':
        return {
          text: `${nm('body')} respawned at the ${d.to === 'checkpoint' ? 'last checkpoint' : 'start'}`,
          notable: true,
        };
      case 'teleport':
        return { text: `${nm('body')} teleported by ${zone}`, notable: false };
      case 'launch':
        return { text: `${nm('body')} launched by ${zone}`, notable: false };
      case 'spawn':
        return { text: `${zone} created ${this.nameOf(String(d.body))}`, notable: false };
      case 'despawn':
        return { text: `${this.nameOf(String(d.body))} removed`, notable: false };
      case 'sound':
        return { text: `${zone} played “${String(d.sound)}”`, notable: false };
      case 'score': {
        const pts = Number(d.points);
        const msg = typeof d.message === 'string' && d.message ? ` “${d.message}”` : '';
        return { text: `${pts >= 0 ? '+' : ''}${pts} points (total ${String(d.total)})${msg}`, notable: pts !== 0 };
      }
      case 'toggle':
        return {
          text: `${zone} switched ${String(d.changed)} component${d.changed === 1 ? '' : 's'} ${d.enabled ? 'on' : 'off'} on ${nm('target')}`,
          notable: false,
        };
      case 'custom':
        return {
          text: `${zone} → event “${String(d.event)}”${d.payload ? ` ${text(d.payload)}` : ''}`,
          notable: false,
        };
      default:
        return { text: `${zone}: ${ev.name}`, notable: false };
    }
  }

  /** Add a ready-made zone of this action in front of the view (one undo step); returns the zone body. */
  add(action: ZoneAction, at?: Vec3): BodyEntity {
    return addZone(this.app, action, at);
  }

  /** Short label of an action, for lists. */
  actionLabel(action: string): string {
    return zoneActionInfo(action).label;
  }
}

const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};
