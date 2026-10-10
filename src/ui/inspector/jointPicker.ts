/**
 * Joint type picker (JT-9): a grouped popover with a small diagram per type. Used by the inspector's
 * "Change type…" button; `jointDiagram` is also reusable wherever a type needs a picture. The diagrams are inline SVG
 * drawn with `currentColor` and the design tokens (see `styles/joints.css`), so they follow the theme.
 */
import { JOINT_ITEMS } from '../../app/addCatalog';
import { JOINT_TYPE_LABELS } from '../../model/factory';
import { JOINT_GROUPS, type ConvertTarget } from '../../model/jointConvert';
import type { JointType } from '../../model/types';
import { h, svg } from '../dom';

// b = body, j = the joint (accent), w = world / fixed, t = thin detail
const BODY = 'class="b"';
const JOINT = 'class="j"';
const THIN = 'class="t"';
const ARC = (cx: number, cy: number, r: number, a0: number, a1: number) => {
  const p = (a: number) => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  return `<path ${JOINT} fill="none" d="M${p(a0)} A${r} ${r} 0 0 1 ${p(a1)}"/>`;
};
const wall = (x: number) =>
  `<path class="w" d="M${x} 6V38M${x - 4} 10l4-4M${x - 4} 18l4-4M${x - 4} 26l4-4M${x - 4} 34l4-4"/>`;
const zigzag = (x0: number, x1: number, y: number, n: number, amp = 5) => {
  const dx = (x1 - x0) / (n * 2);
  let d = `M${x0} ${y}`;
  for (let i = 0; i < n * 2; i++) d += `L${(x0 + dx * (i + 0.5)).toFixed(1)} ${y + (i % 2 ? amp : -amp)}`;
  return `<path ${JOINT} fill="none" d="${d}L${x1} ${y}"/>`;
};

