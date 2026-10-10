/**
 * The InputMap: one table of every bindable thing — each command's shortcuts and the held "camera actions" —
 * with the user's overrides, conflict detection, presets and import / export. The keymap, the shortcut help, the
 * tooltips and the Settings › Keyboard editor all read the *effective* bindings from here, so a rebinding is
 * visible everywhere at once. Pure TypeScript (no DOM): the key-event plumbing lives in `hub.ts`.
 */
import { Emitter } from '../../core/events';
import { commandRegistry, setShortcutResolver, type CommandDef } from '../registry/commands';
import { keymap } from '../registry/keymap';
import { chordId, chordMatches, parseShortcut, shortcutList, type KeyLike } from '../registry/shortcuts';

/** A held action (fly the camera forward …). Commands are bound too, but run once per press. */
export interface ActionDef {
  id: string;
  label: string;
  category: string;
  /** Default shortcuts (plain keys; held actions ignore modifiers). */
  shortcuts: readonly string[];
  /** Only active in this context (`fly`, `pip` …); conflicts are checked within a scope and against global bindings. */
  scope?: string;
}

export interface BindingRow {
  id: string;
  kind: 'command' | 'action';
  label: string;
  category: string;
  scope?: string;
  shortcuts: readonly string[];
  defaults: readonly string[];
  custom: boolean;
}

export interface Conflict {
  id: string;
  label: string;
}

export const MAX_SLOTS = 3;

export interface Preset {
  id: string;
  label: string;
  blurb: string;
  /** The overrides this preset creates, computed from the current defaults. */
  build(rows: readonly BindingRow[]): Record<string, string[]>;
}

/** Shared by every map so a keymap that outlives one (tests make several) never sees a repeated number. */
let revisionCounter = 0;

export class InputMap extends Emitter<{ change: undefined }> {
  private actions = new Map<string, ActionDef>();
  private overrides = new Map<string, string[]>();
  preset = 'default';
  /** Bumped on every change of the effective bindings (the keymap rebuilds when it sees a new number). */
  get revision(): number {
    return revisionCounter;
  }
  set revision(_v: number) {
    revisionCounter++;
  }

  constructor() {
    super();
    setShortcutResolver((def) => this.shortcutsOfCommand(def));
    keymap.bindingsRevision = () => this.revision;
    commandRegistry.onChange(() => this.revision++);
  }

  // ---- registration ----------------------------------------------------------------------------

  registerAction(def: ActionDef): () => void {
    if (this.actions.has(def.id)) throw new Error(`input action "${def.id}" is already registered`);
    for (const s of def.shortcuts) parseShortcut(s);
    this.actions.set(def.id, def);
    this.revision++;
    return () => {
      if (this.actions.delete(def.id)) this.revision++;
    };
  }

  action(id: string): ActionDef | undefined {
    return this.actions.get(id);
  }

  // ---- reading ---------------------------------------------------------------------------------

  private shortcutsOfCommand(def: CommandDef): readonly string[] {
    return this.overrides.get(def.id) ?? shortcutList(def.shortcut);
  }

  /** Effective shortcuts of a command or action id. */
  shortcuts(id: string): readonly string[] {
    const o = this.overrides.get(id);
    if (o) return o;
    const a = this.actions.get(id);
    if (a) return a.shortcuts;
    const c = commandRegistry.get(id);
    return c ? shortcutList(c.shortcut) : [];
  }

  rows(): BindingRow[] {
    const out: BindingRow[] = [];
    for (const c of commandRegistry.list()) {
      const defaults = shortcutList(c.shortcut);
      out.push({
        id: c.id,
        kind: 'command',
        label: c.label,
        category: c.category,
        shortcuts: this.shortcuts(c.id),
        defaults,
        custom: this.overrides.has(c.id),
      });
    }
    for (const a of this.actions.values())
      out.push({
        id: a.id,
        kind: 'action',
        label: a.label,
        category: a.category,
        scope: a.scope,
        shortcuts: this.shortcuts(a.id),
        defaults: a.shortcuts,
        custom: this.overrides.has(a.id),
      });
    return out;
  }

  private scopeOf(id: string): string | undefined {
    return this.actions.get(id)?.scope;
  }

  /** The binding that already uses this chord and would clash with giving it to `id` (null = free). */
  findConflict(shortcut: string, id: string): Conflict | null {
    const want = chordId(parseShortcut(shortcut));
    const myScope = this.scopeOf(id);
    for (const r of this.rows()) {
      if (r.id === id) continue;
      // Different scopes never clash (fly keys override global ones inside fly mode), a global one clashes with everything.
      if (myScope !== undefined && r.scope !== undefined && r.scope !== myScope) continue;
      if (myScope !== undefined && r.scope === undefined) continue;
      if (myScope === undefined && r.scope !== undefined) continue;
      for (const s of r.shortcuts) if (chordId(parseShortcut(s)) === want) return { id: r.id, label: r.label };
    }
    return null;
  }

  // ---- editing ---------------------------------------------------------------------------------

  private commit(id: string, list: string[]): void {
    const def = this.defaultsOf(id);
    const same = list.length === def.length && list.every((s, i) => s === def[i]);
    if (same) this.overrides.delete(id);
    else this.overrides.set(id, list);
    this.preset = 'custom';
    this.revision++;
    this.emit('change', undefined);
  }

