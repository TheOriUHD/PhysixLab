/**
 * Package SF — the soft-body inspector sections beyond the basics: mesh / tyre options, pressure and puncture,
 * material (stiffness ↔ Young's modulus, Poisson, permanent set), contact, fastenings to rigid bodies, stability
 * warnings with one-click fixes, and the particle budget with economy mode and the live elastic energy.
 *
 * `softInspector` in `soft.ts` calls `softSfSections`; every control edits the document through `ctx.edit` (one
 * undo step per scrub) and works on a multi-selection, like the sections around it.
 */
import { makeShapeSpec } from '../../model/shapeRegistry';
import { softParticleRadius } from '../../model/shapes';
import { softBudget, softParticleCount, softWarnings, suggestResolution } from '../../model/softBudget';
import { formatPascal, softYoungModulus } from '../../model/softMaterial';
import { massEstimate } from '../../model/compound';
import type { SoftAttachment, SoftEntity } from '../../model/types';
import { isSoft } from '../../model/types';
import { button, fmt, numberField, row, rowStack, section, selectField, sliderField, toggleField } from '../controls';
import { h } from '../dom';
import { icon } from '../icons';
import {
  loadCarried,
  meshShapeOptions,
  particleCaption,
  pascalToKPa,
  stiffnessForKPa,
  warningSignature,
  workingPressureHint,
} from './softSfHelpers';
import type { InspectorContext } from './shared';

/** Rows the base soft inspector already built; the material section hosts them so nothing is duplicated. */
export interface SoftMaterialRows {
  stiffness: HTMLElement;
  damping: HTMLElement;
  tearToggle: HTMLElement;
  tearRow: HTMLElement;
}

export interface SoftSfSections {
  /** Shown near the top; empty when the selection is stable. */
  stability: HTMLElement[];
  /** The remaining sections, in display order. */
  main: HTMLElement[];
}

const SHELL_TYPES = new Set(['balloon', 'tyre', 'jelly', 'mesh']);

