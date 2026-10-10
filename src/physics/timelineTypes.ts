/**
 * Messages of the `timeline` custom channel (package TM): the page's conversation with the recorder in the worker.
 * Types only — the page imports this file without pulling any world code.
 */
import type { InputEntry } from './world/recorder';
import type { TrackData } from './world/track';
import type { WorldSnapshot } from './protocol';

export type { InputEntry, TrackData };

export type TimelineCmd =
  | { cmd: 'status' }
  | { cmd: 'seek'; step: number }
  | { cmd: 'rewind'; on: boolean; rate?: number }
  /** Play forward through the recorded past (logged inputs applied) instead of branching from it. */
  | { cmd: 'playThrough'; on: boolean }
  | { cmd: 'config'; budgetMB?: number; enabled?: boolean }
  | { cmd: 'record'; on: boolean }
  | { cmd: 'recordGet'; stop?: boolean }
  | { cmd: 'replayLoad'; payload: ReplayPayload }
  | { cmd: 'replayExit' }
  | { cmd: 'determinism'; steps?: number; every?: number }
  | { cmd: 'trackGet'; run: 'live' | number }
  | { cmd: 'runs' }
  | { cmd: 'clearRuns' };

/** What a replay file carries besides the scene document. */
export interface ReplayPayload {
  /** The state to start from; null = the freshly built scene at step 0. */
  base: WorldSnapshot | null;
  startStep: number;
  endStep: number;
  entries: InputEntry[];
  /** `[step, hash]` checkpoints for verification. */
  hashes: [number, string][];
  hz: number;
}

export interface TimelineStatus {
  kind: 'status';
  step: number;
  simTime: number;
  hz: number;
  /** Oldest step that can be returned to, and the newest of the current timeline. */
  first: number;
  head: number;
  /** Steps that have a snapshot. */
  snapshots: number[];
  interval: number;
  bytes: number;
  budgetBytes: number;
  enabled: boolean;
  mode: 'live' | 'rewind';
  playThrough: boolean;
  recording: { startStep: number; entries: number; fromStart: boolean } | null;
  replay: {
    startStep: number;
    endStep: number;
    checkpoints: number;
    checked: number;
    firstBad: { step: number; expected: string; actual: string } | null;
  } | null;
  track: { count: number; every: number; duration: number };
  /** The "live" check started by the determinism run: the real run compared with the clone's hashes. */
  watch: { checked: number; total: number; firstBad: { step: number } | null } | null;
}

export interface DeterminismReport {
  kind: 'determinism';
  ok: boolean;
  steps: number;
  every: number;
  checkpoints: number;
  /** First checkpoint where two identical runs disagreed. */
  firstDivergence: { step: number; a: string; b: string } | null;
  ms: number;
}

export interface RunInfo {
  name: string;
  duration: number;
  count: number;
  bodies: number;
}

export type TimelineReply =
  | TimelineStatus
  | DeterminismReport
  | { kind: 'recording'; payload: ReplayPayload }
  | { kind: 'track'; run: 'live' | number; track: TrackData | null }
  | { kind: 'runs'; runs: RunInfo[] }
  | { kind: 'error'; message: string };
