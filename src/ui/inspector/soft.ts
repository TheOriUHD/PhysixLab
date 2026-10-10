/** Inspector sections for soft bodies (jelly, balloon, cloth, cable): recipe, stiffness, pinning, tearing, live readout. */
import { DEG, qfromEuler, qtoEuler, RAD } from '../../core/math';
import type { Vec3 } from '../../core/math';
import type { SoftEntity, SoftPin } from '../../model/types';
import {
  colorField,
  fmt,
  numberField,
  row,
  rowStack,
  section,
  selectField,
  sliderField,
  toggleField,
  vec3Field,
} from '../controls';
import type { Field } from '../controls';
import { h } from '../dom';
import type { InspectorContext } from './shared';

export function softInspector(ctx: InspectorContext, sel: SoftEntity[]): HTMLElement[] {
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
  const bind = <T>(f: Field<T>, get: (e: SoftEntity) => T) => {
    ctx.updaters.push(() => {
      if (cur().length) f.set(get(first()), multi && !same(get));
    });
    return f.el;
  };
  const edit = (label: string, fn: (e: SoftEntity) => Partial<SoftEntity>) => ctx.edit<SoftEntity>(ids, label, fn);
  const out: HTMLElement[] = [ctx.header(sel)];

  // ---- transform ---------------------------------------------------------------------------
  if (!multi) {
    const id = ids[0];
    const pos = vec3Field({
      step: 0.05,
      ...ctx.grouped('Move'),
      onChange: (v) => app.editor.setPose(id, v, first().rotation),
    });
    const rot = vec3Field({
      step: 1,
      digits: 2,
      ...ctx.grouped('Rotate'),
      onChange: (v) => app.editor.setPose(id, first().position, qfromEuler([v[0] * DEG, v[1] * DEG, v[2] * DEG])),
    });
    ctx.updaters.push(() => {
      const e = first();
      pos.set(e.position);
      if (!(document.activeElement && (document.activeElement as HTMLElement).closest('.vec3') === rot.el)) {
        const eu = qtoEuler(e.rotation);
        rot.set([eu[0] * RAD, eu[1] * RAD, eu[2] * RAD]);
      }
    });
    const dim = (label: string, axis: number, min = 0.1) => {
      const f = numberField({
        step: 0.05,
        min,
        unit: 'm',
        ...ctx.grouped('Resize'),
        onChange: (v) =>
          edit('Resize', (e) => {
            const next: Vec3 = [...e.size] as Vec3;
            if (e.type === 'balloon') {
              next[0] = next[1] = next[2] = v;
            } else next[axis] = v;
            return { size: next };
          }),
      });
      ctx.updaters.push(() => f.set(first().size[axis]));
      return row(label, f.el);
    };
    const sizes =
      type === 'jelly'
        ? [dim('Width', 0), dim('Height', 1), dim('Depth', 2)]
        : type === 'balloon'
          ? [dim('Diameter', 0)]
          : type === 'cloth'
            ? [dim('Width', 0), dim('Depth', 2)]
            : [dim('Length', 0)];
    out.push(
      section('Transform', [rowStack('Position (m)', pos.el), rowStack('Rotation (°)', rot.el), ...sizes], {
        id: 'soft-transform',
      }),
    );
  }

  // ---- soft-body parameters ----------------------------------------------------------------
  const resMax = { jelly: 8, balloon: 3, cloth: 28, cable: 80 }[type];
  const resMin = { jelly: 3, balloon: 1, cloth: 6, cable: 6 }[type];
  const res = sliderField({
    min: resMin,
    max: resMax,
    step: 1,
    digits: 0,
    ...ctx.grouped('Resolution'),
    onChange: (v) => edit('Resolution', () => ({ resolution: Math.round(v) })),
  });
  const particles = h('span', { class: 'readout', style: { fontSize: '11.5px', color: 'var(--text-3)' } });
  ctx.updaters.push(() => {
    const e = first();
    const n = e.resolution;
    const count =
      e.type === 'jelly' ? n ** 3 : e.type === 'cloth' ? n * n : e.type === 'cable' ? n : 10 * 4 ** (n - 1) * 2 + 2;
    particles.textContent = `≈ ${count} particles${count > 700 ? ' — heavy' : ''}`;
  });
  const mass = numberField({
    step: 0.1,
    min: 0.01,
    unit: 'kg',
    digits: 2,
    ...ctx.grouped('Mass'),
    onChange: (v) => edit('Mass', () => ({ mass: v })),
  });
  const stiff = sliderField({
    min: 3,
    max: 300,
    log: true,
    unit: 'Hz',
    digits: 0,
    ...ctx.grouped('Stiffness'),
    onChange: (v) => edit('Stiffness', () => ({ stiffness: Math.round(v) })),
  });
  const damp = sliderField({
    min: 0,
    max: 1.5,
    step: 0.01,
    digits: 2,
    ...ctx.grouped('Damping'),
    onChange: (v) => edit('Damping', () => ({ damping: v })),
  });
  const pinOptions: { value: SoftPin; label: string }[] = !allSameType
    ? [{ value: 'none', label: 'Free' }]
    : type === 'cloth'
      ? [
          { value: 'none', label: 'Free (falls)' },
          { value: 'edge', label: 'Pin one edge' },
          { value: 'corners', label: 'Pin two corners' },
          { value: 'corners4', label: 'Pin all four corners' },
        ]
      : type === 'cable'
        ? [
            { value: 'ends', label: 'Pin both ends' },
            { value: 'one-end', label: 'Pin one end' },
            { value: 'none', label: 'Free' },
          ]
        : [{ value: 'none', label: 'Free' }];
  const pin = selectField<SoftPin>({ options: pinOptions, onChange: (v) => edit('Pinning', () => ({ pin: v })) });
  const canTear = toggleField({
    label: 'Can tear',
    onChange: (v) => edit('Toggle tearing', (e) => ({ tearStrain: v ? (e.tearStrain > 0 ? e.tearStrain : 0.3) : 0 })),
  });
  const tear = sliderField({
    min: 0.05,
    max: 1.5,
    step: 0.01,
    digits: 2,
    ...ctx.grouped('Tear strain'),
    onChange: (v) => edit('Tear strain', () => ({ tearStrain: v })),
  });
  const tearRow = row('Tear strain', tear.el, 'Edges tear when stretched beyond this fraction of their rest length');
  const selfC = toggleField({
    label: 'Self-collisions (slower)',
    onChange: (v) => edit('Self-collision', () => ({ selfCollide: v })),
  });
  const grav = numberField({
    step: 0.1,
    digits: 2,
    ...ctx.grouped('Gravity scale'),
    onChange: (v) => edit('Gravity scale', () => ({ gravityScale: v })),
  });
  const damping = numberField({
    step: 0.01,
    min: 0,
    digits: 3,
    unit: '1/s',
    ...ctx.grouped('Air drag'),
    onChange: (v) => edit('Air drag', () => ({ linearDamping: v })),
  });
  ctx.updaters.push(() => {
    const e = first();
    res.set(e.resolution);
    mass.set(e.mass);
    stiff.set(e.stiffness);
    damp.set(e.damping);
    if (allSameType) pin.set(e.pin);
    canTear.set(e.tearStrain > 0, multi && !same((x) => x.tearStrain > 0));
    if (e.tearStrain > 0) tear.set(e.tearStrain);
    tearRow.style.display = e.tearStrain > 0 ? '' : 'none';
    selfC.set(e.selfCollide);
    grav.set(e.gravityScale);
    damping.set(e.linearDamping);
  });
  const pinRow =
    type === 'jelly' || type === 'balloon' ? [] : [row('Pinning', pin.el, 'Pinned particles are fixed in space')];
  out.push(
    section(
      'Soft body',
      [
        row('Resolution', res.el, 'Particles per side / per cable. More looks smoother but costs more'),
        h('div', { style: { padding: '0 0 4px 100px' } }, particles),
        row('Mass', mass.el),
        row('Stiffness', stiff.el, 'Natural frequency of the material: ~7 Hz is very squishy, 40+ Hz nearly rigid'),
        row('Damping', damp.el, '0 = bouncy, 1 = heavily damped'),
        ...pinRow,
        canTear.el,
        tearRow,
        ...(type === 'cable' ? [] : [selfC.el]),
        row('Gravity scale', grav.el),
        row('Air drag', damping.el),
        h(
          'p',
          { class: 'hint-text' },
          'Soft bodies are simulated as lattices of particles by the engine’s soft-body solver; drag them with the mouse while running. Changing a parameter while running rebuilds the soft body at its starting pose.',
        ),
      ],
      { id: 'soft-body' },
    ),
  );

  // ---- appearance --------------------------------------------------------------------------
  const color = colorField({
    ...ctx.grouped('Edit colour'),
    onChange: (v) => edit('Edit colour', () => ({ color: v })),
  });
  const rough = sliderField({
    min: 0,
    max: 1,
    step: 0.01,
    digits: 2,
    ...ctx.grouped('Edit roughness'),
    onChange: (v) => edit('Edit roughness', () => ({ roughness: v })),
  });
  const opac = sliderField({
    min: 0.05,
    max: 1,
    step: 0.01,
    digits: 2,
    ...ctx.grouped('Edit opacity'),
    onChange: (v) => edit('Edit opacity', () => ({ opacity: v })),
  });
  out.push(
    section(
      'Appearance',
      [
        row(
          'Colour',
          bind(color, (e) => e.color),
        ),
        row(
          'Roughness',
          bind(rough, (e) => e.roughness),
        ),
        row(
          'Opacity',
          bind(opac, (e) => e.opacity),
        ),
      ],
      { id: 'soft-appearance', open: false },
    ),
  );

  // ---- live --------------------------------------------------------------------------------
  if (app.sim.active && !multi) {
    const dl = h('dl', { class: 'readout' });
    const r: Record<string, HTMLElement> = {};
    for (const [k, label] of [
      ['particles', 'Particles'],
      ['pieces', 'Extent'],
      ['low', 'Lowest point'],
      ['high', 'Highest point'],
    ] as const) {
      const dd = h('dd', null, '—');
      r[k] = dd;
      dl.append(h('dt', null, label), dd);
    }
    ctx.live.push(() => {
      const pos = app.sim.client.softOf(ids[0]);
      if (!pos || !pos.length) return;
      let lo = Infinity,
        hi = -Infinity,
        xl = Infinity,
        xh = -Infinity,
        zl = Infinity,
        zh = -Infinity;
      for (let i = 0; i < pos.length; i += 3) {
        xl = Math.min(xl, pos[i]);
        xh = Math.max(xh, pos[i]);
        lo = Math.min(lo, pos[i + 1]);
        hi = Math.max(hi, pos[i + 1]);
        zl = Math.min(zl, pos[i + 2]);
        zh = Math.max(zh, pos[i + 2]);
      }
      r.particles.textContent = String(pos.length / 3);
      r.pieces.textContent = `${fmt(xh - xl, 2)} × ${fmt(hi - lo, 2)} × ${fmt(zh - zl, 2)} m`;
      r.low.textContent = `${fmt(lo, 3)} m`;
      r.high.textContent = `${fmt(hi, 3)} m`;
    });
    out.push(section('Live', [dl], { id: 'live', badge: 'LIVE' }));
  }
  return out;
}