export function softSfSections(ctx: InspectorContext, sel: SoftEntity[], base: SoftMaterialRows): SoftSfSections {
  const { app } = ctx;
  const ids = sel.map((e) => e.id);
  const multi = sel.length > 1;
  const cur = (): SoftEntity[] => ids.map((id) => app.store.soft(id)).filter((e): e is SoftEntity => !!e);
  const first = (): SoftEntity => cur()[0];
  const same = <T>(get: (e: SoftEntity) => T) => {
    const l = cur();
    return !l.some((e) => JSON.stringify(get(e)) !== JSON.stringify(get(l[0])));
  };
  const type = sel[0].type;
  const allSameType = sel.every((e) => e.type === type);
  const edit = (label: string, fn: (e: SoftEntity) => Partial<SoftEntity>, only: string[] = ids) =>
    ctx.edit<SoftEntity>(only, label, fn);
  const gravity = (): number => Math.hypot(...app.store.settings.gravity);
  const main: HTMLElement[] = [];

  // ---- (a) type-specific: mesh / tyre -------------------------------------------------------
  if (allSameType && type === 'mesh') {
    const opts = meshShapeOptions();
    const pick = selectField<string>({
      options: opts.map((o) => ({ value: o.id, label: o.label })),
      onChange: (id) => edit('Mesh shape', () => ({ shape: makeShapeSpec(id) })),
    });
    const ic = h('span', { class: 'sf-shape-icon' });
    const cell = sliderField({
      min: 0.04,
      max: 0.5,
      step: 0.01,
      digits: 2,
      unit: 'm',
      ...ctx.grouped('Cell size'),
      onChange: (v) => edit('Cell size', () => ({ cell: v })),
    });
    const caption = h('div', { class: 'sf-caption' });
    ctx.updaters.push(() => {
      const e = first();
      pick.set(e.shape.type, multi && !same((x) => x.shape.type));
      const o = opts.find((x) => x.id === e.shape.type);
      ic.replaceChildren(o ? icon(o.icon) : '');
      ic.title = o?.label ?? '';
      cell.set(e.cell, multi && !same((x) => x.cell));
      const n = cur().reduce((a, x) => a + softParticleCount(x), 0);
      caption.textContent = particleCaption(n);
      caption.classList.toggle('sf-warn-text', n > 1200);
    });
    main.push(
      section(
        'Mesh source',
        [
          row(
            'Source shape',
            [ic, pick.el],
            'The shape this jelly is filled from. Convex shapes use their hull; spheres, cylinders, capsules and cones are sampled densely. The body takes its size from the Transform section.',
          ),
          row(
            'Cell size',
            cell.el,
            'Spacing of the particle lattice. Smaller cells follow the shape better but cost many more particles (cubically).',
          ),
          caption,
        ],
        { id: 'soft-mesh' },
      ),
    );
  }
  if (allSameType && type === 'tyre') {
    const pneu = toggleField({
      label: 'Pneumatic (air-filled)',
      title:
        'On: a pressurised rubber shell. Off: an airless tyre, a solid lattice that carries load by stiffness alone.',
      onChange: (v) =>
        edit('Pneumatic tyre', (e) => ({
          pneumatic: v,
          volumePreserve: v ? true : e.volumePreserve,
          // A shell needs stiff rubber and some pressure to carry a vehicle.
          ...(v && e.stiffness < 300 ? { stiffness: 400 } : {}),
          ...(v && e.volumeFactor < 1.15 ? { volumeFactor: 1.3 } : {}),
        })),
    });
    const hint = h('p', { class: 'hint-text sf-hint' });
    ctx.updaters.push(() => {
      const e = first();
      pneu.set(e.pneumatic, multi && !same((x) => x.pneumatic));
      const ph = workingPressureHint(e);
      hint.textContent = ph.text;
      hint.classList.toggle('sf-warn-text', !ph.ok);
    });
    main.push(section('Tyre', [pneu.el, hint], { id: 'soft-tyre' }));
  }

  // ---- (b) pressure ------------------------------------------------------------------------
  if (sel.every((e) => SHELL_TYPES.has(e.type))) {
    const press = sliderField({
      min: 0.5,
      max: 2,
      step: 0.01,
      digits: 2,
      unit: '×',
      ...ctx.grouped('Pressure'),
      onChange: (v) => edit('Pressure', () => ({ volumeFactor: v })),
    });
    const keep = toggleField({
      label: 'Keep volume',
      title: 'Preserve the enclosed volume: the body resists being squashed flat and pushes back like trapped air.',
      onChange: (v) => edit('Preserve volume', () => ({ volumePreserve: v })),
    });
    const leak = sliderField({
      min: 0,
      max: 3,
      step: 0.01,
      digits: 2,
      unit: '1/s',
      ...ctx.grouped('Leak rate'),
      onChange: (v) => edit('Leak rate', () => ({ leakRate: v })),
    });
    const puncture = button('Puncture', () => edit('Puncture', () => ({ leakRate: 1.5 })), {
      cls: 'small',
      title:
        'Open a leak (rate 1.5 per second): the target volume decays and the body deflates. While the simulation runs this rebuilds the soft body, which resets its deformation.',
    });
    const seal = button('Seal', () => edit('Seal', () => ({ leakRate: 0 })), {
      cls: 'small',
      title: 'Close the leak (rate 0). Re-inflate with the pressure slider.',
    });
    const status = h('div', { class: 'sf-caption' });
    ctx.updaters.push(() => {
      const e = first();
      press.set(e.volumeFactor, multi && !same((x) => x.volumeFactor));
      keep.set(e.volumePreserve, multi && !same((x) => x.volumePreserve));
      leak.set(e.leakRate, multi && !same((x) => x.leakRate));
      const leaking = cur().some((x) => x.leakRate > 0 && x.volumePreserve);
      status.textContent = leaking ? 'Leaking: the target volume decays towards a flat shell.' : 'Airtight.';
      puncture.disabled = cur().every((x) => x.leakRate >= 1.5);
      seal.disabled = cur().every((x) => x.leakRate === 0);
    });
    main.push(
      section(
        'Pressure',
        [
          rowStack(
            'Pressure (target volume ×)',
            press.el,
            'Target enclosed volume relative to the rest volume. Above 1 inflates, below 1 deflates; a tyre carries a vehicle at about ×1.15 – ×1.6.',
          ),
          keep.el,
          row(
            'Leak rate',
            leak.el,
            'Air escaping through a puncture: the target volume decays at this rate (1/s). 0 = airtight.',
          ),
          h('div', { class: 'sf-actions' }, puncture, seal),
          status,
        ],
        { id: 'soft-pressure' },
      ),
    );
  }

  // ---- (c) material ------------------------------------------------------------------------
  {
    const young = numberField({
      step: 0.5,
      min: 0.001,
      digits: 3,
      unit: 'kPa',
      title: "Effective Young's modulus. Type a value to set the stiffness that gives it.",
      ...ctx.grouped("Young's modulus"),
      onChange: (kPa) => edit("Young's modulus", (e) => ({ stiffness: stiffnessForKPa(e, kPa) })),
    });
    const youngNote = h('span', { class: 'sf-caption sf-inline' });
    const poisson = sliderField({
      min: 0,
      max: 0.49,
      step: 0.01,
      digits: 2,
      ...ctx.grouped('Poisson ratio'),
      onChange: (v) => edit('Poisson ratio', () => ({ poisson: v })),
    });
    const plastic = sliderField({
      min: 0,
      max: 1,
      step: 0.01,
      digits: 2,
      ...ctx.grouped('Permanent set'),
      onChange: (v) => edit('Permanent set', () => ({ plasticYield: v })),
    });
    ctx.updaters.push(() => {
      const e = first();
      const mixed = multi && !same((x) => Math.round(softYoungModulus(x)));
      young.set(pascalToKPa(softYoungModulus(e)), mixed);
      youngNote.textContent = mixed ? '' : `≈ ${formatPascal(softYoungModulus(e))}`;
      poisson.set(e.poisson, multi && !same((x) => x.poisson));
      plastic.set(e.plasticYield, multi && !same((x) => x.plasticYield));
    });
    main.push(
      section(
        'Material',
        [
          base.stiffness,
          rowStack(
            "Young's modulus ≈",
            [young.el, youngNote],
            'Effective modulus of the particle lattice, derived from the stiffness frequency f: E ≈ ρ·(ω·h)²/2 with ω = 2πf, ρ the mean density and h the particle spacing. It depends on the resolution (a coarser lattice at the same frequency is stiffer per metre) and is an honest effective value, not a measured material property. Typing a value sets the stiffness that gives it.',
          ),
          row(
            'Poisson ratio',
            poisson.el,
            'How much the material bulges sideways when squeezed: 0 = not at all (cork-like), 0.49 = nearly incompressible (rubber).',
          ),
          base.damping,
          base.tearToggle,
          base.tearRow,
          row(
            'Permanent set',
            plastic.el,
            'Strain beyond which the material stays deformed instead of springing back (clay, dough, bent metal). 0 = purely elastic. Takes effect where the engine supports it for this body.',
          ),
        ],
        { id: 'soft-material' },
      ),
    );
  }

  // ---- (d) contact -------------------------------------------------------------------------
  {
    const fr = sliderField({
      min: 0,
      max: 3,
      step: 0.01,
      digits: 2,
      ...ctx.grouped('Surface friction'),
      onChange: (v) => edit('Surface friction', () => ({ friction: v })),
    });
    const rad = numberField({
      step: 0.005,
      min: 0,
      digits: 3,
      unit: 'm',
      title: '0 = automatic',
      ...ctx.grouped('Particle radius'),
      onChange: (v) => edit('Particle radius', () => ({ particleRadius: v })),
    });
    const auto = h('div', { class: 'sf-caption' });
    ctx.updaters.push(() => {
      const e = first();
      fr.set(e.friction, multi && !same((x) => x.friction));
      rad.set(e.particleRadius, multi && !same((x) => x.particleRadius));
      const a = softParticleRadius({ ...e, particleRadius: 0 });
      auto.textContent =
        e.particleRadius > 0
          ? `Override in use. Automatic would be ${fmt(a * 1000, 1)} mm.`
          : `Automatic: ${fmt(a * 1000, 1)} mm.`;
    });
    main.push(
      section(
        'Contact',
        [
          row(
            'Surface friction',
            fr.el,
            'Friction of the particle skin against rigid bodies and the ground. Tyres want 1+, jelly on ice wants little.',
          ),
          row(
            'Particle radius',
            rad.el,
            'Collision radius of each particle, which is also how far the surface hovers above what it rests on. 0 = automatic from the lattice spacing; larger values stop thin objects slipping through.',
          ),
          auto,
        ],
        { id: 'soft-contact' },
      ),
    );
  }

  // ---- (e) fastenings ----------------------------------------------------------------------
  if (!multi) main.push(fastenings(ctx, ids[0], gravity));

  // ---- (g) budget --------------------------------------------------------------------------
  main.push(budget(ctx, sel, cur));

  return { stability: stability(ctx, cur, gravity), main };
}

