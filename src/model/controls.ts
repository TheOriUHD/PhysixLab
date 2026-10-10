/**
 * What the player can press or drag in a scene (package CP): every key a component listens to and every analog axis it
 * reads, found by walking the components' schemas — so a component never has to register its inputs twice. The Controls
 * panel lists them and drives them; the tests use the same scan to check that a scene's controls are all reachable.
 *
 * A *key* is a `key` field holding a `KeyboardEvent.code`; an *axis* is a `text` field marked `role: 'axis'` (the name
 * the runtime reads with `ctx.input.axis(name)`). The motor keys of a hinge or slider joint count as keys too.
 */
import { componentDef } from './componentRegistry';
import type { Entity } from './types';
import { isBody, isJoint } from './types';

/** Where one binding comes from — enough to say "Engine · Throttle key on Car chassis". */
export interface ControlUse {
  ownerId: string;
  ownerName: string;
  /** The component's id, or '' for a joint's own motor. */
  componentId: string;
  componentLabel: string;
  fieldLabel: string;
  /** Which of the owner's components of this type it is (1-based), and how many there are: "Rotor 2 of 2". */
  index: number;
  count: number;
}

export interface KeyControl {
  /** A `KeyboardEvent.code` ("KeyW", "Space" …). */
  code: string;
  uses: ControlUse[];
}

export interface AxisControl {
  /** The axis name components read (`ctx.input.axis(name)`). */
  name: string;
  uses: ControlUse[];
}

export interface SceneControls {
  keys: KeyControl[];
  axes: AxisControl[];
}

/** Find every key and axis of the enabled components (and joint motors) in `entities`. First-seen order for keys, A–Z for axes. */
export function sceneControls(entities: readonly Entity[]): SceneControls {
  const keys = new Map<string, KeyControl>();
  const axes = new Map<string, AxisControl>();
  const note = <T extends { uses: ControlUse[] }>(map: Map<string, T>, id: string, make: () => T, use: ControlUse) => {
    let item = map.get(id);
    if (!item) map.set(id, (item = make()));
    if (!item.uses.some((u) => u.componentId === use.componentId && u.fieldLabel === use.fieldLabel))
      item.uses.push(use);
  };
  for (const e of entities) {
    if (!isBody(e) && !isJoint(e)) continue;
    for (const c of e.components) {
      if (!c.enabled) continue;
      const def = componentDef(c.type);
      if (!def) continue;
      const same = e.components.filter((x) => x.type === c.type);
      for (const f of def.fields) {
        const v = c.params[f.key];
        if (typeof v !== 'string' || v === '') continue;
        const use: ControlUse = {
          ownerId: e.id,
          ownerName: e.name,
          componentId: c.id,
          componentLabel: def.label,
          fieldLabel: f.label,
          index: same.indexOf(c) + 1,
          count: same.length,
        };
        if (f.kind === 'key') note(keys, v, () => ({ code: v, uses: [] }), use);
        else if (f.kind === 'text' && f.role === 'axis') note(axes, v, () => ({ name: v, uses: [] }), use);
      }
    }
    if (isJoint(e) && (e.type === 'hinge' || e.type === 'slider') && e.motor.mode !== 'off') {
      for (const [code, label] of [
        [e.motor.keyPos, 'Motor + key'],
        [e.motor.keyNeg, 'Motor − key'],
      ] as const) {
        if (!code) continue;
        const use: ControlUse = {
          ownerId: e.id,
          ownerName: e.name,
          componentId: '',
          componentLabel: 'Joint motor',
          fieldLabel: label,
          index: 1,
          count: 1,
        };
        note(keys, code, () => ({ code, uses: [] }), use);
      }
    }
  }
  return { keys: [...keys.values()], axes: [...axes.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** "Engine · Throttle key (Car chassis)" — one line for a tooltip; "Rotor 2 · …" when the owner has several. */
export function describeUse(u: ControlUse): string {
  return `${u.count > 1 ? `${u.componentLabel} ${u.index}` : u.componentLabel} · ${u.fieldLabel} (${u.ownerName})`;
}

/** The short label of a key cap or slider: the field's name without its trailing "key", and which part when it is one of several. */
export function shortUse(u: ControlUse): string {
  const base = u.fieldLabel.replace(/\s+(key|axis)$/i, '');
  return u.count > 1 ? `${base} · ${u.componentLabel} ${u.index}` : base;
}

/** The names of the text fields with the given role across the scene (for the editor's suggestion list). */
export function namesWithRole(entities: readonly Entity[], role: 'axis' | 'shaft'): string[] {
  const out = new Set<string>();
  for (const e of entities) {
    if (!isBody(e) && !isJoint(e)) continue;
    for (const c of e.components) {
      const def = componentDef(c.type);
      if (!def) continue;
      for (const f of def.fields) {
        const v = c.params[f.key];
        if (f.kind === 'text' && f.role === role && typeof v === 'string' && v) out.add(v);
      }
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}
