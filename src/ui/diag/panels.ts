/**
 * The Diagnostics and Profiler panels (UI-43), in the bottom dock: wide and short is what a table of facts and a
 * rolling graph want. Both only do work while they are the visible tab: the profiler's numbers are collected all
 * the time by `src/core/profiler.ts` (a few `performance.now()` calls per frame), the graph is only drawn when seen.
 */
import type { App } from '../../app/app';
import type { PanelDef } from '../../app/registry/panels';
import { SECTIONS, SECTION_COUNT, profiler } from '../../core/profiler';
import { h } from '../dom';
import { emptyState } from '../emptyState';
import { collectReport, workerInfo } from './collect';
import { copyDiagnosticsButton } from './errorCard';
import { errorLog } from './boot';
import { diagSections } from './report';

const visible = (el: HTMLElement): boolean => el.isConnected && el.getClientRects().length > 0;

// ── Diagnostics ────────────────────────────────────────────────────────────────────────────────

export const diagnosticsPanel: PanelDef = {
  id: 'diagnostics',
  label: 'Diagnostics',
  icon: 'settings',
  region: 'bottom',
  order: 80,
  title: 'Device, browser, graphics card, limits, physics worker status and timings',
  build: (app, ctx) => {
    const body = h('div', { class: 'diag-cols' });
    const el = h('div', { class: 'diag-panel' }, body);
    let last = '';
    const render = () => {
      const report = collectReport(app, errorLog);
      // Re-render only when something visible changed (the report carries a timestamp that always differs).
      const sections = diagSections(report);
      const key = JSON.stringify(sections);
      if (key === last) return;
      last = key;
      body.replaceChildren(
        ...sections.map((s) =>
          h(
            'section',
            { class: 'diag-sec' },
            h('h5', null, s.title),
            h(
              'dl',
              null,
              ...s.rows.flatMap((r) => [h('dt', null, r.label), h('dd', { class: r.tone ?? '' }, r.value)]),
            ),
          ),
        ),
      );
      if (errorLog.recent().length) {
        const errs = errorLog.recent(5).reverse();
        body.appendChild(
          h(
            'section',
            { class: 'diag-sec' },
            h('h5', null, 'Recent errors'),
            h(
              'dl',
              null,
              ...errs.flatMap((e) => [
                h('dt', null, `${(e.t / 1000).toFixed(1)} s ${e.kind}`),
                h(
                  'dd',
                  { class: 'bad' },
                  e.message.slice(0, 160) + (e.count && e.count > 1 ? ' (×' + e.count + ')' : ''),
                ),
              ]),
            ),
          ),
        );
      } else
        body.appendChild(
          h(
            'section',
            { class: 'diag-sec' },
            h('h5', null, 'Recent errors'),
            emptyState({ art: 'search', title: 'No errors so far', class: 'compact' }),
          ),
        );
    };
    let lastRun = 0;
    app.on('frame', () => {
      if (!ctx.active() || !visible(el)) return;
      const now = performance.now();
      if (now - lastRun < 500) return;
      lastRun = now;
      render();
    });
    return {
      el,
      toolbar: [copyDiagnosticsButton(() => collectReport(app, errorLog))],
      onShow: () => {
        last = '';
        render();
      },
    };
  },
};

// ── Profiler ───────────────────────────────────────────────────────────────────────────────────

const ms = (v: number): string => (v > 0 ? v.toFixed(v < 10 ? 2 : 1) : '0');