// ------------------------------------------------------------------------------------------------

function fastenings(ctx: InspectorContext, id: string, gravity: () => number): HTMLElement {
  const { app } = ctx;
  const get = (): SoftEntity | undefined => app.store.soft(id);
  const list = h('div', { class: 'sf-list' });
  const empty = h(
    'p',
    { class: 'hint-text' },
    'Nothing is fastened to this soft body. Fastenings tie particles to a rigid body so they follow it (a sail on a mast, a weight on a cable).',
  );
  let sig = '';
  let rowUpdaters: (() => void)[] = [];
  const edit = (label: string, fn: (e: SoftEntity) => Partial<SoftEntity>) => ctx.edit<SoftEntity>([id], label, fn);

  const build = (e: SoftEntity) => {
    rowUpdaters = [];
    list.replaceChildren();
    for (const att of e.attachments) list.append(attachmentRow(att));
    empty.style.display = e.attachments.length ? 'none' : '';
  };
  const attachmentRow = (att: SoftAttachment): HTMLElement => {
    const name = h('span', { class: 'sf-att-name' });
    const kind = h('span', { class: 'sf-att-kind' }, att.kind === 'rim' ? 'rim' : 'region');
    const load = h('span', { class: 'readout' }, '—');
    const radius = sliderField({
      min: 0.02,
      max: 1.5,
      step: 0.01,
      digits: 2,
      unit: 'm',
      ...ctx.grouped('Fastening radius'),
      onChange: (v) =>
        edit('Fastening radius', (s) => ({
          attachments: s.attachments.map((a) => (a.id === att.id ? { ...a, radius: v } : a)),
        })),
    });
    const release = button('Release', () => app.sim.client.op({ op: 'releaseSoft', id, attachment: att.id }), {
      cls: 'small',
      title:
        'Let go of the body in the running simulation, so the soft body drops free. The fastening stays in the document: Reset restores it.',
    });
    const remove = button(
      'Remove',
      () => {
        if (app.sim.active) app.sim.client.op({ op: 'releaseSoft', id, attachment: att.id });
        edit('Remove fastening', (s) => ({ attachments: s.attachments.filter((a) => a.id !== att.id) }));
      },
      { cls: 'small danger', title: 'Delete this fastening from the document (undo-able).' },
    );
    rowUpdaters.push(() => {
      const s = get();
      const a = s?.attachments.find((x) => x.id === att.id);
      if (!a) return;
      const target = app.store.get(a.body);
      name.textContent = target?.name ?? '(deleted body)';
      name.title = target ? `Fastened to ${target.name}` : 'The fastened body no longer exists';
      kind.textContent = a.kind === 'rim' ? 'rim' : 'region';
      radius.set(a.radius);
      const b = app.store.body(a.body);
      const n = b ? loadCarried(massEstimate(b), b.bodyType === 'dynamic', gravity()) : null;
      load.textContent = n === null ? (b ? 'fixed body' : '—') : `${fmt(n, 1)} N`;
      load.title = b
        ? n === null
          ? 'A static or kinematic body does not hang on the soft body'
          : `${fmt(massEstimate(b), 2)} kg × ${fmt(gravity(), 2)} m/s²`
        : '';
      release.disabled = !app.sim.active;
    });
    return h(
      'div',
      { class: 'sf-att' },
      h('div', { class: 'sf-att-head' }, name, kind),
      a11yRow(
        'Radius',
        radius.el,
        att.kind === 'rim'
          ? 'Not used: a rim fastening takes the whole inner ring.'
          : 'Particles within this distance of the fastening point are tied to the body.',
      ),
      a11yRow(
        'Load carried',
        load,
        'Weight the fastened body puts on the soft body: mass × gravity (dynamic bodies only).',
      ),
      h('div', { class: 'sf-actions' }, release, remove),
    );
  };

  ctx.updaters.push(() => {
    const e = get();
    if (!e) return;
    const next = e.attachments.map((a) => `${a.id}:${a.body}:${a.kind}`).join('|');
    if (next !== sig) {
      sig = next;
      build(e);
    }
    rowUpdaters.forEach((u) => u());
  });
  const sec = section('Fastenings', [list, empty], { id: 'soft-fasten', open: false });
  // Count in the title row would need a rebuild; the badge is updated in place instead.
  const badge = h('span', { class: 'badge' }, '0');
  sec.querySelector('.section-head')?.append(badge);
  ctx.updaters.push(() => {
    const n = get()?.attachments.length ?? 0;
    badge.textContent = String(n);
    badge.style.display = n ? '' : 'none';
  });
  return sec;
}

