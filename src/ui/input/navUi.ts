/**
 * The on-screen side of the input contexts and the immersive modes:
 *
 *   context pill + controls legend   bottom-left of the viewport; the pill names the active input context, the legend
 *                                    (collapsible) lists what every key does *now* — keys that do nothing in this
 *                                    context are shown struck out with the reason — and lights keys while pressed
 *   drive HUD                        vehicle name, speedometer (+ gear / rpm when the powertrain publishes them),
 *                                    camera name, paused / tilted notes and an always-visible Exit button
 */
import type { App } from '../../app/app';
import { CONTEXT_BLURB, type LegendSection } from '../../app/input/contexts';
import { DRIVE_CAMERA_LABEL } from '../../app/drive/immersive';
import { h } from '../dom';

const STORE_KEY = 'physicslab:legend:v1';

/** The user's open / closed choice for the legend (per browser). */
export const legendState = {
  expanded: false,
  listeners: new Set<() => void>(),
  load(): void {
    try {
      this.expanded = localStorage.getItem(STORE_KEY) === 'open';
    } catch {
      /* storage unavailable: the default stays */
    }
  },
  set(v: boolean): void {
    this.expanded = v;
    try {
      localStorage.setItem(STORE_KEY, v ? 'open' : 'closed');
    } catch {
      /* storage unavailable */
    }
    for (const fn of this.listeners) fn();
  },
  toggle(): void {
    this.set(!this.expanded);
  },
};

export function mountNavUi(app: App, stage: HTMLElement): void {
  legendState.load();
  mountLegend(app, stage);
  mountDriveHud(app, stage);
}

// ---- controls legend + pill ----------------------------------------------------------------------------------------

function mountLegend(app: App, stage: HTMLElement): void {
  const dot = h('i', { class: 'ctl-dot' });
  const ctxName = h('span', { class: 'ctl-ctx' }, 'Edit');
  const caret = h('span', { class: 'ctl-caret' }, 'Controls');
  const pill = h(
    'button',
    { class: 'ctl-pill', type: 'button', 'aria-expanded': 'false', title: 'What do the keys do right now?' },
    dot,
    ctxName,
    caret,
  );
  const body = h('div', { class: 'ctl-body', hidden: true });
  const root = h('div', { class: 'ctl-legend', 'data-immersive': '', role: 'group', 'aria-label': 'Controls' }, pill, body);
  stage.appendChild(root);

  /** The rows currently shown with the key codes that light them. */
  let rows: { el: HTMLElement; codes: string[]; lit: boolean }[] = [];
  let shownVersion = -1;
  let shownOpen = false;
  let shownSig = '';

  const forced = () => app.immersive.active; // drive / play show the legend whatever the user chose
  const open = () => forced() || legendState.expanded;

  const render = (sections: LegendSection[]) => {
    rows = [];
    const out: HTMLElement[] = [h('p', { class: 'ctl-blurb' }, CONTEXT_BLURB[app.contexts.current])];
    for (const s of sections) {
      const list = h('div', { class: 'ctl-list' });
      for (const e of s.entries) {
        const keys = h(
          'span',
          { class: 'ctl-keys' },
          e.keys.map((k) => h('kbd', null, k)),
          e.with ? h('span', { class: 'ctl-gesture' }, e.with) : null,
        );
        const row = h(
          'div',
          { class: `ctl-row${e.unavailable ? ' off' : ''}`, dataset: { id: e.id } },
          keys,
          h('span', { class: 'ctl-act' }, e.action),
          e.unavailable ? h('em', { class: 'ctl-why' }, `unavailable — ${e.unavailable}`) : null,
        );
        if (e.codes?.length) rows.push({ el: row, codes: e.codes, lit: false });
        list.appendChild(row);
      }
      out.push(h('section', { class: 'ctl-sec', dataset: { sec: s.id } }, h('h4', null, s.title), list));
    }
    body.replaceChildren(...out);
  };

  const sync = () => {
    const isOpen = open();
    const ctx = app.contexts.update();
    root.dataset.ctx = ctx;
    ctxName.textContent = app.contexts.label;
    caret.textContent = isOpen ? 'Hide' : 'Controls';
    pill.setAttribute('aria-expanded', String(isOpen));
    pill.disabled = forced();
    body.hidden = !isOpen;
    root.classList.toggle('open', isOpen);
    if (!isOpen) {
      shownOpen = false;
      return;
    }
    // Rebuild only when something it shows may have changed.
    const sections = app.contexts.legend();
    const sig = JSON.stringify(sections);
    if (!shownOpen || shownVersion !== app.contexts.version || sig !== shownSig) {
      shownOpen = true;
      shownVersion = app.contexts.version;
      shownSig = sig;
      render(sections);
    }
  };

  pill.addEventListener('click', () => legendState.toggle());
  legendState.listeners.add(sync);
  app.immersive.on('change', sync);
  app.contexts.on('change', sync);
  sync();

  // Light the keys that are down.
  let tick = 0;
  app.on('frame', () => {
    // A cheap poll a few times per second keeps the legend in step with edits that raise no event.
    if (++tick % 15 === 0 && (open() || root.dataset.ctx !== app.contexts.current)) sync();
    if (!rows.length) return;
    const down = app.input.down;
    for (const r of rows) {
      const lit = r.codes.some((c) => down.has(c));
      if (lit !== r.lit) {
        r.lit = lit;
        r.el.classList.toggle('down', lit);
      }
    }
  });
}