const DIAGRAMS: Record<JointType, string> = {
  fixed: `<rect ${BODY} x="6" y="12" width="24" height="20" rx="2"/><rect ${BODY} x="34" y="12" width="24" height="20" rx="2"/>
    <path ${JOINT} d="M32 8V36"/><circle class="d" cx="32" cy="14" r="1.6"/><circle class="d" cx="32" cy="22" r="1.6"/><circle class="d" cx="32" cy="30" r="1.6"/>`,
  softweld: `<rect ${BODY} x="5" y="12" width="21" height="20" rx="2"/><rect ${BODY} x="38" y="12" width="21" height="20" rx="2"/>
    ${zigzag(26, 38, 22, 3, 4)}`,
  hinge: `${wall(10)}<rect ${BODY} x="12" y="17" width="40" height="10" rx="2" transform="rotate(-18 16 22)"/>
    <circle ${JOINT} cx="16" cy="22" r="3.4" fill="var(--panel-2)"/>${ARC(16, 22, 30, -0.1, 0.5)}`,
  universal: `<rect ${BODY} x="4" y="18" width="20" height="8" rx="2"/><rect ${BODY} x="40" y="18" width="20" height="8" rx="2" transform="rotate(28 50 22)"/>
    <path ${JOINT} d="M24 22L32 14L40 22L32 30Z" fill="var(--panel-2)"/><path ${THIN} d="M32 14V30M24 22H40"/>`,
  ball: `<rect ${BODY} x="4" y="25" width="26" height="8" rx="2" transform="rotate(-24 28 24)"/><rect ${BODY} x="34" y="12" width="26" height="8" rx="2" transform="rotate(28 36 20)"/>
    <circle ${JOINT} cx="32" cy="22" r="6.5" fill="var(--panel-2)"/><path ${THIN} d="M26 22a6 2.4 0 0 0 12 0"/>`,
  conetwist: `<path ${JOINT} fill="var(--accent-bg)" d="M12 22L52 8A4 14 0 0 1 52 36Z"/><rect ${BODY} x="12" y="19" width="34" height="6" rx="2" transform="rotate(-8 12 22)"/>
    <circle class="d" cx="12" cy="22" r="2.4"/><path ${THIN} d="M52 14a3 8 0 0 1 0 16"/>`,
  slider: `<path ${JOINT} d="M6 30H58"/><path ${JOINT} d="M6 34H58" opacity=".5"/><rect ${BODY} x="22" y="14" width="20" height="14" rx="2"/>
    <path ${THIN} d="M11 12H3M3 12l3-2.4M3 12l3 2.4M53 12h8M61 12l-3-2.4M61 12l-3 2.4"/>`,
  screw: `<rect ${BODY} x="6" y="19" width="52" height="6" rx="3"/><path ${JOINT} d="M12 19l3 6M19 19l3 6M26 19l3 6M33 19l3 6M40 19l3 6M47 19l3 6"/>
    <rect ${BODY} x="26" y="10" width="14" height="24" rx="2" fill="var(--panel-2)"/>${ARC(50, 22, 8, -2.4, -0.6)}`,
  sixdof: `<rect ${BODY} x="24" y="15" width="16" height="14" rx="2"/>
    <path ${JOINT} d="M32 22H58M58 22l-4-2.4M58 22l-4 2.4M32 22V4M32 4l-2.4 4M32 4l2.4 4M32 22L12 36M12 36l5.4-1M12 36l2-4.6"/>
    ${ARC(32, 22, 11, -0.3, 0.9)}`,
  spring: `<rect ${BODY} x="3" y="14" width="12" height="16" rx="2"/><rect ${BODY} x="49" y="14" width="12" height="16" rx="2"/>${zigzag(15, 49, 22, 5, 7)}`,
  rope: `<rect ${BODY} x="3" y="8" width="12" height="14" rx="2"/><rect ${BODY} x="49" y="8" width="12" height="14" rx="2"/>
    <path ${JOINT} fill="none" d="M15 15C22 38 42 38 49 15" stroke-dasharray="0.1 0"/><path ${THIN} d="M18 22l1 3M46 22l-1 3"/>`,
  pulley: `<path class="w" d="M8 6H56"/><path class="w" d="M32 6V10"/><circle ${JOINT} cx="32" cy="16" r="6" fill="var(--panel-2)"/><circle class="d" cx="32" cy="16" r="1.4"/>
    <path ${JOINT} d="M26 16V30M38 16V24"/><rect ${BODY} x="19" y="30" width="14" height="10" rx="2"/><rect ${BODY} x="32" y="24" width="12" height="9" rx="2"/>`,
  winch: `<path class="w" d="M6 8H34"/><circle ${JOINT} cx="20" cy="18" r="9" fill="var(--panel-2)"/><circle ${THIN} cx="20" cy="18" r="4"/>
    <path ${THIN} d="M20 18L30 12"/><circle class="d" cx="30" cy="12" r="1.6"/><path ${JOINT} d="M29 18V32"/><rect ${BODY} x="22" y="32" width="14" height="9" rx="2"/>`,
  gear: `<circle ${BODY} cx="22" cy="22" r="11"/><circle ${JOINT} cx="22" cy="22" r="14" fill="none" stroke-width="3" stroke-dasharray="3.6 3.6"/>
    <circle ${BODY} cx="46" cy="22" r="8"/><circle ${JOINT} cx="46" cy="22" r="10.6" fill="none" stroke-width="3" stroke-dasharray="3.6 3.6" stroke-dashoffset="1.8"/>
    <circle class="d" cx="22" cy="22" r="2"/><circle class="d" cx="46" cy="22" r="2"/>`,
  rack: `<circle ${BODY} cx="30" cy="15" r="9"/><circle ${JOINT} cx="30" cy="15" r="11.6" fill="none" stroke-width="3" stroke-dasharray="3.6 3.6"/>
    <rect ${BODY} x="4" y="29" width="56" height="8" rx="1.5"/><path ${JOINT} stroke-width="3" stroke-dasharray="3.6 3.6" d="M5 28H59"/>
    <circle class="d" cx="30" cy="15" r="2"/><path ${THIN} d="M44 41H58M58 41l-3-2M58 41l-3 2"/>`,
  belt: `<circle ${BODY} cx="17" cy="22" r="11"/><circle ${BODY} cx="48" cy="22" r="6"/><path ${JOINT} d="M17 11L48 16M17 33L48 28"/>
    <circle class="d" cx="17" cy="22" r="2"/><circle class="d" cx="48" cy="22" r="2"/>`,
};

