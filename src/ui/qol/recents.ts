/**
 * Recent scenes (UI-42): a short, size-capped list of the scenes the user opened, remembered across sessions.
 * A scene that came from a built-in template, a map or the saved library is reopened by reference; one that came
 * from a file, a drop or the clipboard keeps its JSON in a second, strictly budgeted store so it can be reopened
 * too (the oldest copies are dropped first, and a scene too large for the budget is listed but flagged as not
 * reopenable instead of silently filling the browser's storage).
 */
import { isRecord, parseJson, type KeyValueStore } from './storage';

export type RecentSource =
  | { kind: 'template'; id: string }
  | { kind: 'map'; id: string }
  | { kind: 'library'; id: string }
  | { kind: 'file' | 'paste' };

export interface RecentEntry {
  /** Stable identity: `template:car`, `library:s_abc`, `file:name` … Opening the same scene again moves it up. */
  key: string;
  name: string;
  /** Epoch milliseconds of the last time it was opened. */
  at: number;
  bodies: number;
  source: RecentSource;
  /** True when the scene JSON is kept (file / paste), so it can be reopened without the original file. */
  hasData: boolean;
}

export const RECENT_LIMITS = {
  entries: 12,
  nameChars: 80,
  /** Scenes of kind file / paste that keep their JSON. */
  dataEntries: 4,
  /** Total characters of kept JSON. */
  dataChars: 700_000,
  /** A single scene larger than this is listed but not kept. */
  perEntryChars: 300_000,
} as const;

const LIST_KEY = 'physicslab:qol:recents:v1';
const DATA_KEY = 'physicslab:qol:recentdata:v1';

const SOURCE_KINDS = new Set(['template', 'map', 'library', 'file', 'paste']);

export function recentKey(source: RecentSource, name: string): string {
  return 'id' in source ? `${source.kind}:${source.id}` : `${source.kind}:${name}`;
}

function cleanSource(raw: unknown): RecentSource | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string' || !SOURCE_KINDS.has(raw.kind)) return null;
  if (raw.kind === 'file' || raw.kind === 'paste') return { kind: raw.kind };
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 120) return null;
  return { kind: raw.kind as 'template' | 'map' | 'library', id: raw.id };
}

/** Validate a stored list: unknown shapes are dropped, strings clamped, the length capped. */
export function sanitizeRecents(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentEntry[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!isRecord(r)) continue;
    const source = cleanSource(r.source);
    if (!source || typeof r.name !== 'string' || typeof r.key !== 'string' || seen.has(r.key)) continue;
    const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0;
    const bodies = typeof r.bodies === 'number' && Number.isFinite(r.bodies) ? Math.max(0, Math.floor(r.bodies)) : 0;
    seen.add(r.key);
    out.push({
      key: r.key.slice(0, 200),
      name: r.name.slice(0, RECENT_LIMITS.nameChars),
      at,
      bodies,
      source,
      hasData: r.hasData === true,
    });
    if (out.length >= RECENT_LIMITS.entries) break;
  }
  return out;
}

export class RecentsStore {
  private listeners = new Set<() => void>();
  constructor(private readonly storage: KeyValueStore) {}

  list(): RecentEntry[] {
    return sanitizeRecents(parseJson(this.storage.getItem(LIST_KEY)));
  }

  private data(): Record<string, string> {
    const raw = parseJson(this.storage.getItem(DATA_KEY));
    const out: Record<string, string> = {};
    if (isRecord(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
    return out;
  }

  /** The kept JSON of an entry, if any. */
  dataOf(key: string): string | null {
    return this.data()[key] ?? null;
  }

  /** Remember that a scene was opened. `json` is kept for file / paste scenes within the budget. */
  record(source: RecentSource, name: string, bodies: number, json?: string, now = Date.now()): RecentEntry {
    const key = recentKey(source, name);
    const data = this.data();
    delete data[key];
    if (json !== undefined && json.length <= RECENT_LIMITS.perEntryChars && !('id' in source)) data[key] = json;
    const entry: RecentEntry = {
      key,
      name: name.slice(0, RECENT_LIMITS.nameChars) || 'Untitled scene',
      at: now,
      bodies,
      source,
      hasData: false,
    };
    const list = [entry, ...this.list().filter((e) => e.key !== key)].slice(0, RECENT_LIMITS.entries);
    // Keep JSON only for the newest entries, within the character budget.
    let used = 0;
    let kept = 0;
    const finalData: Record<string, string> = {};
    for (const e of list) {
      const d = data[e.key];
      e.hasData = false;
      if (d === undefined) continue;
      if (kept >= RECENT_LIMITS.dataEntries || used + d.length > RECENT_LIMITS.dataChars) continue;
      finalData[e.key] = d;
      e.hasData = true;
      used += d.length;
      kept++;
    }
    this.storage.setItem(DATA_KEY, JSON.stringify(finalData));
    this.storage.setItem(LIST_KEY, JSON.stringify(list));
    this.emit();
    return list[0];
  }

  remove(key: string): void {
    const data = this.data();
    delete data[key];
    this.storage.setItem(DATA_KEY, JSON.stringify(data));
    this.storage.setItem(LIST_KEY, JSON.stringify(this.list().filter((e) => e.key !== key)));
    this.emit();
  }

  clear(): void {
    this.storage.setItem(DATA_KEY, '{}');
    this.storage.setItem(LIST_KEY, '[]');
    this.emit();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** "3 min ago" style label for the menu / panel. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  return d < 14 ? `${d} d ago` : new Date(at).toLocaleDateString();
}
