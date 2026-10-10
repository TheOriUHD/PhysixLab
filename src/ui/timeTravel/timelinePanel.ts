/**
 * The Timeline tab of the bottom dock (TM-3): transport (step back, hold-to-rewind, play, step forward, speed), a
 * scrubber that shows the recorded run with its snapshot ticks, event markers, bookmarks and loop region, and the
 * bookmark list. Everything it shows comes from `TimeTravel` (`src/app/timeTravel.ts`).
 */
import type { App } from '../../app/app';
import type { PanelDef, PanelView } from '../../app/registry/panels';
import { timeTravelFor, type Marker, type MarkerKind } from '../../app/timeTravel';
import { iconButton, segmented } from '../controls';
import { h, svg } from '../dom';
import { promptText } from '../modal';

const GLYPH = {
  toStart:
    '<svg class="icon" viewBox="0 0 16 16"><path d="M3 3v10M13 3L6 8l7 5z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  back: '<svg class="icon" viewBox="0 0 16 16"><path d="M12 3L5 8l7 5zM3 3v10" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  rewind:
    '<svg class="icon" viewBox="0 0 16 16"><path d="M8 3L1.5 8 8 13zM14.5 3L8 8l6.5 5z" fill="currentColor"/></svg>',
  forward:
    '<svg class="icon" viewBox="0 0 16 16"><path d="M4 3l7 5-7 5zM13 3v10" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  toEnd:
    '<svg class="icon" viewBox="0 0 16 16"><path d="M13 3v10M3 3l7 5-7 5z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  loop: '<svg class="icon" viewBox="0 0 16 16"><path d="M3 7V6a2 2 0 012-2h7m0 0l-2-2m2 2l-2 2M13 9v1a2 2 0 01-2 2H4m0 0l2 2m-2-2l2-2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  flag: '<svg class="icon" viewBox="0 0 16 16"><path d="M4 14V2m0 1h8l-2 3 2 3H4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>',
};

export const MARKER_COLORS: Record<MarkerKind, string> = {
  impact: '#ffb347',
  break: '#ff5d73',
  goal: '#34d399',
  event: '#98a5b9',
};

const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4];
const REWIND_RATES = [0.25, 0.5, 1, 2, 4];

const fmtTime = (s: number): string => `${s.toFixed(2)} s`;

