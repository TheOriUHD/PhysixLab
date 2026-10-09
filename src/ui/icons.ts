/** Inline stroke icons (24×24 viewBox, 1.75 stroke) — one consistent family. */
import { svg } from './dom';

const wrap = (body: string, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;

const PATHS: Record<string, string> = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>',
  step: '<path d="M5 5v14l9-7z" fill="currentColor" stroke="none"/><path d="M18 5v14"/>',
  reset: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  select: '<path d="M5 3l14 7-6 2-2 6z"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
  scale: '<path d="M4 20l16-16M4 20v-6M4 20h6M20 4v6M20 4h-6"/>',
  joint: '<circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M8.2 15.8l7.6-7.6"/>',
  measure: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>',
  blast: '<path d="M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3.5 3.5M15.5 15.5L19 19M19 5l-3.5 3.5M8.5 15.5L5 19"/><circle cx="12" cy="12" r="2.2"/>',
  shoot: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  magnet: '<path d="M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3z"/><path d="M6 7h4M14 7h4"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 4M6.5 6.6C3.7 8.4 2 12 2 12s4 7 10 7c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  frame: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><circle cx="12" cy="12" r="2.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v6h8V3M7 21v-7h10v7"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5M4 21h16"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  panelRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  panelBottom: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  // shapes
  box: '<path d="M12 3l8 4v10l-8 4-8-4V7z"/><path d="M4 7l8 4 8-4M12 11v10"/>',
  sphere: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3.5"/><path d="M12 3a14 14 0 0 1 0 18"/>',
  cylinder: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>',
  capsule: '<path d="M8 9a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0z"/><path d="M8 9h8"/>',
  cone: '<path d="M12 3L5 18c0 1.7 3.1 3 7 3s7-1.3 7-3z"/><path d="M5 18c0-1.1 3.1-2 7-2s7 .9 7 2"/>',
  wedge: '<path d="M3 18h18L21 8z"/><path d="M3 18l4-3h14M21 8l-4 3.5"/>',
  prism: '<path d="M12 3l7 4v8l-7 4-7-4V7z"/><path d="M12 3v8M5 7l7 4 7-4"/>',
  icosahedron: '<path d="M12 2l8.5 5v10L12 22l-8.5-5V7z"/><path d="M12 2L7 10l5 3 5-3zM7 10l-3.5-3M17 10l3.5-3M7 10l5 12M17 10l-5 12M7 10v0"/>',
  // joints
  hinge: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3"/><path d="M5.6 8.2a7.5 7.5 0 0 1 12.8 0"/><path d="M18.4 8.2l.4-3M18.4 8.2l-3-.4"/>',
  slider: '<path d="M3 12h18"/><rect x="9" y="8" width="6" height="8" rx="1.5"/><path d="M3 9v6M21 9v6"/>',
  ball: '<circle cx="12" cy="12" r="4"/><path d="M12 8V3M16 12h5M8 12H3M12 16v5"/>',
  weld: '<rect x="3" y="8" width="7" height="8" rx="1.5"/><rect x="14" y="8" width="7" height="8" rx="1.5"/><path d="M10 12h4"/><path d="M12 9v6"/>',
  spring: '<path d="M3 12h3l1.5-5 3 10 3-10 3 10L18 12h3"/>',
  rope: '<path d="M3 6c4 0 4 8 9 8s5-8 9-8"/><circle cx="3" cy="6" r="1.5" fill="currentColor"/><circle cx="21" cy="6" r="1.5" fill="currentColor"/>',
  car: '<path d="M3 15l1.5-5A2 2 0 0 1 6.4 8.5h11.2a2 2 0 0 1 1.9 1.5L21 15v3H3z"/><circle cx="7.5" cy="18" r="1.8"/><circle cx="16.5" cy="18" r="1.8"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  velocity: '<path d="M4 20L19 5M19 5h-8M19 5v8"/>',
  force: '<circle cx="7" cy="17" r="3"/><path d="M10 14l9-9M19 5h-6M19 5v6"/>',
  contact: '<path d="M3 19h18"/><circle cx="8" cy="19" r="1.6" fill="currentColor"/><circle cx="16" cy="19" r="1.6" fill="currentColor"/><path d="M8 16V8M16 16V8M5 8h14"/>',
  com: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16"/><path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0" fill="currentColor" stroke="none" opacity=".5"/>',
  trail: '<path d="M3 18c4 0 5-12 9-12s4 8 9 8" stroke-dasharray="2 3"/><circle cx="21" cy="14" r="1.6" fill="currentColor"/>',
  joints: '<circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="M8 15l8-6"/><path d="M13 3h6v6" opacity=".0"/>',
  follow: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="8" stroke-dasharray="2 3"/>',
};

export function icon(name: string, cls = 'icon'): SVGSVGElement {
  const body = PATHS[name] ?? PATHS.info;
  return svg(wrap(body), cls);
}

export function iconHtml(name: string): string {
  return wrap(PATHS[name] ?? PATHS.info, 'class="icon"');
}

export const LOGO = `<svg viewBox="0 0 32 32" class="logo-mark" fill="none"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs><rect x="2" y="2" width="28" height="28" rx="8" fill="#0f1620" stroke="url(#lg)" stroke-width="1.6"/><path d="M7 22c3-1 5-6 8-11s6-4 10-1" stroke="url(#lg)" stroke-width="1.8" stroke-linecap="round"/><circle cx="15" cy="11" r="3.2" fill="url(#lg)"/><path d="M7 25h18" stroke="#2c3a4c" stroke-width="1.6" stroke-linecap="round"/></svg>`;
