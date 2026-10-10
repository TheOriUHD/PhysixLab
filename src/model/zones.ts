/**
 * Zones (package ZN) — the vocabulary shared by the document model, the physics worker and the page.
 *
 * A **zone** is an ordinary body whose colliders are sensors (a *ghost* body, static or kinematic) carrying one or
 * more `zone` components (`model/components/zone.ts`, runtime `physics/components/zone.ts`). The body's shape is the
 * volume: any registered shape works (box, sphere, cylinder, a hull, a compound of sensor parts …). What happens when
 * a body enters, stays in or leaves it is the component's `action`.
 *
 * Everything a zone tells the rest of the program travels as a protocol-v2 `component` event with `type: 'zone'`
 * (`SimClient` re-emits it as an `'event'`; logic, scripts and the game layer subscribe to those). The names and the
 * payload of each are the `ZoneEventData` map below; `src/app/zones.ts` turns the stream into a typed API
 * (`app.zones`). Race standings and the score are published as JSON under the id `ZONES_STATE_ID`.
 *
 * No dependency on three.js or Rapier: this file runs in the worker, the page and the Node tests.
 */
import type { Vec3 } from '../core/math';

/** `ComponentEvent.type` of every event a zone raises. */
export const ZONE_EVENT_TYPE = 'zone';
/** `ComponentEvent.type` of the events the world bounds raise (a body left the playfield, was respawned …). */
export const BOUNDS_EVENT_TYPE = 'bounds';
/** Component-state id under which the zone system publishes its JSON (`SimClient.jsonOf`). */
export const ZONES_STATE_ID = '@zones';

export type ZoneAction =
  | 'none'
  | 'checkpoint'
  | 'start'
  | 'finish'
  | 'kill'
  | 'respawnAt'
  | 'teleport'
  | 'launch'
  | 'gravity'
  | 'force'
  | 'spawn'
  | 'sound'
  | 'score'
  | 'toggle'
  | 'custom';

export interface ZoneActionInfo {
  id: ZoneAction;
  label: string;
  /** One line for the inspector and the Add menu. */
  blurb: string;
  /** Key of `src/ui/icons.ts`. */
  icon: string;
  /** Colour the volume is drawn in (editors can override it per zone). */
  color: string;
  /** The action works while a body is inside (every step) rather than once, when a body enters. */
  continuous?: boolean;
  /** The action is part of a race (checkpoint / start / finish). */
  race?: boolean;
}