// ---- drive HUD -----------------------------------------------------------------------------------------------------

function mountDriveHud(app: App, stage: HTMLElement): void {
  const imm = app.immersive;
  const title = h('span', { class: 'drv-name' }, '');
  const cam = h('span', { class: 'drv-cam' }, '');
  const exit = h('button', { class: 'drv-exit', type: 'button', title: 'Leave (Esc or Tab)' }, 'Exit');
  exit.addEventListener('click', () => imm.exit());
  const speed = h('b', { class: 'drv-speed-n' }, '0');
  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arc.setAttribute('viewBox', '0 0 120 120');
  arc.setAttribute('class', 'drv-arc');
  arc.innerHTML =
    '<circle class="bg" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="75 25" transform="rotate(135 60 60)"/>' +
    '<circle class="fg" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="0 100" transform="rotate(135 60 60)"/>';
  const fg = arc.querySelector('.fg') as SVGCircleElement;
  const aux = h('div', { class: 'drv-aux' }, '');
  const gauge = h('div', { class: 'drv-gauge' }, arc, h('div', { class: 'drv-gauge-text' }, speed, h('small', null, 'km/h'), aux));
  const note = h('div', { class: 'drv-note' }, '');
  const root = h(
    'div',
    { class: 'drv-hud', 'data-immersive': '', hidden: true },
    h('div', { class: 'drv-top' }, title, cam, exit),
    gauge,
    note,
  );
  stage.appendChild(root);

  let scale = 60; // km/h at the end of the gauge; grows with the speed seen
  let last = '';
  const sync = () => {
    const on = imm.active;
    root.hidden = !on;
    root.classList.toggle('play', imm.kind === 'play');
    gauge.hidden = imm.kind !== 'drive';
    if (on && imm.kind === 'play') {
      title.textContent = 'Play mode';
      cam.textContent = 'Free camera';
    }
    if (on) exit.focus({ preventScroll: true });
    else exit.blur();
    last = '';
    scale = 60;
  };
  imm.on('change', sync);
  sync();
  app.on('frame', () => {
    if (!imm.active) return;
    if (imm.kind === 'play') {
      note.textContent = '';
      return;
    }
    const h2 = imm.hud;
    while (h2.speed > scale * 0.95) scale = scale < 120 ? 120 : scale + 120;
    const sig = `${Math.round(h2.speed)}|${h2.rpm === null ? '' : Math.round(h2.rpm / 10)}|${h2.gear ?? ''}|${h2.paused}|${h2.tilted}|${h2.camera}|${h2.name}|${scale}`;
    if (sig === last) return;
    last = sig;
    title.textContent = h2.name;
    cam.textContent = `${DRIVE_CAMERA_LABEL[h2.camera]} camera`;
    speed.textContent = String(Math.round(h2.speed));
    fg.setAttribute('stroke-dasharray', `${Math.min(75, (h2.speed / scale) * 75).toFixed(1)} 100`);
    const bits: string[] = [];
    if (h2.gear !== null) bits.push(h2.gear < 0 ? 'R' : h2.gear === 0 ? 'N' : `Gear ${h2.gear}`);
    if (h2.rpm !== null) bits.push(`${Math.round(h2.rpm / 10) * 10} rpm`);
    aux.textContent = bits.join(' · ');
    note.textContent = h2.paused ? 'Paused — resume with the pause key' : h2.tilted ? 'Tilted — press the reset key to flip upright' : '';
    note.classList.toggle('warn', h2.tilted && !h2.paused);
  });
}
