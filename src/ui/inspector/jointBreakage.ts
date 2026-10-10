/** JT-11: the "Breakage" inspector section — thresholds, presets, fatigue and the live load readout. */
import { defaultBreakage, presetBreakage, transmitsTorque, type BreakPreset } from '../../model/breakage';
import { massEstimate } from '../../model/compound';
import type { BreakSpec } from '../../model/types';
import { fmt, numberField, row, section, toggleField } from '../controls';
import { h } from '../dom';
import type { InspectorContext } from './shared';

export function breakageSection(ctx: InspectorContext, id: string): HTMLElement {
  const { app } = ctx;
  const get = () => app.store.joint(id)!;
  const type = get().type;
  const torque = transmitsTorque(type);
  const spec = (): BreakSpec => get().breakage ?? defaultBreakage();
  const set = (label: string, p: Partial<BreakSpec>) => app.store.update(id, { breakage: { ...spec(), ...p } }, label);
  const setFatigue = (label: string, p: Partial<BreakSpec['fatigue']>) =>
    set(label, { fatigue: { ...spec().fatigue, ...p } });

  const on = toggleField({
    label: 'Breaks under load',
    title: 'The joint fails when the force or torque it transmits exceeds its threshold',
    onChange: (v) =>
      app.store.update(
        id,
        { breakage: v ? presetBreakage('normal', carriedMass(), 0.5) : undefined },
        'Toggle joint breakage',
      ),
  });
  function carriedMass(): number {
    const j = get();
    let m = 0;
    for (const bid of [j.bodyA, j.bodyB]) {
      const b = bid ? app.store.body(bid) : null;
      if (b && b.bodyType === 'dynamic') m += massEstimate(b);
    }
    return m > 0 ? m : 1;
  }
  const force = numberField({
    step: 50,
    min: 0,
    unit: 'N',
    digits: 0,
    ...ctx.grouped('Edit break force'),
    onChange: (v) => set('Edit break force', { force: v }),
  });
  const tq = numberField({
    step: 20,
    min: 0,
    unit: 'N·m',
    digits: 0,
    ...ctx.grouped('Edit break torque'),
    onChange: (v) => set('Edit break torque', { torque: v }),
  });
  const presets = h('div', { class: 'chips' });
  for (const [p, label, title] of [
    ['fragile', 'Fragile', '3× the weight of the connected bodies'],
    ['normal', 'Normal', '10× the weight of the connected bodies'],
    ['tough', 'Tough', '40× the weight of the connected bodies'],
  ] as [BreakPreset, string, string][]) {
    const b = h('button', { class: 'chip', type: 'button', title: `${label}: ${title}` }, label);
    b.addEventListener('click', () => {
      const s = spec();
      const next = presetBreakage(p, carriedMass(), 0.5);
      app.store.update(id, { breakage: { ...next, fatigue: s.fatigue } }, `${label} joint`);
    });
    presets.appendChild(b);
  }
  const fat = toggleField({
    label: 'Fatigue (cumulative overload)',
    title:
      'Stress above the start level accumulates damage instead of the joint surviving until the instant it passes its threshold',
    onChange: (v) => setFatigue('Toggle fatigue', { enabled: v }),
  });
  const start = numberField({
    step: 5,
    min: 0,
    max: 99,
    unit: '%',
    digits: 0,
    ...ctx.grouped('Edit fatigue'),
    onChange: (v) => setFatigue('Edit fatigue', { start: Math.min(0.99, Math.max(0, v / 100)) }),
  });
  const life = numberField({
    step: 0.5,
    min: 0.01,
    unit: 's',
    digits: 2,
    ...ctx.grouped('Edit fatigue'),
    onChange: (v) => setFatigue('Edit fatigue', { life: Math.max(0.01, v) }),
  });
  const body = h('div', { class: 'stack-col' });
  const rows: HTMLElement[] = [
    row('Presets', presets, 'Thresholds scaled to the weight of the connected bodies'),
    row('Break force', force.el, 'Newtons. 0 = never breaks from force'),
  ];
  if (torque) rows.push(row('Break torque', tq.el, 'N·m. 0 = never breaks from torque'));
  rows.push(
    fat.el,
    row('Starts at', start.el, 'Load level (of the threshold) above which damage accumulates'),
    row(
      'Lifetime',
      life.el,
      'Seconds the joint lasts when held exactly at its threshold; heavier overloads are faster',
    ),
  );
  body.append(...rows);

  // live readout
  const live = h('dl', { class: 'readout' });
  const cells: Record<string, HTMLElement> = {};
  const lines: [string, string][] = [
    ['load', 'Load'],
    ['ratio', 'Of threshold'],
    ...(torque ? ([['torque', 'Torque']] as [string, string][]) : []),
    ['damage', 'Fatigue damage'],
  ];
  for (const [k, label] of lines) {
    cells[k] = h('dd', null, '—');
    live.append(h('dt', null, label), cells[k]);
  }
  ctx.live.push(() => {
    const s = app.liveJoint(id);
    if (!s) return;
    if (s.broken) {
      for (const k of Object.keys(cells)) cells[k].textContent = 'broken';
      return;
    }
    const br = get().breakage;
    cells.load.textContent = `${fmt(s.load, 1)} N${s.exact ? '' : ' (shared-load estimate)'}`;
    cells.ratio.textContent = br && s.ratio > 0 ? `${fmt(s.ratio * 100, 0)} %` : '—';
    if (cells.torque) cells.torque.textContent = `${fmt(s.torque, 1)} N·m`;
    cells.damage.textContent = br?.fatigue.enabled ? `${fmt(s.damage * 100, 0)} %` : '—';
  });
  ctx.updaters.push(() => {
    const b = get().breakage;
    on.set(!!b);
    body.style.display = b ? '' : 'none';
    if (b) {
      force.set(b.force);
      tq.set(b.torque);
      fat.set(b.fatigue.enabled);
      start.set(b.fatigue.start * 100);
      life.set(b.fatigue.life);
    }
    live.style.display = app.sim.active ? '' : 'none';
  });
  // asking for load estimates while this inspector shows a running simulation
  ctx.live.push(() => {
    app.loadWatchStamp = performance.now();
  });
  return section(
    'Breakage',
    [
      on.el,
      body,
      live,
      h(
        'p',
        { class: 'hint-text' },
        'The load is estimated from momentum balance on the part of the structure beyond the joint (exact for a joint that is a bridge of the joint graph; a shared-load estimate when it sits in a loop). Broken joints are removed from the running world; Reset restores them.',
      ),
    ],
    { id: 'joint-breakage', open: false },
  );
}
