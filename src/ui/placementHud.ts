/**
 * The on-screen part of ghost placement: a hint bar at the bottom of the viewport that names the keys
 * (`Click to place · Esc to cancel · Q/E or R rotate · [ ] raise/lower · Shift+click = place several`), the current
 * turn / height / alignment and any warning, with Place and Cancel buttons for touch and one-handed use; and a small
 * chip that follows the pointer while a tile is being dragged (and says so when letting go would cancel). It also
 * highlights the tile that is armed.
 */
import type { App } from '../app/app';
import { h } from './dom';
import { icon } from './icons';
import '../styles/placement.css';

const ARMED_TEXT = 'Click to place · Esc to cancel · Q/E or R rotate · [ ] raise/lower · Shift+click = place several';
const DRAG_TEXT =
  'Release to place · Esc to cancel · Q/E or R rotate · [ ] raise/lower · Release over a panel to cancel';

const fmtLift = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 1000) / 1000)} m`;

export function mountPlacementHud(app: App, stage: HTMLElement): void {
  const ghost = app.placement.ghost;
  const main = h('div', { class: 'place-hud-main' });
  const sub = h('div', { class: 'place-hud-sub' });
  const place = h(
    'button',
    { class: 'btn primary small', type: 'button', title: 'Place it where the ghost is (Enter)' },
    'Place',
  );
  const cancel = h('button', { class: 'btn small', type: 'button', title: 'Cancel placement (Esc)' }, 'Cancel');
  const actions = h('div', { class: 'place-hud-actions' }, place, cancel);
  const hud = h('div', { class: 'place-hud', role: 'status', 'aria-live': 'polite', hidden: true }, main, sub, actions);
  stage.appendChild(hud);
  place.addEventListener('click', () => ghost.placeNow());
  cancel.addEventListener('click', () => ghost.cancel());

  const chipLabel = h('span', { class: 'place-chip-label' });
  const chipIcon = h('span', { class: 'place-chip-icon' });
  const chip = h('div', { class: 'place-chip', hidden: true }, chipIcon, chipLabel);
  document.body.appendChild(chip);

  const render = (): void => {
    const s = ghost.hud();
    document.querySelectorAll('.placeable.armed').forEach((n) => n.classList.remove('armed'));
    if (!s) {
      hud.hidden = true;
      chip.hidden = true;
      return;
    }
    const id = ghost.placeable?.id;
    if (id) {
      for (const n of document.querySelectorAll<HTMLElement>('.placeable')) {
        if (n.dataset.placeable === id) n.classList.add('armed');
      }
    }
    hud.hidden = false;
    hud.classList.toggle('drag', s.mode === 'drag');
    main.textContent = s.mode === 'armed' ? ARMED_TEXT : DRAG_TEXT;
    const flag = s.reason
      ? h('span', { class: 'place-flag bad' }, s.reason)
      : s.warning
        ? h('span', { class: 'place-flag warn' }, s.warning)
        : null;
    sub.replaceChildren(
      h('b', null, s.label),
      h('span', null, `Turn ${s.yawDeg}°`),
      h('span', null, `Height ${fmtLift(s.lift)}`),
      h('span', null, `Align to surface ${s.align ? 'on' : 'off'} (X)`),
      h('span', { class: 'muted' }, 'Hold Alt: no snapping'),
      ...(flag ? [flag] : []),
    );
    actions.hidden = s.mode === 'drag';
    if (s.mode === 'drag') {
      chip.hidden = false;
      chipIcon.replaceChildren(icon(s.icon));
      chipLabel.textContent = s.overViewport ? s.label : `${s.label} — release to cancel`;
      chip.classList.toggle('cancel', !s.overViewport);
    } else chip.hidden = true;
  };
  ghost.on('change', render);
  render();

  window.addEventListener(
    'pointermove',
    (e) => {
      if (ghost.mode !== 'drag') return;
      chip.style.transform = `translate(${e.clientX + 16}px, ${e.clientY + 14}px)`;
    },
    { capture: true, passive: true },
  );
}
