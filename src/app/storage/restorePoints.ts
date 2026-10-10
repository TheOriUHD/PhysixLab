/**
 * Restore points (DT-11): labelled snapshots of the scene kept in the storage layer ('snapshots' collection).
 *   auto     taken on a timer when the scene changed (`autoMinutes`)
 *   before   taken before a risky operation (replacing the scene, importing …) via `riskyOperation(label)`
 *   manual   taken by the user, never pruned automatically
 * Limits are user-configurable (`RestoreSettings`, kept in the 'settings' collection).
 */
import { parseDocument, serializeDocument } from '../../model/serialize';
import type { SceneDocument } from '../../model/types';
import { diffDocuments, type DocDiff } from './docDiff';
import type { StorageBackend } from './types';

export type RestoreKind = 'auto' | 'before' | 'manual';

export interface RestorePointMeta {
  id: string;
  label: string;
  kind: RestoreKind;
  at: number;
  sceneName: string;
  entities: number;
  bytes: number;
  /** Content fingerprint, to skip a snapshot identical to the previous one. */
  hash: string;
}

interface StoredPoint {
  meta: RestorePointMeta;
  data: string;
  /** PNG data URL of the viewport, when one could be captured. */
  thumb?: string;
}

export interface RestoreSettings {
  enabled: boolean;
  autoMinutes: number;
  maxAuto: number;
  maxBefore: number;
  /** Total size cap for all restore points; oldest automatic ones go first. */
  maxBytes: number;
}

export const DEFAULT_RESTORE_SETTINGS: RestoreSettings = {
  enabled: true,
  autoMinutes: 5,
  maxAuto: 20,
  maxBefore: 10,
  maxBytes: 64 * 1024 * 1024,
};

const SETTINGS_KEY = 'restorePoints';

function fnv(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}${s.length.toString(36)}`;
}

export class RestorePoints {
  settings: RestoreSettings = { ...DEFAULT_RESTORE_SETTINGS };
  private lastHash = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAutoRevision = -1;

  constructor(private storage: StorageBackend) {}

  async init(): Promise<void> {
    const saved = await this.storage.get<Partial<RestoreSettings>>('settings', SETTINGS_KEY);
    this.settings = sanitizeSettings(saved);
    const all = await this.list();
    this.lastHash = all[0]?.hash ?? '';
  }

  async saveSettings(patch: Partial<RestoreSettings>): Promise<void> {
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    await this.storage.put('settings', SETTINGS_KEY, this.settings);
    await this.prune();
  }

  /** Newest first. */
  async list(): Promise<RestorePointMeta[]> {
    const items = await this.storage.list<StoredPoint>('snapshots');
    return items.map((i) => i.value.meta).sort((a, b) => b.at - a.at);
  }

  /** Stores a point. Automatic points identical to the newest point are skipped (returns null). */
  async create(
    doc: SceneDocument,
    label: string,
    kind: RestoreKind,
    thumb?: string,
    now = Date.now(),
  ): Promise<RestorePointMeta | null> {
    if (!this.settings.enabled && kind !== 'manual') return null;
    const data = serializeDocument(doc);
    const hash = fnv(data);
    if (kind !== 'manual' && hash === this.lastHash) return null;
    const meta: RestorePointMeta = {
      id: `rp_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      label,
      kind,
      at: now,
      sceneName: doc.name,
      entities: doc.entities.length,
      bytes: data.length + (thumb?.length ?? 0),
      hash,
    };
    const value: StoredPoint = thumb ? { meta, data, thumb } : { meta, data };
    await this.storage.put('snapshots', meta.id, value);
    this.lastHash = hash;
    await this.prune();
    return meta;
  }

  async load(id: string): Promise<SceneDocument | null> {
    const p = await this.storage.get<StoredPoint>('snapshots', id);
    if (!p) return null;
    try {
      return parseDocument(p.data);
    } catch {
      return null;
    }
  }

  async thumbnail(id: string): Promise<string | null> {
    return (await this.storage.get<StoredPoint>('snapshots', id))?.thumb ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.storage.delete('snapshots', id);
  }

  async clear(): Promise<void> {
    await this.storage.clear('snapshots');
    this.lastHash = '';
  }

  /** What changed between point `id` and `current` (the scene as it is now). */
  async diffAgainst(id: string, current: SceneDocument): Promise<DocDiff | null> {
    const old = await this.load(id);
    return old ? diffDocuments(old, current) : null;
  }

  /** Applies the limits: per-kind counts, then the total size (oldest automatic points first, manual ones last). */
  async prune(): Promise<number> {
    const all = await this.list();
    const drop = new Set<string>();
    const cap = (kind: RestoreKind, max: number) => {
      all
        .filter((p) => p.kind === kind)
        .slice(max)
        .forEach((p) => drop.add(p.id));
    };
    cap('auto', this.settings.maxAuto);
    cap('before', this.settings.maxBefore);
    let total = all.filter((p) => !drop.has(p.id)).reduce((n, p) => n + p.bytes, 0);
    if (total > this.settings.maxBytes) {
      // oldest first: automatic, then before-operation, then manual; the newest point always stays
      const order: RestoreKind[] = ['auto', 'before', 'manual'];
      const victims = [...all]
        .filter((p) => !drop.has(p.id))
        .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.at - b.at);
      for (const v of victims) {
        if (total <= this.settings.maxBytes || v.id === all[0]?.id) break;
        drop.add(v.id);
        total -= v.bytes;
      }
    }
    for (const id of drop) await this.storage.delete('snapshots', id);
    return drop.size;
  }

  /** Starts the automatic snapshots: every `autoMinutes`, when `revision()` changed since the last one. */
  startAuto(getDoc: () => SceneDocument, revision: () => number, thumb?: () => Promise<string | undefined>): void {
    this.stopAuto();
    this.timer = setInterval(
      () => {
        const rev = revision();
        if (!this.settings.enabled || rev === this.lastAutoRevision) return;
        this.lastAutoRevision = rev;
        void (async () => {
          const t = await thumb?.().catch(() => undefined);
          await this.create(getDoc(), 'Automatic snapshot', 'auto', t);
        })();
      },
      Math.max(0.1, this.settings.autoMinutes) * 60_000,
    );
  }

  stopAuto(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function sanitizeSettings(raw: Partial<RestoreSettings> | undefined): RestoreSettings {
  const d = DEFAULT_RESTORE_SETTINGS;
  const num = (v: unknown, lo: number, hi: number, def: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : d.enabled,
    autoMinutes: num(raw?.autoMinutes, 1, 120, d.autoMinutes),
    maxAuto: Math.round(num(raw?.maxAuto, 1, 200, d.maxAuto)),
    maxBefore: Math.round(num(raw?.maxBefore, 1, 100, d.maxBefore)),
    maxBytes: num(raw?.maxBytes, 1024, 1024 * 1024 * 1024, d.maxBytes),
  };
}

// ---- global hook -----------------------------------------------------------------------------

let hook: ((label: string) => void) | null = null;

/** Installed by the data platform at start-up; commands call `riskyOperation(…)` before they replace the scene. */
export function setRiskyOperationHook(fn: ((label: string) => void) | null): void {
  hook = fn;
}

/** Takes a "before …" restore point (no-op until the data platform is running). */
export function riskyOperation(label: string): void {
  hook?.(label);
}
