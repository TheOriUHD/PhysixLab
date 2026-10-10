/**
 * The Ghosts tab of the bottom dock (TM-5): stored runs, which of them is drawn as a translucent ghost over the live
 * run (A and B), the personal best, and the distance-between-runs chart.
 */
import type { App } from '../../app/app';
import type { PanelDef, PanelView } from '../../app/registry/panels';
import { timeTravelFor } from '../../app/timeTravel';
import { button, toggleField } from '../controls';
import { h } from '../dom';
import { emptyState } from '../emptyState'; // -- UI-B: empty states --

const COLORS = { a: '#3ddcff', b: '#ffb347' };

function build(app: App, ctx: { active: () => boolean }): PanelView {
  const tt = timeTravelFor(app);
  const gh = tt.ghosts;

  const list = h('div', { class: 'tm-runs' });
  const canvas = h('canvas', { class: 'tm-chart', 'aria-label': 'Distance between the two runs over time' });
  const summary = h('div', { class: 'tm-status' });
  const show = toggleField({ value: gh.show, onChange: (v) => gh.setShow(v) });
  const auto = toggleField({ value: tt.options.autoGhost, onChange: (v) => tt.setOptions({ autoGhost: v }) });
  const live = button('Compare with this run', () => gh.compareWithLive(), {
    title: 'Fetch the run in progress and compare it with ghost A',
  });
  const clear = button('Clear runs', () => gh.clearRuns(), {
    title: 'Forget the stored runs (the personal best stays)',
  });

  const el = h(
    'div',
    { class: 'tm-ghosts' },
    h(
      'div',
      { class: 'tm-col' },
      h('div', { class: 'tm-h' }, 'Runs'),
      list,
      h(
        'div',
        { class: 'tm-actions' },
        h('label', { class: 'tm-inline' }, show.el, 'Show ghosts'),
        h(
          'label',
          { class: 'tm-inline', title: 'Use the previous run as ghost A automatically' },
          auto.el,
          'Previous run',
        ),
        live,
        clear,
      ),
    ),
    h('div', { class: 'tm-col tm-grow' }, h('div', { class: 'tm-h' }, 'Distance between A and B'), summary, canvas),
  );

  function paintList(): void {
    list.replaceChildren();
    if (!gh.runs.length) {
      list.append(
        emptyState({
          art: 'recent',
          title: 'No runs yet',
          hint: 'Run the scene, reset it, and run it again: the first run appears here as a ghost.',
          class: 'compact',
        }),
      );
      return;
    }
    for (const r of gh.runs) {
      const slot = (s: 'a' | 'b') => {
        const on = (s === 'a' ? gh.a : gh.b) === r.key;
        const b = h(
          'button',
          {
            class: `tm-slot ${on ? 'on' : ''}`,
            type: 'button',
            style: on ? { background: COLORS[s], color: '#0b0e14' } : {},
            title: `Show as ghost ${s.toUpperCase()}`,
            'aria-pressed': on,
          },
          s.toUpperCase(),
        );
        b.addEventListener('click', () => gh.pick(s, on ? null : r.key));
        return b;
      };
      const best = h(
        'button',
        {
          class: 'tm-chip',
          type: 'button',
          title: 'Keep as this scene’s personal best ghost',
          disabled: r.origin === 'best',
        },
        '★',
      );
      best.addEventListener('click', () => gh.makeBest(r.key));
      list.append(
        h(
          'div',
          { class: 'tm-run' },
          slot('a'),
          slot('b'),
          h('span', { class: 'tm-run-name' }, r.name),
          h('span', { class: 'tm-run-d' }, `${r.track.duration.toFixed(1)} s · ${r.track.ids.length} bodies`),
          r.time !== undefined ? h('span', { class: 'tm-run-d' }, `${r.time.toFixed(2)} s`) : null,
          best,
        ),
      );
    }
  }

  function drawChart(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hh = canvas.clientHeight;
    if (!w || !hh) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hh * dpr);
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    const c = gh.comparison;
    if (!c) {
      summary.textContent = gh.awaitingLive
        ? 'Fetching the current run…'
        : 'Pick a run as A and another as B to see how far apart they drift.';
      return;
    }
    summary.textContent = `${c.shared} shared bodies · largest gap ${c.peak.distance.toFixed(2)} m at ${c.peak.t.toFixed(2)} s`;
    const padL = 36;
    const padB = 16;
    const plotW = w - padL - 8;
    const plotH = hh - padB - 6;
    const ymax = Math.max(1e-6, c.peak.distance) * 1.1;
    const X = (i: number) => padL + (c.t[i] / c.t[c.t.length - 1]) * plotW;
    const Y = (v: number) => 4 + plotH - (v / ymax) * plotH;
    const css = getComputedStyle(document.documentElement);
    g.strokeStyle = css.getPropertyValue('--border-2').trim() || '#2c3547';
    g.fillStyle = css.getPropertyValue('--text-3').trim() || '#627086';
    g.font = `10px ${css.getPropertyValue('--mono').trim() || 'monospace'}`;
    g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = (ymax * k) / 4;
      g.beginPath();
      g.moveTo(padL, Y(v));
      g.lineTo(w - 8, Y(v));
      g.stroke();
      g.fillText(v.toFixed(v < 1 ? 2 : 1), 2, Y(v) + 3);
    }
    g.fillText(`${c.t[c.t.length - 1].toFixed(1)} s`, w - 44, hh - 3);
    g.fillText('0', padL, hh - 3);
    const line = (vals: number[], color: string, width: number) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      vals.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
      g.stroke();
    };
    line(c.mean, '#3ddcff', 2);
    line(c.max, '#ffb347', 1.5);
    g.fillStyle = '#3ddcff';
    g.fillText('mean', padL + 6, 12);
    g.fillStyle = '#ffb347';
    g.fillText('largest', padL + 40, 12);
  }

  let dirty = true;
  gh.on('change', () => (dirty = true));
  tt.on('change', () => (dirty = true));
  const off = app.on('frame', () => {
    if (dirty && ctx.active()) {
      paintList();
      drawChart();
      dirty = false;
    }
  });
  return {
    el,
    onShow: () => {
      paintList();
      requestAnimationFrame(drawChart);
    },
    dispose: off,
  };
}

export const ghostsPanel: PanelDef = {
  id: 'ghosts',
  label: 'Ghosts',
  icon: 'eye',
  region: 'bottom',
  order: 7,
  title: 'Ghosts of earlier runs, the personal best, and A/B comparison',
  build,
};
