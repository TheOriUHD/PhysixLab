/**
 * InputContexts (`app.contexts`) — resolves which input context is active (see `contexts.ts`), builds the key
 * state the pure resolver needs from the live app, and answers "who owns this key?" for the input controller and
 * "what works now?" for the controls legend.
 */
import { Emitter } from '../../core/events';
import { sceneControls } from '../../model/controls';
import type { App } from '../app';
import { describeKey } from '../drive/vehicle';
import { commandLabel } from '../registry/commands';
import { keymap } from '../registry/keymap';
import { parseShortcut } from '../registry/shortcuts';
import {
  CONTEXT_LABEL,
  emptyKeyState,
  legendFor,
  ownerOf,
  resolveContext,
  type ContextFacts,
  type InputContext,
  type KeyInfo,
  type KeyOwner,
  type KeyState,
  type LegendEntry,
  type LegendSection,
} from './contexts';
import { inputMap } from './inputMap';
import { platform } from './platform';

/** The placement package's ghost (`app.placement.ghost`); absent until that package lands. */
export interface PlacementGhostLike {
  active: boolean;
  handleKey(e: KeyboardEvent): boolean;
  cancel(): void;
  legendEntries(): { keys: string; action: string }[];
}

export function placementGhost(app: App): PlacementGhostLike | undefined {
  return (app as unknown as { placement?: { ghost?: PlacementGhostLike } }).placement?.ghost;
}

/** `KeyboardEvent.code` of a shortcut string: `W` → `KeyW`, `Digit3`, `ArrowUp` … */
export function shortcutCode(s: string): string {
  const c = parseShortcut(s);
  if (c.by === 'code') return c.key;
  if (/^[a-z]$/.test(c.key)) return `Key${c.key.toUpperCase()}`;
  if (/^\d$/.test(c.key)) return `Digit${c.key}`;
  return c.key;
}

/** The lower-case `key` a code types on a US layout (for keymap lookups that match by character). */
export function keyFromCode(code: string): string {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  return code;
}

export function keyInfoOf(e: KeyboardEvent): KeyInfo {
  return { code: e.code, key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey };
}

/** Parse the key strings a ghost lists ("R", "Q / E", "[ ]") into codes, best effort. */
function codesOfLegendKeys(keys: string): string[] {
  const out: string[] = [];
  for (const tok of keys.split(/[\s/,+]+/)) {
    if (/^[A-Za-z]$/.test(tok)) out.push(`Key${tok.toUpperCase()}`);
    else if (/^\d$/.test(tok)) out.push(`Digit${tok}`);
    else if (tok === '[') out.push('BracketLeft');
    else if (tok === ']') out.push('BracketRight');
    else if (/^(Esc|Escape)$/i.test(tok)) out.push('Escape');
    else if (/^Arrow/.test(tok)) out.push(tok);
  }
  return out;
}

export class InputContexts extends Emitter<{ change: InputContext }> {
  current: InputContext = 'edit';
  /** Bumped whenever the context or anything the legend shows may have changed. */
  version = 0;
  /** Set by the input controller: is a (rigid) body held with the pointer? */
  grabProbe: () => boolean = () => false;
  private st: KeyState | null = null;
  private dirty = true;

  constructor(private app: App) {
    super();
    const touch = () => {
      this.dirty = true;
      this.version++;
    };
    app.store.on('change', touch);
    app.store.on('selection', touch);
    app.sim.on('mode', touch);
    app.prefs.on('change', touch);
    inputMap.on('change', touch);
  }

  /** Re-evaluate after something outside the store changed (camera mode, immersive mode, a grab began). */
  invalidate(): void {
    this.dirty = true;
    this.version++;
  }

  facts(): ContextFacts {
    const app = this.app;
    const rig = app.cameraRig;
    return {
      immersive: app.immersive.kind,
      placing: !!placementGhost(app)?.active,
      grabbing: this.grabProbe(),
      flyCamera: (rig.mode === 'fly' || rig.mode === 'chase') && rig.driven,
      simActive: app.sim.active,
    };
  }

  /** The active context (recomputed; emits `change` when it moved). */
  update(): InputContext {
    const next = resolveContext(this.facts());
    if (next !== this.current) {
      this.current = next;
      this.version++;
      this.dirty = true;
      this.emit('change', next);
    }
    return this.current;
  }