export const ZONE_ACTIONS: readonly ZoneActionInfo[] = [
  {
    id: 'none',
    label: 'Events only',
    blurb: 'Raises enter / exit / stay events for logic, scripts and the game layer; does nothing else.',
    icon: 'zone',
    color: '#38bdf8',
  },
  {
    id: 'checkpoint',
    label: 'Checkpoint',
    blurb: 'A numbered gate of a race: passed in order, records a split time and a respawn point.',
    icon: 'checkpoint',
    color: '#fbbf24',
    race: true,
  },
  {
    id: 'start',
    label: 'Start line',
    blurb: 'Starts the race clock of the body that enters.',
    icon: 'startLine',
    color: '#34d399',
    race: true,
  },
  {
    id: 'finish',
    label: 'Finish line',
    blurb: 'Completes a lap (all checkpoints passed in order) and finishes the race after the last lap, with timing.',
    icon: 'flag',
    color: '#f472b6',
    race: true,
  },
  {
    id: 'kill',
    label: 'Kill zone',
    blurb: 'Removes the body that enters, or sends it back to its start / last checkpoint, with an optional penalty.',
    icon: 'skull',
    color: '#ff5d73',
  },
  {
    id: 'respawnAt',
    label: 'Respawn point',
    blurb: 'Sets where the body that enters comes back after it is lost (and can move it there now).',
    icon: 'respawn',
    color: '#5eead4',
  },
  {
    id: 'teleport',
    label: 'Teleporter',
    blurb: 'Moves the body to another body or a point; the velocity is kept, turned with the portal, or stopped.',
    icon: 'teleport',
    color: '#a78bfa',
  },
  {
    id: 'launch',
    label: 'Launch pad',
    blurb: 'Gives the body that enters an impulse or a velocity change.',
    icon: 'launch',
    color: '#fb923c',
  },
  {
    id: 'gravity',
    label: 'Gravity override',
    blurb: 'Replaces gravity for the bodies inside (zero-g, reversed, sideways). Highest priority wins.',
    icon: 'gravity',
    color: '#818cf8',
    continuous: true,
  },
  {
    id: 'force',
    label: 'Force field',
    blurb: 'Pushes the bodies inside with a force (or acceleration): uniform, or toward / away from the centre.',
    icon: 'forceField',
    color: '#22d3ee',
    continuous: true,
  },
  {
    id: 'spawn',
    label: 'Spawner',
    blurb: 'Creates copies of a template body when something enters, or at a steady rate.',
    icon: 'spawn',
    color: '#4ade80',
  },
  {
    id: 'sound',
    label: 'Sound',
    blurb: 'Plays a sound when a body enters.',
    icon: 'speaker',
    color: '#facc15',
  },
  {
    id: 'score',
    label: 'Label / score',
    blurb: 'Adds points to the score and / or shows a message.',
    icon: 'score',
    color: '#f9a8d4',
  },
  {
    id: 'toggle',
    label: 'Enable / disable',
    blurb: 'Switches the components of another body on or off — a pressure plate, a door, a fan.',
    icon: 'toggle',
    color: '#94a3b8',
  },
  {
    id: 'custom',
    label: 'Custom event',
    blurb: 'Raises an event with a name and a text payload of your choice for logic and scripts.',
    icon: 'event',
    color: '#c084fc',
  },
];

const ACTIONS_BY_ID = new Map(ZONE_ACTIONS.map((a) => [a.id, a]));

export function zoneActionInfo(id: string): ZoneActionInfo {
  return ACTIONS_BY_ID.get(id as ZoneAction) ?? ZONE_ACTIONS[0];
}

/** Sounds the `sound` action can play (synthesised in the page; no audio files are needed). */
export const ZONE_SOUNDS: readonly { id: string; label: string }[] = [
  { id: 'beep', label: 'Beep' },
  { id: 'chime', label: 'Chime' },
  { id: 'success', label: 'Success' },
  { id: 'fail', label: 'Fail' },
  { id: 'coin', label: 'Coin' },
  { id: 'boing', label: 'Boing' },
  { id: 'whoosh', label: 'Whoosh' },
  { id: 'thud', label: 'Thud' },
  { id: 'buzz', label: 'Buzz' },
  { id: 'click', label: 'Click' },
];

// ── events ──────────────────────────────────────────────────────────────────────────────────────────

/** The `name` of every zone event, and what its `data` carries. */
export interface ZoneEventData {
  /** A qualifying body entered the zone. `inside` counts the bodies in it now (this one included). */
  enter: ZoneBodyRef & { inside: number };
  exit: ZoneBodyRef & { inside: number };
  /** Every `stayInterval` seconds for each body inside. `since` is the simulation time it entered. */
  stay: ZoneBodyRef & { inside: number; since: number; duration: number };
  /** The race clock of `racer` started (start line, or a start / finish line). */
  start: RaceRef & { time: number };
  /** `index` is the checkpoint's number; `split` the time since the lap began; `delta` is vs the best lap (null if none). */
  checkpoint: RaceRef & { index: number; split: number; delta: number | null; lap: number };
  /** A lap was completed. `best` is true for the racer's new best lap, `overall` for a new race record. */
  lap: RaceRef & { lap: number; lapTime: number; best: boolean; overall: boolean; splits: number[] };
  /** The racer completed all laps: `time` includes penalties, `rank` is the finishing order (1 = winner). */
  finish: RaceRef & { time: number; laps: number; rank: number; lapTimes: number[]; penalty: number };
  /** A checkpoint / finish line was crossed out of order (`expected` is the index that was needed, 0 = the finish). */
  skipped: RaceRef & { index: number; expected: number };
  kill: ZoneBodyRef & { mode: 'remove' | 'respawn'; cause: string; penalty: number };
  respawn: ZoneBodyRef & { to: 'start' | 'checkpoint' | 'point'; position: Vec3; cause: string; count: number };
  teleport: ZoneBodyRef & { from: Vec3; to: Vec3 };
  launch: ZoneBodyRef & { mode: 'impulse' | 'deltaV'; vector: Vec3 };
  /** `def` is the full `BodyEntity` of the new body — the page uses it to draw the simulation-only body. */
  spawn: { body: string; def: unknown; source: string; alive: number };
  despawn: { body: string; reason: 'lifetime' | 'kill' };
  sound: { sound: string; volume: number; pitch: number; at: Vec3; body: string };
  score: ZoneBodyRef & { points: number; total: number; message: string };
  toggle: { target: string; componentType: string; enabled: boolean; changed: number; body: string };
  custom: ZoneBodyRef & { event: string; payload: string; phase: 'enter' };
}

