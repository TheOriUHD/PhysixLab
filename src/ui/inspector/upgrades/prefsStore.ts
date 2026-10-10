/**
 * UI-A: small persisted stores of the inspector upgrades — the unit system (global default + per-field overrides) and
 * the property presets. Both live in `localStorage` (never in the scene document), every access is guarded, and what is
 * read back is validated: a corrupt or hand-edited entry falls back to the defaults.
 */
import type { QuantityDef, UnitSystem } from './units';
import type { Snapshot } from './props';
import { sanitizeSnapshot } from './props';

const UNITS_KEY = 'physicslab:ui-a:units';
const PRESETS_KEY = 'physicslab:ui-a:presets';

function read(key: string): unknown {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as unknown) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota: the setting simply does not persist */
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isSystem = (v: unknown): v is UnitSystem => v === 'si' || v === 'imperial';

// ---- units -------------------------------------------------------------------------------------------------------

const MAX_OVERRIDES = 400;

export class UnitPrefs {
  system: UnitSystem = 'si';
  /** Field key → system, for fields the user switched on their own. */
  overrides = new Map<string, UnitSystem>();
  private listeners = new Set<() => void>();

  constructor(private persist = true) {
    if (persist) this.load();
  }

  private load(): void {
    const raw = read(UNITS_KEY);
    if (!isObj(raw)) return;
    if (isSystem(raw.system)) this.system = raw.system;
    if (isObj(raw.overrides)) {
      for (const [k, v] of Object.entries(raw.overrides).slice(0, MAX_OVERRIDES))
        if (isSystem(v) && k.length <= 120) this.overrides.set(k, v);
    }
  }

  private save(): void {
    if (this.persist) write(UNITS_KEY, { system: this.system, overrides: Object.fromEntries(this.overrides) });
  }

  /** The system a field shows: its own override, else the global one. Quantities without an imperial form: SI. */
  systemFor(qd: QuantityDef, key: string | null): UnitSystem {
    if (!qd.imperial) return 'si';
    return (key && this.overrides.get(key)) || this.system;
  }

  /** Change the global system and drop every per-field override (so the whole inspector follows). */
  setSystem(s: UnitSystem): void {
    this.system = s;
    this.overrides.clear();
    this.save();
    this.emit();
  }

  /** Switch one field between SI and imperial. */
  toggleField(qd: QuantityDef, key: string | null): void {
    if (!qd.imperial) return;
    const next: UnitSystem = this.systemFor(qd, key) === 'si' ? 'imperial' : 'si';
    if (key) {
      if (next === this.system) this.overrides.delete(key);
      else this.overrides.set(key, next);
    } else this.system = next;
    this.save();
    this.emit();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

/** The one instance the inspector's fields share. */
export const unitPrefs = new UnitPrefs();

// ---- presets -----------------------------------------------------------------------------------------------------

export interface Preset {
  id: string;
  name: string;
  snapshot: Snapshot;
}

const MAX_PRESETS = 60;

export function sanitizePresets(raw: unknown): Preset[] {
  if (!isObj(raw) || !Array.isArray(raw.presets)) return [];
  const out: Preset[] = [];
  const ids = new Set<string>();
  for (const p of raw.presets.slice(0, MAX_PRESETS) as unknown[]) {
    if (!isObj(p) || typeof p.name !== 'string' || typeof p.id !== 'string') continue;
    const name = p.name.trim().slice(0, 48);
    const snapshot = sanitizeSnapshot(p.snapshot);
    if (!name || !Object.keys(snapshot).length || ids.has(p.id) || p.id.length > 40) continue;
    ids.add(p.id);
    out.push({ id: p.id, name, snapshot });
  }
  return out;
}

export class PresetStore {
  private items: Preset[] = [];
  private listeners = new Set<() => void>();

  constructor(private persist = true) {
    if (persist) this.items = sanitizePresets(read(PRESETS_KEY));
  }

  list(): readonly Preset[] {
    return this.items;
  }

  /** Save (or replace the preset of the same name). Returns false when the snapshot is empty or the list is full. */
  save(name: string, snapshot: Snapshot): boolean {
    const clean = sanitizeSnapshot(snapshot);
    const nm = name.trim().slice(0, 48);
    if (!nm || !Object.keys(clean).length) return false;
    const i = this.items.findIndex((p) => p.name.toLowerCase() === nm.toLowerCase());
    if (i >= 0) this.items[i] = { ...this.items[i], name: nm, snapshot: clean };
    else if (this.items.length >= MAX_PRESETS) return false;
    else
      this.items.push({
        id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: nm,
        snapshot: clean,
      });
    this.commit();
    return true;
  }

  remove(id: string): void {
    this.items = this.items.filter((p) => p.id !== id);
    this.commit();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(): void {
    if (this.persist) write(PRESETS_KEY, { v: 1, presets: this.items });
    for (const fn of [...this.listeners]) fn();
  }
}

export const presetStore = new PresetStore();