function build(app: App, ctx: { active: () => boolean }): PanelView {
  const tt = timeTravelFor(app);

  // ---- transport -------------------------------------------------------------------------------
  const btn = (glyph: string, title: string, onClick: () => void, cls = '') => {
    const b = h('button', { class: `icon-btn tm-btn ${cls}`, type: 'button', title }, svg(glyph));
    b.addEventListener('click', onClick);
    return b;
  };
  const toStart = btn(GLYPH.toStart, 'Go to the start of the recorded run', () => tt.toStart());
  const stepBack = btn(GLYPH.back, 'Step one frame back  (,)', () => tt.stepBack());
  const rewind = btn(GLYPH.rewind, 'Hold to rewind  (hold Backspace)', () => undefined, 'tm-rewind');
  const playBtn = h('button', { class: 'icon-btn tm-btn tm-play', type: 'button', title: 'Play / pause  (Space)' });
  playBtn.addEventListener('click', () => app.sim.toggle());
  const stepFwd = btn(GLYPH.forward, 'Step one frame forward  (.)', () => tt.stepForward());
  const toEnd = btn(GLYPH.toEnd, 'Go to the latest recorded frame', () => tt.toHead());
  rewind.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    rewind.setPointerCapture(e.pointerId);
    tt.rewindStart();
  });
  const endRewind = () => tt.rewindStop();
  rewind.addEventListener('pointerup', endRewind);
  rewind.addEventListener('pointercancel', endRewind);
  rewind.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      tt.rewindStart();
    }
  });
  rewind.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') endRewind();
  });
  const rate = h(
    'select',
    { class: 'tm-select', title: 'Reverse playback speed while rewinding', 'aria-label': 'Rewind speed' },
    ...REWIND_RATES.map((r) => h('option', { value: String(r) }, `${r}× back`)),
  );
  rate.value = String(tt.rewindRate);
  rate.addEventListener('change', () => tt.setRewindRate(Number(rate.value)));
  const speed = segmented({
    compact: true,
    options: SPEEDS.map((v) => ({
      value: String(v),
      label: `${v}×`,
      title: v === 1 ? 'Real time' : v < 1 ? `Slow motion ${v}×` : `Fast forward ${v}×`,
    })),
    value: String(app.prefs.value.timeScale),
    onChange: (v) => app.prefs.set({ timeScale: Number(v) }),
  });
  app.prefs.on('change', (k) => {
    if (k.includes('timeScale')) speed.set(String(app.prefs.value.timeScale));
  });

  const counter = h('div', { class: 'tm-counter', title: 'Frame-accurate step counter and simulated time' });
  const loopBtn = btn(GLYPH.loop, 'Loop the region between A and B  (plays the recorded run again and again)', () =>
    tt.toggleLoop(),
  );
  const setA = h('button', { class: 'tm-chip', type: 'button', title: 'Set loop start A to the current frame' }, 'A');
  const setB = h('button', { class: 'tm-chip', type: 'button', title: 'Set loop end B to the current frame' }, 'B');
  setA.addEventListener('click', () => tt.setLoopPoint('a'));
  setB.addEventListener('click', () => tt.setLoopPoint('b'));
  const clearLoop = h('button', { class: 'tm-chip', type: 'button', title: 'Remove the loop region' }, '×');
  clearLoop.addEventListener('click', () => tt.clearLoop());
  const bookmarkBtn = btn(GLYPH.flag, 'Add a bookmark at this frame  (Ctrl+Shift+B)', () => {
    if (tt.active) tt.addBookmark();
  });

  const transport = h(
    'div',
    { class: 'tm-transport' },
    h('div', { class: 'tm-group' }, toStart, stepBack, rewind, playBtn, stepFwd, toEnd),
    h('div', { class: 'tm-group' }, rate),
    counter,
    h('div', { class: 'tm-group tm-right' }, setA, setB, loopBtn, clearLoop, bookmarkBtn),
  );

  // ---- scrubber ----------------------------------------------------------------------------------
  const canvas = h('canvas', {
    class: 'tm-canvas',
    tabindex: 0,
    role: 'slider',
    'aria-label': 'Simulation timeline',
  });
  const tip = h('div', { class: 'tm-tip', hidden: true });
  const wrap = h('div', { class: 'tm-scrub' }, canvas, tip);
  const info = h('div', { class: 'tm-info' });
  const marks = h('div', { class: 'tm-bookmarks' });
  const empty = h(
    'div',
    { class: 'tm-empty' },
    'Press Simulate (Space) — the run is recorded here, and you can scrub, rewind and replay it.',
  );

  const rangeOf = () => {
    const first = tt.first;
    const head = Math.max(tt.head, first + Math.max(1, Math.round(tt.hz * 0.5)));
    return { first, head };
  };
  const xOf = (step: number, w: number) => {
    const { first, head } = rangeOf();
    return 8 + ((step - first) / (head - first)) * (w - 16);
  };
  const stepAt = (x: number, w: number) => {
    const { first, head } = rangeOf();
    return first + ((x - 8) / (w - 16)) * (head - first);
  };

  let dragging: 'scrub' | 'loop' | null = null;
  let loopAnchor = 0;
  const localX = (e: MouseEvent) => e.clientX - canvas.getBoundingClientRect().left;
  canvas.addEventListener('pointerdown', (e) => {
    if (!tt.active) return;
    canvas.setPointerCapture(e.pointerId);
    const w = canvas.clientWidth;
    if (e.altKey) {
      dragging = 'loop';
      loopAnchor = Math.round(stepAt(localX(e), w));
      tt.loop = { a: loopAnchor, b: loopAnchor };
      return;
    }
    dragging = 'scrub';
    tt.scrubStart();
    tt.scrubTo(stepAt(localX(e), w));
  });
  canvas.addEventListener('pointermove', (e) => {
    const w = canvas.clientWidth;
    if (dragging === 'scrub') tt.scrubTo(stepAt(localX(e), w));
    else if (dragging === 'loop') {
      const s = Math.round(stepAt(localX(e), w));
      tt.loop = { a: Math.min(loopAnchor, s), b: Math.max(loopAnchor, s) };
    }
    showTip(e);
  });
  const endDrag = () => {
    if (dragging === 'scrub') tt.scrubEnd();
    else if (dragging === 'loop' && tt.loop && tt.loop.b - tt.loop.a < 2) tt.clearLoop();
    else if (dragging === 'loop') tt.emit('change', undefined);
    dragging = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => (tip.hidden = true));
  canvas.addEventListener('dblclick', (e) => {
    if (tt.active) tt.addBookmark(undefined, Math.round(stepAt(localX(e), canvas.clientWidth)));
  });
  canvas.addEventListener('keydown', (e) => {
    const k = e.key;
    const big = e.shiftKey ? 10 : 1;
    if (k === 'ArrowLeft') tt.seek(tt.step - big);
    else if (k === 'ArrowRight') tt.seek(tt.step + big);
    else if (k === 'Home') tt.toStart();
    else if (k === 'End') tt.toHead();
    else return;
    e.preventDefault();
  });

  function markerNear(x: number, w: number): Marker | null {
    let best: Marker | null = null;
    let bd = 6;
    for (const m of tt.markers) {
      const d = Math.abs(xOf(m.step, w) - x);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    return best;
  }
  function showTip(e: PointerEvent): void {
    if (!tt.active) return;
    const w = canvas.clientWidth;
    const x = localX(e);
    const step = Math.round(stepAt(x, w));
    const m = markerNear(x, w);
    const bm = tt.bookmarks.find((b) => Math.abs(xOf(b.step, w) - x) < 6);
    tip.hidden = false;
    tip.textContent = `${bm ? bm.name + ' · ' : m ? m.label + ' · ' : ''}step ${step} · ${fmtTime(step / tt.hz)}`;
    tip.style.left = `${Math.min(Math.max(x, 60), w - 60)}px`;
  }

  // ---- drawing ------------------------------------------------------------------------------------
  const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
  function draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (w === 0 || hgt === 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const st = tt.status;
    const mid = Math.round(hgt * 0.55);
    // track
    g.fillStyle = cssVar('--panel-2');
    g.fillRect(8, mid - 5, w - 16, 10);
    if (!tt.active || !st) return;
    const { first, head } = rangeOf();
    const x0 = xOf(first, w);
    const xHead = xOf(Math.max(tt.head, first), w);
    g.fillStyle = 'rgba(61,220,255,0.18)';
    g.fillRect(x0, mid - 5, Math.max(1, xHead - x0), 10);
    // loop region
    if (tt.loop) {
      g.fillStyle = tt.loopOn ? 'rgba(52,211,153,0.28)' : 'rgba(152,165,185,0.22)';
      const xa = xOf(tt.loop.a, w);
      const xb = xOf(tt.loop.b, w);
      g.fillRect(xa, 2, Math.max(2, xb - xa), hgt - 4);
      g.fillStyle = tt.loopOn ? '#34d399' : '#98a5b9';
      g.fillRect(xa, 2, 2, hgt - 4);
      g.fillRect(xb - 1, 2, 2, hgt - 4);
    }
    // time axis labels
    g.fillStyle = cssVar('--text-3');
    g.font = '10px ' + cssVar('--mono');
    g.textBaseline = 'top';
    const total = (head - first) / tt.hz;
    const stepSec = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300].find((s) => (s / total) * (w - 16) > 56) ?? 600;
    for (let s = Math.ceil(first / tt.hz / stepSec) * stepSec; s <= head / tt.hz + 1e-9; s += stepSec) {
      const x = xOf(s * tt.hz, w);
      g.fillRect(x, mid + 6, 1, 5);
      g.fillText(`${+s.toFixed(2)}s`, x + 3, mid + 12);
    }
    // snapshot ticks
    g.fillStyle = 'rgba(152,165,185,0.55)';
    let lastX = -10;
    for (const s of st.snapshots) {
      const x = xOf(s, w);
      if (x - lastX < 3) continue;
      lastX = x;
      g.fillRect(Math.round(x), mid - 9, 1, 4);
    }
    // markers
    for (const m of tt.markers) {
      if (m.step < first || m.step > head) continue;
      const x = xOf(m.step, w);
      g.fillStyle = MARKER_COLORS[m.kind];
      g.beginPath();
      if (m.kind === 'break') {
        g.moveTo(x - 4, 4);
        g.lineTo(x + 4, 12);
        g.moveTo(x + 4, 4);
        g.lineTo(x - 4, 12);
        g.strokeStyle = MARKER_COLORS.break;
        g.lineWidth = 2;
        g.stroke();
      } else if (m.kind === 'goal') {
        g.moveTo(x, 3);
        g.lineTo(x + 6, 7);
        g.lineTo(x, 11);
        g.closePath();
        g.fill();
      } else {
        g.arc(x, 8, m.kind === 'impact' ? 3.5 : 2.5, 0, Math.PI * 2);
        g.fill();
      }
    }
    // bookmarks
    for (const b of tt.bookmarks) {
      const x = xOf(b.step, w);
      g.fillStyle = cssVar('--accent');
      g.fillRect(Math.round(x), mid - 12, 1, 24);
      g.beginPath();
      g.moveTo(x, mid - 12);
      g.lineTo(x + 8, mid - 9);
      g.lineTo(x, mid - 6);
      g.closePath();
      g.fill();
    }
    // playhead
    const px = xOf(tt.step, w);
    g.fillStyle = tt.rewinding ? '#ffb347' : '#ffffff';
    g.fillRect(Math.round(px) - 1, mid - 14, 2, 28);
    g.beginPath();
    g.moveTo(px - 5, mid - 15);
    g.lineTo(px + 5, mid - 15);
    g.lineTo(px, mid - 9);
    g.closePath();
    g.fill();
    canvas.setAttribute('aria-valuemin', String(first));
    canvas.setAttribute('aria-valuemax', String(head));
    canvas.setAttribute('aria-valuenow', String(tt.step));
    canvas.setAttribute('aria-valuetext', `step ${tt.step}, ${fmtTime(tt.step / tt.hz)}`);
  }

  // ---- text ---------------------------------------------------------------------------------------
  function paintText(): void {
    const st = tt.status;
    const active = tt.active;
    el.classList.toggle('idle', !active);
    empty.hidden = active;
    const mode = app.sim.mode;
    playBtn.replaceChildren(
      svg(
        mode === 'running'
          ? '<svg class="icon" viewBox="0 0 16 16"><path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor"/></svg>'
          : '<svg class="icon" viewBox="0 0 16 16"><path d="M4 2.5l9 5.5-9 5.5z" fill="currentColor"/></svg>',
      ),
    );
    playBtn.classList.toggle('on', mode === 'running');
    rewind.classList.toggle('on', tt.rewinding);
    loopBtn.classList.toggle('on', tt.loopOn);
    for (const b of [toStart, stepBack, rewind, stepFwd, toEnd, loopBtn, bookmarkBtn, setA, setB, clearLoop])
      b.disabled = !active;
    counter.replaceChildren(
      ...[
        h('b', null, `Step ${tt.step.toLocaleString()}`),
        h('span', null, active ? ` / ${tt.head.toLocaleString()}` : ''),
        h('span', { class: 'tm-time' }, ` · ${fmtTime(tt.simTime)}`),
        tt.inPast
          ? h(
              'span',
              { class: 'tm-badge past', title: 'The run is in the recorded past. Playing on creates a new branch.' },
              'past',
            )
          : null,
        tt.rewinding ? h('span', { class: 'tm-badge rew' }, 'rewinding') : null,
        tt.replaying ? h('span', { class: 'tm-badge rep' }, 'replay') : null,
        tt.recording ? h('span', { class: 'tm-badge rec' }, '● rec') : null,
      ].filter((n): n is HTMLElement => n !== null),
    );
    info.textContent = st
      ? `${st.snapshots.length} snapshots · every ${st.interval} steps · ${(st.bytes / 1048576).toFixed(1)} of ${Math.round(st.budgetBytes / 1048576)} MB · ${tt.markers.length} events`
      : '';
    // bookmarks
    const sig = tt.bookmarks.map((b) => `${b.id}:${b.step}:${b.name}`).join('|');
    if (sig !== bookmarkSig) {
      bookmarkSig = sig;
      marks.replaceChildren(
        ...tt.bookmarks.map((b) => {
          const chip = h(
            'span',
            { class: 'tm-bm', title: `${b.name} — step ${b.step}. Click to jump, double-click to rename.` },
            h('span', { class: 'tm-bm-name' }, b.name),
            h('span', { class: 'tm-bm-t' }, fmtTime(b.step / tt.hz)),
          );
          const del = iconButton('close', 'Remove the bookmark', () => tt.removeBookmark(b.id), 'tm-bm-x');
          chip.addEventListener('click', () => tt.jumpToBookmark(b.id));
          chip.addEventListener('dblclick', (e) => {
            e.preventDefault();
            void promptText('Rename bookmark', 'Name', b.name, 'Rename').then(
              (n) => n !== null && tt.renameBookmark(b.id, n),
            );
          });
          chip.append(del);
          del.addEventListener('click', (e) => e.stopPropagation());
          return chip;
        }),
      );
    }
  }
  let bookmarkSig = '';

  const el = h('div', { class: 'tm-panel' }, transport, wrap, h('div', { class: 'tm-foot' }, marks, info), empty);

  let dirty = true;
  tt.on('change', () => (dirty = true));
  app.sim.on('mode', () => (dirty = true));
  const off = app.on('frame', () => {
    if (!ctx.active()) return;
    if (dirty || tt.active) {
      paintText();
      draw();
      dirty = false;
    }
  });

  return {
    el,
    toolbar: [speed.el],
    onShow: () => {
      dirty = true;
      requestAnimationFrame(() => {
        paintText();
        draw();
      });
    },
    dispose: off,
  };
}

export const timelinePanel: PanelDef = {
  id: 'timeline',
  label: 'Timeline',
  icon: 'stopwatch',
  region: 'bottom',
  order: 5,
  title: 'Scrub, rewind and step through the recorded run',
  build,
};