  defaultsOf(id: string): readonly string[] {
    const a = this.actions.get(id);
    if (a) return a.shortcuts;
    const c = commandRegistry.get(id);
    return c ? shortcutList(c.shortcut) : [];
  }

  /**
   * Set slot `slot` (0-based; `slots.length` appends) to `shortcut`. With a conflict nothing changes unless
   * `steal` is true, in which case the other binding loses the chord. Returns the conflict that was found.
   */
  rebind(id: string, slot: number, shortcut: string, steal = false): { ok: boolean; conflict: Conflict | null } {
    parseShortcut(shortcut);
    const conflict = this.findConflict(shortcut, id);
    if (conflict && !steal) return { ok: false, conflict };
    if (conflict) {
      const want = chordId(parseShortcut(shortcut));
      const other = this.shortcuts(conflict.id).filter((s) => chordId(parseShortcut(s)) !== want);
      this.commit(conflict.id, [...other]);
    }
    const list = [...this.shortcuts(id)];
    if (slot >= list.length) list.push(shortcut);
    else list[slot] = shortcut;
    // The same chord twice in one row is pointless.
    const seen = new Set<string>();
    this.commit(
      id,
      list.filter((s) => {
        const k = chordId(parseShortcut(s));
        return seen.has(k) ? false : (seen.add(k), true);
      }),
    );
    return { ok: true, conflict };
  }

  unbind(id: string, slot: number): void {
    const list = [...this.shortcuts(id)];
    list.splice(slot, 1);
    this.commit(id, list);
  }

  reset(id: string): void {
    if (!this.overrides.delete(id)) return;
    this.revision++;
    this.emit('change', undefined);
  }

  resetAll(): void {
    this.overrides.clear();
    this.preset = 'default';
    this.revision++;
    this.emit('change', undefined);
  }

  applyPreset(preset: Preset): void {
    this.overrides.clear();
    const built = preset.build(this.rows());
    for (const [id, list] of Object.entries(built)) this.overrides.set(id, list);
    this.preset = preset.id;
    this.revision++;
    this.emit('change', undefined);
  }

  // ---- persistence and files -------------------------------------------------------------------

  get bindings(): Record<string, string[]> {
    return Object.fromEntries(this.overrides);
  }

  /** Replace the overrides (settings loaded from storage); invalid chords are dropped. */
  load(bindings: Record<string, string[]>, preset = 'custom'): void {
    this.overrides.clear();
    for (const [id, list] of Object.entries(bindings)) {
      const ok: string[] = [];
      for (const s of list)
        try {
          parseShortcut(s);
          ok.push(s);
        } catch {
          /* a binding from an older or edited file that no longer parses is dropped */
        }
      this.overrides.set(id, ok);
    }
    this.preset = preset;
    this.revision++;
    this.emit('change', undefined);
  }

  exportJson(): string {
    return JSON.stringify(
      { format: 'physicslab-keybindings', version: 1, preset: this.preset, bindings: this.bindings },
      null,
      2,
    );
  }

  /** Import a file made by `exportJson`; throws an Error that says what is wrong. */
  importJson(text: string): { applied: number; skipped: number } {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    const d = data as { format?: unknown; bindings?: unknown } | null;
    if (!d || d.format !== 'physicslab-keybindings' || !d.bindings || typeof d.bindings !== 'object')
      throw new Error('That is not a PhysicsLab key-bindings file.');
    const next: Record<string, string[]> = {};
    let applied = 0;
    let skipped = 0;
    for (const [id, list] of Object.entries(d.bindings as Record<string, unknown>)) {
      const known = this.actions.has(id) || commandRegistry.has(id);
      if (!known || !Array.isArray(list) || !list.every((s) => typeof s === 'string')) {
        skipped++;
        continue;
      }
      try {
        for (const s of list) parseShortcut(s);
      } catch {
        skipped++;
        continue;
      }
      next[id] = list.slice(0, MAX_SLOTS);
      applied++;
    }
    this.load(next, 'imported');
    return { applied, skipped };
  }

  // ---- held actions ----------------------------------------------------------------------------

  /** Is any key of the action in `down` (a set of lower-cased `key`s and `code`s)? */
  isHeld(id: string, down: ReadonlySet<string>): boolean {
    for (const s of this.shortcuts(id)) {
      const c = parseShortcut(s);
      if (down.has(c.key)) return true;
    }
    return false;
  }

  /** Does this key event belong to a held action of the given scope? (Used to keep the keymap from also firing.) */
  ownsKey(e: KeyLike, scope: string): boolean {
    for (const a of this.actions.values()) {
      if (a.scope !== scope) continue;
      for (const s of this.shortcuts(a.id)) {
        const c = parseShortcut(s);
        if (
          chordMatches(
            { ...c, mod: false, shift: null },
            // A KeyboardEvent's fields are prototype getters: copy them out, do not spread the event.
            { key: e.key, code: e.code, ctrlKey: false, metaKey: false, shiftKey: false },
          )
        )
          return true;
      }
    }
    return false;
  }
}

export const inputMap = new InputMap();