export const profilerPanel: PanelDef = {
  id: 'profiler',
  label: 'Profiler',
  icon: 'wave',
  region: 'bottom',
  order: 90,
  title: 'Where each frame’s time goes: physics, scene update, UI, render',
  build: (app: App, ctx) => {
    const canvas = h('canvas', { class: 'prof-graph', 'aria-label': 'Frame time graph' });
    const cells: { avg: HTMLElement; max: HTMLElement; last: HTMLElement }[] = [];
    const rows = SECTIONS.map((s) => {
      const c = { avg: h('td', null, '—'), max: h('td', null, '—'), last: h('td', null, '—') };
      cells.push(c);
      return h(
        'tr',
        { title: s.hint },
        h('td', null, h('span', { class: 'prof-sw', style: { background: s.color } }), s.label),
        c.avg,
        c.max,
        c.last,
      );
    });
    const frameCells = { avg: h('td', null, '—'), max: h('td', null, '—'), last: h('td', null, '—') };
    const worker = {
      step: h('td', null, '—'),
      trip: h('td', null, '—'),
      apply: h('td', null, '—'),
    };
    const table = h(
      'table',
      { class: 'prof-table' },
      h(
        'thead',
        null,
        h('tr', null, h('th', null, 'ms per frame'), h('th', null, 'avg'), h('th', null, 'max'), h('th', null, 'now')),
      ),
      h(
        'tbody',
        null,
        ...rows,
        h(
          'tr',
          { title: 'Time between two frames' },
          h('td', null, 'Frame interval'),
          frameCells.avg,
          frameCells.max,
          frameCells.last,
        ),
      ),
    );
    const workerTable = h(
      'table',
      { class: 'prof-table' },
      h('thead', null, h('tr', null, h('th', null, 'Physics worker (other thread)'), h('th', null, 'ms'))),
      h(
        'tbody',
        null,
        h(
          'tr',
          { title: 'Average time of one fixed physics step, measured inside the worker' },
          h('td', null, 'Step'),
          worker.step,
        ),
        h(
          'tr',
          { title: 'Time from sending a tick until its frame arrived (includes the step)' },
          h('td', null, 'Round trip'),
          worker.trip,
        ),
        h('tr', { title: 'Main-thread time spent unpacking the latest frame' }, h('td', null, 'Unpack'), worker.apply),
      ),
    );
    const note = h(
      'p',
      { class: 'prof-note' },
      'Times are main-thread CPU time. Render is the time spent issuing draw calls: the GPU works asynchronously and is not measured. The physics step runs on the worker thread, in parallel, so it is listed separately.',
    );
    const el = h(
      'div',
      { class: 'prof-panel' },
      h('div', { class: 'prof-top' }, canvas, table, workerTable),
      note,
    );

    // ── the stacked graph: preallocated, no allocation while drawing ──
    const g = canvas.getContext('2d');
    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const d = window.devicePixelRatio || 1;
      if (Math.abs(r.width - cssW) > 0.5 || Math.abs(r.height - cssH) > 0.5 || d !== dpr) {
        cssW = r.width;
        cssH = r.height;
        dpr = d;
        canvas.width = Math.max(1, Math.round(cssW * dpr));
        canvas.height = Math.max(1, Math.round(cssH * dpr));
      }
    };
    let scale = 33.4; // ms at the top of the graph; eases up quickly and down slowly
    const draw = () => {
      if (!g) return;
      fit();
      const W = canvas.width;
      const H = canvas.height;
      g.clearRect(0, 0, W, H);
      const n = profiler.count;
      if (!n) return;
      const colW = Math.max(1, Math.round(2 * dpr));
      const cols = Math.min(n, Math.floor(W / colW));
      let top = 0;
      for (let i = 0; i < cols; i++) {
        const idx = profiler.indexOfRecent(i);
        let tot = 0;
        for (let s = 0; s < SECTION_COUNT; s++) tot += profiler.rings[s][idx];
        if (tot > top) top = tot;
      }
      const target = Math.max(16.7, Math.min(250, top * 1.15));
      scale = target > scale ? target : scale + (target - scale) * 0.05;
      const k = (H - 2) / scale;
      for (let i = 0; i < cols; i++) {
        const idx = profiler.indexOfRecent(i);
        const x = W - (i + 1) * colW;
        let y = H;
        for (let s = 0; s < SECTION_COUNT; s++) {
          const hgt = profiler.rings[s][idx] * k;
          if (hgt <= 0) continue;
          g.fillStyle = SECTIONS[s].color;
          g.fillRect(x, y - hgt, colW, hgt);
          y -= hgt;
        }
      }
      // guide lines at the 60 fps and 30 fps budgets
      g.fillStyle = 'rgba(219,227,239,0.35)';
      g.font = `${10 * dpr}px system-ui`;
      for (const budget of [16.7, 33.3]) {
        if (budget > scale) continue;
        const y = H - budget * k;
        g.fillRect(0, y, W, Math.max(1, dpr * 0.5));
        g.fillText(budget < 20 ? '16.7 ms (60 fps)' : '33.3 ms (30 fps)', 4 * dpr, y - 3 * dpr);
      }
    };

    const fill = () => {
      for (const s of SECTIONS) {
        const st = profiler.stats(s.id, 120);
        const c = cells[s.id];
        c.avg.textContent = ms(st.avg);
        c.max.textContent = ms(st.max);
        c.last.textContent = ms(st.last);
      }
      const iv = profiler.intervalStats(120);
      frameCells.avg.textContent = ms(iv.avg);
      frameCells.max.textContent = ms(iv.max);
      frameCells.last.textContent = ms(iv.last);
      const w = workerInfo(app);
      worker.step.textContent = w.active && w.stepMs > 0 ? ms(w.stepMs) : '—';
      worker.trip.textContent = w.active && w.roundTripMs > 0 ? ms(w.roundTripMs) : '—';
      worker.apply.textContent = w.active && w.applyMs > 0 ? ms(w.applyMs) : '—';
    };

    let lastDraw = 0;
    let lastFill = 0;
    app.on('frame', () => {
      if (!ctx.active() || !visible(el)) return;
      const now = performance.now();
      if (now - lastDraw >= 50) {
        lastDraw = now;
        draw();
      }
      if (now - lastFill >= 250) {
        lastFill = now;
        fill();
      }
    });
    return {
      el,
      toolbar: [
        h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            title: 'Forget the recorded frames and start again',
            onclick: () => profiler.reset(),
          },
          'Clear',
        ),
      ],
      onShow: () => {
        fill();
        requestAnimationFrame(draw);
      },
    };
  },
};
