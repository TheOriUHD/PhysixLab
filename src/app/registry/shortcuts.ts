/**
 * Keyboard shortcuts as data: a small text syntax, a parser, a matcher against `KeyboardEvent`s and a formatter
 * for menus, tooltips and the help dialog.
 *
 *   "Mod+Z"        Ctrl on Windows / Linux, ⌘ on macOS (either key counts, like the app always did)
 *   "Mod+Shift+Z"  with Shift
 *   "Shift+Space"  Space is matched by `KeyboardEvent.code`, so it is layout independent
 *   "Q"            a single character is matched by `KeyboardEvent.key` (case-insensitive) — so "1" … "9" and "?"
 *                  follow the user's keyboard layout, as they always did
 *   "Delete" "Escape" "Home" "ArrowUp" "NumpadDecimal" "Period" "F5" …   any longer name is a `KeyboardEvent.code`
 *
 * Shift is "either" unless the chord says `Shift`: "Q" also fires for Shift+Q, but when "Space" and "Shift+Space"
 * are both bound, the exact match wins. Alt is ignored. A chord without `Mod` only matches while neither Ctrl nor ⌘
 * is down, so plain letters never fire inside Ctrl-combinations.
 */

export interface Chord {
  /** Ctrl or ⌘ held. */
  mod: boolean;
  /** true / false = Shift must be down / up; null = either. */
  shift: boolean | null;
  /** `'key'`: compare `KeyboardEvent.key` (lower-cased); `'code'`: compare `KeyboardEvent.code`. */
  by: 'key' | 'code';
  key: string;
}

/** The parts of a `KeyboardEvent` the matcher reads (so it can be tested without a DOM). */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
}

/** The `KeyboardEvent.code` names a shortcut may use (anything else is a typo such as "Esc" or "Del"). */
const KNOWN_CODE =
  /^(Arrow(Up|Down|Left|Right)|Space|Enter|Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Period|Comma|Slash|Backslash|Semicolon|Quote|Minus|Equal|Backquote|BracketLeft|BracketRight|F([1-9]|1\d|2[0-4])|Digit\d|Key[A-Z]|Numpad[A-Za-z0-9]+)$/;

/** Parse "Mod+Shift+Z". Throws a descriptive Error for a malformed chord (a programming error). */
export function parseShortcut(text: string): Chord {
  if (typeof text !== 'string' || !text.trim()) throw new Error('A shortcut cannot be empty');
  // "Plus" stands for the + key itself, so "Mod+Plus" is unambiguous.
  const parts = text.trim().split('+');
  const keyPart = parts.pop() ?? '';
  let mod = false;
  let shift: boolean | null = null;
  for (const m of parts) {
    if (m === 'Mod') mod = true;
    else if (m === 'Shift') shift = true;
    else throw new Error(`Shortcut "${text}": unknown modifier "${m}" (use Mod and Shift)`);
  }
  if (!keyPart) throw new Error(`Shortcut "${text}" has no key`);
  if (keyPart === 'Plus') return { mod, shift, by: 'key', key: '+' };
  if (keyPart.length === 1) return { mod, shift, by: 'key', key: keyPart.toLowerCase() };
  if (!KNOWN_CODE.test(keyPart))
    throw new Error(
      `Shortcut "${text}": "${keyPart}" is not a key name (use a character, or a KeyboardEvent.code such as Space, Escape, Delete, ArrowUp, F5)`,
    );
  return { mod, shift, by: 'code', key: keyPart };
}

/** Does the event press this chord? */
export function chordMatches(c: Chord, e: KeyLike): boolean {
  if (c.mod !== (e.ctrlKey || e.metaKey)) return false;
  if (c.shift !== null && c.shift !== e.shiftKey) return false;
  return c.by === 'code' ? e.code === c.key : e.key.toLowerCase() === c.key;
}

/** Two chords that can both be bound only if they differ in Mod, in an explicit Shift, or in the key. */
export function chordId(c: Chord): string {
  return `${c.mod ? 'M' : ''}${c.shift === true ? 'S' : c.shift === false ? 's' : ''}${c.by === 'code' ? '#' : ':'}${c.key}`;
}

export type Platform = 'mac' | 'pc';

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'pc';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform ?? nav.platform ?? '') ? 'mac' : 'pc';
}

const PC_NAMES: Record<string, string> = {
  Delete: 'Del',
  Escape: 'Esc',
  Period: '.',
  NumpadDecimal: 'Num .',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backspace: 'Backspace',
};

/** The keys of a shortcut as they are printed on keycaps: ["Ctrl", "Shift", "Z"] (macOS: ["⌘", "⇧", "Z"]). */
export function shortcutTokens(text: string, platform: Platform = detectPlatform()): string[] {
  const c = parseShortcut(text);
  const out: string[] = [];
  if (c.mod) out.push(platform === 'mac' ? '⌘' : 'Ctrl');
  if (c.shift === true) out.push(platform === 'mac' ? '⇧' : 'Shift');
  const key = c.by === 'key' ? c.key.toUpperCase() : (PC_NAMES[c.key] ?? c.key);
  out.push(key);
  return out;
}

/** "Ctrl+Shift+Z" (macOS: "⌘⇧Z"). */
export function formatShortcut(text: string, platform: Platform = detectPlatform()): string {
  return shortcutTokens(text, platform).join(platform === 'mac' ? '' : '+');
}

/** A shortcut field as a list (a single string is one shortcut). */
export function shortcutList(s: string | readonly string[] | undefined): readonly string[] {
  return s === undefined ? [] : typeof s === 'string' ? [s] : s;
}