/** The small picture of a joint type (64×44, themed through CSS). */
export function jointDiagram(type: JointType, cls = 'jt-dia'): SVGSVGElement {
  return svg(
    `<svg viewBox="0 0 64 44" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DIAGRAMS[type]}</svg>`,
    cls,
  );
}

const BLURB = new Map<JointType, string>(JOINT_ITEMS.map((i) => [i.type, i.blurb]));

export interface PickerOptions {
  /** Type to highlight as the current one. */
  current?: JointType;
  /** Which types may be chosen and why not; types missing from the list are all selectable. */
  targets?: readonly ConvertTarget[];
  title?: string;
  onPick: (type: JointType) => void;
}

let openEl: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function closeJointPicker(): void {
  cleanup?.();
  cleanup = null;
  openEl?.remove();
  openEl = null;
}

/** Show the picker below `anchor`; it closes on a pick, Esc or a click outside. */
export function openJointPicker(anchor: HTMLElement, o: PickerOptions): void {
  closeJointPicker();
  const info = new Map((o.targets ?? []).map((t) => [t.type, t]));
  const pop = h('div', { class: 'jt-picker', role: 'dialog', 'aria-label': o.title ?? 'Joint type' });
  pop.appendChild(h('div', { class: 'jt-picker-title' }, o.title ?? 'Joint type'));
  for (const g of JOINT_GROUPS) {
    const grid = h('div', { class: 'jt-grid' });
    for (const type of g.types) {
      const t = info.get(type);
      const isCurrent = type === o.current;
      const disabled = !isCurrent && t?.ok === false;
      const tile = h(
        'button',
        {
          class: `jt-tile${isCurrent ? ' current' : ''}`,
          type: 'button',
          disabled,
          title: disabled
            ? (t?.reason ?? '')
            : isCurrent
              ? 'Current type'
              : (BLURB.get(type) ?? JOINT_TYPE_LABELS[type]),
          dataset: { type },
        },
        jointDiagram(type),
        h('span', { class: 'jt-name' }, JOINT_TYPE_LABELS[type]),
      );
      tile.addEventListener('click', () => {
        closeJointPicker();
        if (!isCurrent) o.onPick(type);
      });
      grid.appendChild(tile);
    }
    pop.append(h('div', { class: 'jt-group' }, g.label), grid);
  }
  pop.appendChild(
    h(
      'p',
      { class: 'hint-text' },
      'Converting keeps the bodies, anchors and axis and carries over the settings that make sense (limits, motor, lengths). It is one undo step.',
    ),
  );
  document.body.appendChild(pop);
  openEl = pop;

  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const hgt = pop.offsetHeight;
  const x = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  const below = r.bottom + 4;
  const y = below + hgt > window.innerHeight - 8 ? Math.max(8, window.innerHeight - hgt - 8) : below;
  pop.style.left = `${x}px`;
  pop.style.top = `${y}px`;
  pop.querySelector<HTMLButtonElement>('.jt-tile.current, .jt-tile:not(:disabled)')?.focus();

  const onDown = (e: PointerEvent) => {
    if (!pop.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node))
      closeJointPicker();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeJointPicker();
      anchor.focus();
    }
  };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  cleanup = () => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
  };
}
