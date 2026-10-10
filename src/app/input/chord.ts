/** Turn a key press into the shortcut text the registry understands ("Mod+Shift+Z", "Space", "Digit1"). */
import { parseShortcut, type KeyLike } from '../registry/shortcuts';

const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/;

/** `null` for a bare modifier press or a key the shortcut syntax has no name for. */
export function chordFromEvent(e: KeyLike): string | null {
  if (MODIFIER_CODES.test(e.code)) return null;
  const mods = `${e.ctrlKey || e.metaKey ? 'Mod+' : ''}${e.shiftKey ? 'Shift+' : ''}`;
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.shiftKey ? e.code : e.code.slice(5);
  else key = e.code;
  const text = mods + key;
  try {
    parseShortcut(text);
    return text;
  } catch {
    return null;
  }
}