const a11yRow = (label: string, control: HTMLElement, hint: string): HTMLElement => row(label, control, hint);

// ------------------------------------------------------------------------------------------------

function stability(ctx: InspectorContext, cur: () => SoftEntity[], gravity: () => number): HTMLElement[] {
  const { app } = ctx;
  const body = h('div', { class: 'sf-warnings', role: 'status' });
  const sec = section('Stability', body, { id: 'soft-stability', badge: '!' });
  let sig = '';
  const attachedMass = (e: SoftEntity): number => {
    const seen = new Set<string>();
    let m = 0;
    for (const a of e.attachments) {
      if (seen.has(a.body)) continue;
      seen.add(a.body);
      const b = app.store.body(a.body);
      if (b && b.bodyType === 'dynamic') m += massEstimate(b);
    }
    return m;
  };
  ctx.updaters.push(() => {
    const all = cur().map((e) => ({
      e,
      ws: softWarnings(e, { gravity: gravity(), attachedMass: attachedMass(e) }),
    }));
    const flat = all.flatMap(({ e, ws }) => ws.map((w) => ({ e, w })));
    const next = flat.map(({ e, w }) => `${e.id}/${warningSignature([w])}/${w.fix?.label ?? ''}`).join('#');
    sec.style.display = flat.length ? '' : 'none';
    if (next === sig) return;
    sig = next;
    body.replaceChildren(
      ...flat.map(({ e, w }) => {
        const fixBtn = w.fix
          ? button(w.fix.label, () => ctx.edit<SoftEntity>([e.id], `Fix: ${w.id}`, () => w.fix?.patch ?? {}), {
              cls: 'small primary',
              title: 'Apply this change (undo-able)',
            })
          : null;
        if (fixBtn) fixBtn.dataset.fix = w.id;
        return h(
          'div',
          { class: 'sf-warning', dataset: { warning: w.id } },
          icon('info', 'icon sf-warning-icon'),
          h(
            'div',
            { class: 'sf-warning-body' },
            cur().length > 1 ? h('strong', null, e.name) : null,
            h('span', null, w.message),
            fixBtn,
          ),
        );
      }),
    );
  });
  return [sec];
}