export type ZoneEventName = keyof ZoneEventData;

/** The body (and the unit it belongs to) an event is about. */
export interface ZoneBodyRef {
  body: string;
  /** The unit that triggered: the body itself or, with "whole group", the id of its group. */
  unit: string;
  /** Label of the zone (its `label` field, else the owner's name is up to the page). */
  zone: string;
}

export interface RaceRef {
  race: string;
  /** Body id, or group id when the zone treats a whole group as one racer. */
  racer: string;
  body: string;
  zone: string;
}

/** The typed payload of an event name. */
export type ZoneEventPayload<N extends ZoneEventName> = ZoneEventData[N];

// ── published state (SimClient.jsonOf(ZONES_STATE_ID)) ───────────────────────────────────────────────

export interface RacerPublic {
  racer: string;
  /** Clock start (simulation seconds), null until the racer crosses the start line. */
  clockStart: number | null;
  /** Completed laps. */
  lap: number;
  /** Checkpoints passed in the current lap. */
  passed: number;
  /** Simulation time the current lap began (null before the clock starts). */
  lapStart: number | null;
  /** Penalty seconds collected in the current lap (included in `lapStart`-relative times). */
  lapPenalty: number;
  /** Seconds since the lap began at each checkpoint passed in this lap. */
  splits: number[];
  lapTimes: number[];
  lastLap: number | null;
  bestLap: number | null;
  /** Splits of the best lap, to compare the current one against. */
  bestSplits: number[] | null;
  penalty: number;
  finished: boolean;
  /** Total time including penalties (null while racing). */
  finishTime: number | null;
  /** Finishing order, 1 = first (0 while racing). */
  rank: number;
  /** Simulation time of the last checkpoint / line crossing, for ordering racers on the same step. */
  lastTime: number;
}

export interface RacePublic {
  race: string;
  laps: number;
  /** The distinct checkpoint numbers of the race, ascending. */
  checkpoints: number[];
  /** True if a start line (or a start / finish line) controls the clock. */
  hasStart: boolean;
  record: { racer: string; time: number } | null;
  racers: RacerPublic[];
}

export interface ZonesPublic {
  /** Bumped whenever anything below changes. */
  rev: number;
  score: { total: number; byRacer: Record<string, number> };
  /** The last label / message a zone showed (the page shows it for a couple of seconds). */
  message: { text: string; id: number; t: number } | null;
  races: RacePublic[];
}

export const emptyZonesState = (): ZonesPublic => ({
  rev: 0,
  score: { total: 0, byRacer: {} },
  message: null,
  races: [],
});

/** "1:05.321" / "5.321" style race time. */
export function formatRaceTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '–';
  const sign = seconds < 0 ? '-' : '';
  const s = Math.abs(seconds);
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(3).padStart(m > 0 ? 6 : 1, '0');
  return `${sign}${m > 0 ? `${m}:` : ''}${rest}`;
}

/** Signed difference "+0.512" / "-1.034" for a split against the best lap. */
export function formatDelta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
  return `${seconds >= 0 ? '+' : '-'}${Math.abs(seconds).toFixed(3)}`;
}
