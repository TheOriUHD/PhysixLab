/** UI-40: the one persisted record of what the user has been shown (tours, hints, tips). */
import { GuideStore, type KeyValueStore } from './tourLogic';

function browserStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked site data: the guide still works, it just does not remember
  }
}

export const guide = new GuideStore(browserStorage());

/** `?nowelcome` (used by the test suite and by embeds) also switches off every unsolicited guide popup. */
export function guideQuiet(): boolean {
  try {
    return new URLSearchParams(location.search).has('nowelcome');
  } catch {
    return false;
  }
}

/**
 * Turn the small markup of tour texts into nodes (never innerHTML): `[[Ctrl+K]]` becomes a key cap and
 * `**bold**` becomes bold text. A `Node` passed as a step body is used as it is.
 */
export function richText(text: string | Node): Node {
  if (typeof text !== 'string') return text;
  const frag = document.createDocumentFragment();
  const re = /\[\[(.+?)\]\]|\*\*(.+?)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const el = document.createElement(m[1] !== undefined ? 'kbd' : 'b');
    el.textContent = m[1] ?? m[2] ?? '';
    frag.append(el);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}
