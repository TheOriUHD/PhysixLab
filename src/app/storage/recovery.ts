/**
 * Crash recovery (DT-12). A session record in localStorage (synchronous, so it can be written while the page is
 * going away — IndexedDB writes in `pagehide` are not guaranteed to finish) says whether the previous session ended
 * cleanly: `clean: false` while running with a heartbeat timestamp refreshed every few seconds, `clean: true` once
 * `pagehide` / `beforeunload` ran. At start-up a record that is not clean and whose heartbeat is stale belongs to a
 * crashed (or killed) session. A fresh heartbeat from another id means a second tab is open — not a crash.
 */
export interface SessionRecord {
  id: string;
  clean: boolean;
  /** Last heartbeat, ms since epoch. */
  at: number;
  /** When the session started. */
  since: number;
}

export interface CrashInfo {
  crashed: boolean;
  /** When the lost session last proved it was alive. */
  lastAlive: number | null;
}

export const SESSION_KEY = 'physixlab:session:v1';
export const HEARTBEAT_MS = 4000;
/** A heartbeat older than this means the writer is gone (3 missed beats). */
export const STALE_MS = HEARTBEAT_MS * 3;

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function read(ls: KV): SessionRecord | null {
  try {
    const raw = ls.getItem(SESSION_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<SessionRecord>;
    if (typeof r.id !== 'string' || typeof r.at !== 'number') return null;
    return { id: r.id, clean: r.clean === true, at: r.at, since: typeof r.since === 'number' ? r.since : r.at };
  } catch {
    return null;
  }
}

function write(ls: KV, r: SessionRecord): void {
  try {
    ls.setItem(SESSION_KEY, JSON.stringify(r));
  } catch {
    /* storage unavailable: crash detection is simply off */
  }
}

/** Inspects the record the previous session left behind. Pure: no writes. */
export function detectCrash(ls: KV, now = Date.now()): CrashInfo {
  const prev = read(ls);
  if (!prev || prev.clean) return { crashed: false, lastAlive: null };
  if (now - prev.at < STALE_MS) return { crashed: false, lastAlive: null }; // another tab is alive
  return { crashed: true, lastAlive: prev.at };
}

export class SessionGuard {
  readonly id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  private since = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private ls: KV,
    private now: () => number = Date.now,
  ) {}

  /** Writes the running record and starts the heartbeat. Call after `detectCrash`. */
  start(): void {
    this.beat();
    this.timer = setInterval(() => this.beat(), HEARTBEAT_MS);
  }

  private beat(): void {
    write(this.ls, { id: this.id, clean: false, at: this.now(), since: this.since });
  }

  /** Marks the session as ended normally (call from `pagehide` / `beforeunload`). */
  markClean(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    write(this.ls, { id: this.id, clean: true, at: this.now(), since: this.since });
  }
}
