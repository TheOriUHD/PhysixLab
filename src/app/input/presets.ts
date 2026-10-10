/** Keyboard layout presets for Settings › Keyboard: generated from the current defaults, so new commands are covered too. */
import { chordId, parseShortcut } from '../registry/shortcuts';
import type { BindingRow, Preset } from './inputMap';

/** Left-hand keys ↔ their mirror on the right hand (an involution, so a mirrored layout never collides with itself). */
const MIRROR: Record<string, string> = {
  q: 'p',
  w: 'o',
  e: 'i',
  r: 'u',
  t: 'y',
  a: 'Semicolon',
  s: 'l',
  d: 'k',
  f: 'j',
  g: 'h',
  z: 'Slash',
  x: 'Period',
  c: 'Comma',
  v: 'm',
  b: 'n',
};
const MIRROR_BOTH: Record<string, string> = { ...MIRROR };
for (const [k, v] of Object.entries(MIRROR)) MIRROR_BOTH[v.length === 1 ? v : v] = k;

/** Rewrite the key part of "Mod+Shift+K" (modifiers kept). */
function mapKey(shortcut: string, fn: (key: string) => string | undefined): string | null {
  const parts = shortcut.split('+');
  const key = parts.pop() ?? '';
  const next = fn(key);
  return next === undefined ? null : [...parts, next.length === 1 ? next.toUpperCase() : next].join('+');
}

function transform(
  rows: readonly BindingRow[],
  pick: (row: BindingRow, key: string, mods: string[]) => string | undefined,
) {
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    let changed = false;
    const list = r.defaults.map((s) => {
      const mods = s.split('+').slice(0, -1);
      const n = mapKey(s, (k) => pick(r, k, mods));
      if (n && n !== s) changed = true;
      return n ?? s;
    });
    if (changed) out[r.id] = list;
  }
  return out;
}

/** Hand out replacement keys that no binding uses. */
function allocator(rows: readonly BindingRow[], pool: readonly string[]) {
  const used = new Set<string>();
  for (const r of rows)
    for (const s of r.defaults) {
      const c = parseShortcut(s);
      used.add(`${c.by}:${c.key}`);
    }
  const memo = new Map<string, string>();
  return (source: string): string | undefined => {
    const hit = memo.get(source);
    if (hit) return hit;
    for (const cand of pool) {
      const c = parseShortcut(cand);
      const k = `${c.by}:${c.key}`;
      if (used.has(k)) continue;
      used.add(k);
      memo.set(source, cand);
      return cand;
    }
    return undefined;
  };
}

const RIGHT_HAND = new Set([
  'h',
  'j',
  'k',
  'l',
  'm',
  'n',
  'u',
  'i',
  'o',
  'p',
  'y',
  'Period',
  'Comma',
  'Slash',
  'Semicolon',
  'Delete',
  'Backspace',
  'Enter',
  'NumpadDecimal',
  'Home',
  'End',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

export const PRESETS: readonly Preset[] = [
  { id: 'default', label: 'Default', blurb: 'The standard layout: WASD to fly, Q W E R tools.', build: () => ({}) },
  {
    id: 'left-handed',
    label: 'Left-handed',
    blurb:
      'Mirrors the left-hand letters (Q W E R, A S D F, Z X C V …) onto the right hand so the mouse can stay left.',
    build: (rows) =>
      transform(rows, (_r, key, mods) => {
        if (mods.includes('Mod')) return undefined;
        const k = key.length === 1 ? key.toLowerCase() : key;
        return MIRROR_BOTH[k];
      }),
  },
  {
    id: 'one-handed',
    label: 'One-handed (left)',
    blurb:
      'Moves every right-hand key (H J L M, Delete, arrows …) onto free keys under the left hand and the function row.',
    build: (rows) => {
      const alloc = allocator(rows, [
        'z',
        'v',
        'a',
        's',
        'd',
        'Backquote',
        'F1',
        'F2',
        'F3',
        'F4',
        'F6',
        'F7',
        'F8',
        'F9',
      ]);
      return transform(rows, (r, key, mods) => {
        if (mods.includes('Mod') && key.length === 1) return undefined;
        if (r.scope === 'fly') return undefined;
        const k = key.length === 1 ? key.toLowerCase() : key;
        return RIGHT_HAND.has(k) ? alloc(k) : undefined;
      });
    },
  },
  {
    id: 'wasd-free',
    label: 'No WASD',
    blurb: 'Keeps W A S D free: fly with the arrow keys and Page Up / Page Down, and move the commands that used them.',
    build: (rows) => {
      const alloc = allocator(rows, ['z', 'v', 'u', 'i', 'o', 'p', 'Backquote']);
      const fly: Record<string, string> = {
        'camera.fly.forward': 'ArrowUp',
        'camera.fly.back': 'ArrowDown',
        'camera.fly.left': 'ArrowLeft',
        'camera.fly.right': 'ArrowRight',
        'camera.fly.up': 'PageUp',
        'camera.fly.down': 'PageDown',
      };
      const out = transform(rows, (r, key) => {
        if (r.scope === 'fly') return undefined;
        const k = key.toLowerCase();
        return key.length === 1 && 'wasd'.includes(k) ? alloc(k) : undefined;
      });
      for (const [id, key] of Object.entries(fly)) if (rows.some((r) => r.id === id)) out[id] = [key];
      return out;
    },
  },
];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

/** Self-check used by tests: a preset's result must not bind one chord twice within a scope. */
export function duplicateChords(rows: readonly BindingRow[], overrides: Record<string, string[]>): string[] {
  const seen = new Map<string, string>();
  const dup: string[] = [];
  for (const r of rows) {
    for (const s of overrides[r.id] ?? r.shortcuts) {
      const k = `${r.scope ?? ''}|${chordId(parseShortcut(s))}`;
      const o = seen.get(k);
      if (o && o !== r.id) dup.push(`${s}: ${o} / ${r.id}`);
      seen.set(k, r.id);
    }
  }
  return dup;
}