// ------------------------------------------------------------------------------------------------

function budget(ctx: InspectorContext, sel: SoftEntity[], cur: () => SoftEntity[]): HTMLElement {
  const { app } = ctx;
  const fill = h('div', { class: 'sf-bar-fill' });
  const bar = h('div', { class: 'sf-bar', role: 'meter', 'aria-label': 'Particle budget' }, fill);
  const tier = h('div', { class: 'sf-caption' });
  const advice = h('p', { class: 'hint-text sf-hint' });
  const lower = button(
    'Lower resolution',
    () => {
      const todo = cur().filter((e) => suggestResolution(e, 800));
      if (todo.length)
        ctx.edit<SoftEntity>(
          todo.map((e) => e.id),
          'Lower resolution',
          (e) => suggestResolution(e, 800) ?? {},
        );
    },
    {
      cls: 'small',
      title: 'Reduce the resolution of the selected soft bodies to about 800 particles each (or less).',
    },
  );
  const eco = toggleField({
    label: 'Economy mode',
    title:
      'Cheaper soft-body contacts: fewer impact substeps per step. Faster, slightly less accurate when soft bodies hit fast. Applies to the whole scene and is remembered.',
    onChange: (on) => {
      app.prefs.set({ softEconomy: on });
      app.sim.setSoftEconomy(on);
    },
  });
  const elastic = h('span', { class: 'readout' }, '—');
  const elasticRow = row(
    'Elastic energy',
    elastic,
    'Strain energy stored in all stretched springs and soft-body edges of the scene; also plotted in the Energy chart.',
  );
  const render = () => {
    const defs = app.store.all().filter(isSoft);
    const live = app.sim.active ? app.sim.client.stats?.particles : undefined;
    const b = softBudget(defs, live);
    fill.style.width = `${Math.min(100, (b.load / 3.5) * 100).toFixed(1)}%`;
    bar.dataset.tier = b.tier;
    bar.setAttribute('aria-valuenow', String(b.particles));
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '4200');
    const own = cur().reduce((a, e) => a + softParticleCount(e), 0);
    tier.textContent = `${b.particles} particles${live ? ' (live)' : ''} — ${b.tier}${sel.length ? ` · selected ≈ ${own}` : ''}`;
    advice.textContent = b.advice;
    advice.style.display = b.advice ? '' : 'none';
    lower.disabled = !cur().some((e) => suggestResolution(e, 800));
    elasticRow.style.display = app.sim.active ? '' : 'none';
    if (app.sim.active) {
      const j = app.sim.client.stats?.energy.elastic;
      elastic.textContent = j === undefined ? '—' : `${fmt(j, 3)} J`;
    }
  };
  ctx.updaters.push(() => {
    eco.set(app.prefs.value.softEconomy);
    render();
  });
  ctx.live.push(render);
  return section('Budget', [bar, tier, advice, h('div', { class: 'sf-actions' }, lower), eco.el, elasticRow], {
    id: 'soft-budget',
    open: false,
  });
}