  /** The pill text: the context, with the camera named when it is the chase camera. */
  get label(): string {
    if (this.current === 'fly' && this.app.cameraRig.mode === 'chase') return 'Chase camera';
    return CONTEXT_LABEL[this.current];
  }

  keyState(): KeyState {
    const facts = this.facts();
    if (this.st && !this.dirty && this.st.grabbing === facts.grabbing) return this.st;
    this.dirty = false;
    const app = this.app;
    const st = emptyKeyState();
    st.simActive = facts.simActive;
    st.grabbing = facts.grabbing;
    // Scene keys and what the scene calls them.
    const joints = new Map(app.store.joints().map((j) => [j.id, j]));
    const sceneKeys = new Set<string>();
    const sceneLabels = new Map<string, string>();
    for (const k of sceneControls(app.store.all()).keys) {
      sceneKeys.add(k.code);
      sceneLabels.set(k.code, describeKey(k.uses, joints));
    }
    st.sceneKeys = sceneKeys;
    st.sceneLabels = sceneLabels;
    // The active camera mode's held keys.
    const rig = app.cameraRig;
    const flyKeys = new Set<string>();
    const scope = rig.mode === 'fly' ? 'camera.fly.' : rig.mode === 'chase' ? 'camera.chase.' : '';
    if (scope && rig.driven)
      for (const r of inputMap.rows())
        if (r.kind === 'action' && r.id.startsWith(scope))
          for (const s of r.shortcuts)
            try {
              flyKeys.add(shortcutCode(s));
            } catch {
              /* an unparsable binding is ignored */
            }
    st.flyKeys = flyKeys;
    st.hasCommand = (k) =>
      keymap.find({
        key: k.key ?? keyFromCode(k.code),
        code: k.code,
        ctrlKey: k.ctrl,
        metaKey: k.meta,
        shiftKey: k.shift,
      }) !== undefined;
    st.commandLabel = (k) => {
      const def = keymap.find({
        key: k.key ?? keyFromCode(k.code),
        code: k.code,
        ctrlKey: k.ctrl,
        metaKey: k.meta,
        shiftKey: k.shift,
      });
      return def ? commandLabel(def, app) : undefined;
    };
    st.nudgeOwnsArrows = !app.sim.active && app.store.selection.length > 0;
    st.navKeys = app.input.settings.nav?.keyboardNav ?? true;
    const ghost = placementGhost(app);
    if (ghost?.active) {
      const codes = new Set<string>();
      for (const e of ghost.legendEntries()) for (const c of codesOfLegendKeys(e.keys)) codes.add(c);
      st.placementKeys = codes;
    }
    const imm = app.immersive;
    if (imm.kind === 'drive' && imm.vehicle) {
      st.vehicleKeys = new Set(imm.vehicle.controls.map((c) => c.code));
      st.vehicleLabels = new Map(imm.vehicle.controls.map((c) => [c.code, c.label]));
      st.driveUtil = imm.driveKeys;
    }
    if (imm.kind === 'play') {
      st.flyKeys = new Set(
        inputMap
          .rows()
          .filter((r) => r.kind === 'action' && r.id.startsWith('camera.fly.'))
          .flatMap((r) => r.shortcuts.map((s) => shortcutCode(s))),
      );
    }
    st.isPaletteKey = (k) => (k.ctrl || k.meta) && k.code === 'KeyK';
    this.st = st;
    return st;
  }

  /** Who owns this key press right now? */
  ownerOf(e: KeyboardEvent): KeyOwner {
    return ownerOf(this.update(), keyInfoOf(e), this.keyState());
  }

  /** The legend sections of the current context for this platform and pointing device. */
  legend(): LegendSection[] {
    const ctx = this.update();
    const p = platform();
    const extra: LegendEntry[] = [];
    const ghost = placementGhost(this.app);
    if (ctx === 'placing' && ghost)
      for (const [i, e] of ghost.legendEntries().entries())
        extra.push({ id: `ghost.${i}`, keys: [e.keys], codes: codesOfLegendKeys(e.keys), action: e.action });
    const device = p.pointer(this.app.input.settings.nav?.device ?? 'auto');
    return legendFor(ctx, this.keyState(), { os: p.os, device }, extra);
  }
}
