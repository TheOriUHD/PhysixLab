/**
 * Empty states: a small illustration, a title, a hint and an optional action, for every list that can be empty.
 * The illustrations are inline SVG drawn with the design tokens (`--text-3`, `--accent`, `--border-2`), so they follow
 * every theme. `emptyState({ art: 'select', title, hint })` returns the element.
 */
import { h, svg } from './dom';
import { icon } from './icons';

export type EmptyArt =
  | 'select'
  | 'scene'
  | 'search'
  | 'folder'
  | 'joint'
  | 'chart'
  | 'tree'
  | 'component'
  | 'recent'
  | 'map'
  | 'light'
  | 'path';

const S = 'stroke="var(--text-3)" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"';
const A = 'stroke="var(--accent)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"';
const DASH = 'stroke-dasharray="4 4"';
const BG = 'fill="var(--panel-2)" stroke="var(--border-2)" stroke-width="1.4"';

const ART: Record<EmptyArt, string> = {
  // A cursor next to a dashed selection box.
  select: `<rect x="14" y="14" width="44" height="34" rx="6" ${S} ${DASH}/><rect x="26" y="26" width="20" height="20" rx="3" ${BG}/><path d="M56 34l22 10-9 3-4 9z" fill="var(--accent)" stroke="var(--accent)" stroke-width="1.4" stroke-linejoin="round"/>`,
  // An empty lab: ground line with a dashed placeholder box and a sparkle.
  scene: `<path d="M8 58h80" ${S}/><rect x="30" y="30" width="28" height="28" rx="4" ${S} ${DASH}/><path d="M72 22v10M67 27h10" ${A}/><circle cx="20" cy="26" r="2.2" fill="var(--border-2)"/>`,
  search: `<circle cx="42" cy="34" r="18" ${BG}/><path d="M55 47l16 16" ${A}/><path d="M34 34h16M34 40h9" ${S}/>`,
  folder: `<path d="M12 22a4 4 0 0 1 4-4h16l6 6h28a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4z" ${BG}/><path d="M12 32h64" stroke="var(--border-2)" stroke-width="1.4"/><path d="M38 46h12" ${A}/>`,
  joint: `<circle cx="24" cy="46" r="11" ${BG}/><circle cx="68" cy="24" r="11" ${BG}/><path d="M32 39l28-10" ${A} ${DASH}/><circle cx="46" cy="34" r="2.4" fill="var(--accent)"/>`,
  chart: `<path d="M14 12v46h70" ${S}/><path d="M20 48c8-4 12-26 22-20s14 18 24 8 10-14 16-16" ${A} ${DASH}/>`,
  tree: `<rect x="14" y="14" width="26" height="10" rx="3" ${BG}/><rect x="30" y="32" width="26" height="10" rx="3" ${BG}/><rect x="30" y="50" width="26" height="10" rx="3" ${BG}/><path d="M20 24v31h10M20 37h10" ${S}/><path d="M64 37h14" ${A} ${DASH}/>`,
  component: `<rect x="22" y="18" width="44" height="34" rx="6" ${BG}/><path d="M34 32h20M34 40h12" ${S}/><circle cx="66" cy="18" r="9" fill="var(--panel)" stroke="var(--accent)" stroke-width="1.8"/><path d="M66 14v8M62 18h8" ${A}/>`,
  recent: `<circle cx="44" cy="35" r="22" ${BG}/><path d="M44 22v14l9 6" ${A}/><path d="M16 35h-4M76 35h4" ${S}/>`,
  map: `<path d="M14 18l20-6 24 8 20-6v38l-20 6-24-8-20 6z" ${BG}/><path d="M34 12v38M58 20v38" ${S}/><circle cx="46" cy="36" r="3" fill="var(--accent)"/>`,
  light: `<circle cx="44" cy="30" r="14" ${BG}/><path d="M38 46h12M40 52h8" ${S}/><path d="M44 8v6M20 30h6M62 30h6M27 13l4 4M61 13l-4 4" ${A}/>`,
  path: `<path d="M12 52c14 0 8-30 24-30s10 26 24 26 10-22 24-22" ${S} ${DASH}/><circle cx="12" cy="52" r="4" ${BG}/><circle cx="84" cy="26" r="4" fill="var(--accent)" stroke="none"/>`,
};

export interface EmptyStateOptions {
  /** Built-in illustration. */
  art?: EmptyArt;
  /** Or an icon of `src/ui/icons.ts`. */
  icon?: string;
  title: string;
  hint?: string;
  action?: { label: string; run: () => void };
  /** Extra class (e.g. to size it in a small dock). */
  class?: string;
}

/** The markup of an illustration (96×72 viewBox). Exposed for tests. */
export const artMarkup = (art: EmptyArt): string =>
  `<svg viewBox="0 0 96 72" width="96" height="72" aria-hidden="true" focusable="false">${ART[art]}</svg>`;

export function emptyState(o: EmptyStateOptions): HTMLElement {
  const el = h('div', { class: `empty-state es${o.class ? ` ${o.class}` : ''}`, role: 'status' });
  if (o.art) el.appendChild(svg(artMarkup(o.art), 'es-art'));
  else if (o.icon) el.appendChild(icon(o.icon, 'icon big'));
  el.appendChild(h('h4', null, o.title));
  if (o.hint) el.appendChild(h('p', null, o.hint));
  if (o.action) {
    const b = h('button', { class: 'btn', type: 'button' }, o.action.label);
    b.addEventListener('click', o.action.run);
    el.appendChild(b);
  }
  return el;
}
