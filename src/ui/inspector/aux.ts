/**
 * Inspector panels for the editor-level entity kinds: groups, lights and paths, plus the "Group" membership row
 * every posed entity gets. They follow the conventions of `body.ts`: fields are registered with `ctx.updaters` so a
 * document change refreshes values in place, and every edit goes through the store (one undo step per scrub).
 */
import { DEG, qfromEuler, qtoEuler, RAD } from '../../core/math';
import type { Vec3 } from '../../core/math';
import { descendantIds, childIndex } from '../../model/groups';
import { LIGHT_LABELS } from '../../model/factory';
import { PathCurve } from '../../model/path';
import type { Entity, GroupEntity, LightEntity, LightType, PathEntity } from '../../model/types';
import { isPosed, parentOf } from '../../model/types';
import {
  button,
  colorField,
  fmt,
  numberField,
  row,
  rowStack,
  section,
  segmented,
  selectField,
  toggleField,
  vec3Field,
} from '../controls';
import { h } from '../dom';
import { icon } from '../icons';
import type { InspectorContext } from './shared';

/** Position + rotation rows for one posed entity (groups move their members with them). */
function transformRows(
  ctx: InspectorContext,
  id: string,
  opts: { rotation?: boolean; note?: string } = {},
): HTMLElement[] {
  const { app } = ctx;
  const posed = () => {
    const e = app.store.get(id);
    return isPosed(e) ? e : undefined;
  };
  const gp = ctx.grouped('Move');
  const pos = vec3Field({
    step: 0.05,
    unit: 'm',
    ...gp,
    onChange: (v) => {
      const e = posed();
      if (e) app.editor.setPose(id, v, e.rotation);
    },
  });
  ctx.updaters.push(() => {
    const e = posed();
    if (e) pos.set(e.position);
  });
  const out: HTMLElement[] = [rowStack('Position (m)', pos.el, opts.note)];
  if (opts.rotation !== false) {
    const rot = vec3Field({
      step: 1,
      unit: '°',
      digits: 2,
      ...ctx.grouped('Rotate'),
      onChange: (v) => {
        const e = posed();
        if (e) app.editor.setPose(id, e.position, qfromEuler([v[0] * DEG, v[1] * DEG, v[2] * DEG]));
      },
    });
    ctx.updaters.push(() => {
      const e = posed();
      if (!e) return;
      // keep the user's own representation while they are scrubbing
      if (document.activeElement && (document.activeElement as HTMLElement).closest('.vec3') === rot.el) return;
      const eu = qtoEuler(e.rotation);
      rot.set([eu[0] * RAD, eu[1] * RAD, eu[2] * RAD]);
    });
    out.push(rowStack('Rotation (°)', rot.el));
  }
  return out;
}

/** The "Group" row: which group the selected entities live in. */
export function membershipRow(ctx: InspectorContext, ids: string[]): HTMLElement | null {
  const { app } = ctx;
  const { store } = app;
  if (!ids.length || !ids.every((id) => isPosed(store.get(id)))) return null;
  const sel = selectField<string>({
    options: [{ value: '', label: '— none (scene root) —' }],
    onChange: (v) => app.editor.setParent(ids, v || null),
  });
  const select = sel.el.querySelector('select')!;
  // The option list (every group except the entities themselves and what is inside them) is built when the list is
  // about to open — not on every document change.
  const fill = () => {
    const index = childIndex(store.all());
    const banned = new Set(ids.flatMap((id) => [id, ...descendantIds(index, id)]));
    const groups = store.groups().filter((g) => !banned.has(g.id));
    const sig = groups.map((g) => `${g.id}=${g.name}`).join('|');
    if (select.dataset.sig === sig) return;
    select.dataset.sig = sig;
    select.replaceChildren(
      h('option', { value: '' }, '— none (scene root) —'),
      ...groups.map((g) => h('option', { value: g.id }, g.name)),
    );
  };
  select.addEventListener('pointerdown', fill);
  select.addEventListener('focus', fill);
  fill();
  ctx.updaters.push(() => {
    const parents = new Set(ids.map((id) => parentOf(store.get(id) as Entity)));
    const only = parents.size === 1 ? [...parents][0] : undefined;
    if (only !== undefined && ![...select.options].some((o) => o.value === only)) fill(); // a group created since
    if (parents.size === 1) sel.set(only ?? '');
    else sel.set('', true);
  });
  return row('Group', sel.el, 'Members of a group move with it; delete the group and they stay where they are');
}

// ---- group -----------------------------------------------------------------------------------

export function groupInspector(ctx: InspectorContext, g: GroupEntity): HTMLElement[] {
  const { app } = ctx;
  const { store } = app;
  const members = h('span', { class: 'readout' });
  ctx.updaters.push(() => {
    const n = store.descendants(g.id).length;
    members.textContent = `${n} ${n === 1 ? 'item' : 'items'} inside`;
  });
  const actions = h(
    'div',
    { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
    button('Select members', () => store.setSelection(store.children(g.id).map((c) => c.id)), {
      icon: 'select',
      title: 'Select what is directly in this group',
    }),
    button('Ungroup', () => app.editor.ungroup([g.id]), {
      icon: 'group',
      title: 'Dissolve the group; its members stay where they are (Ctrl+Shift+G)',
    }),
  );
  const note = app.sim.active ? 'Groups are edited in the document: stop the simulation to move one' : undefined;
  const parent = membershipRow(ctx, [g.id]);
  return [
    ctx.header([g]),
    section(
      'Group',
      [
        row('Contents', members),
        ...(parent ? [parent] : []),
        ...transformRows(ctx, g.id, { note }),
        h(
          'p',
          { class: 'hint-text' },
          'The pivot is where the move and rotate handles sit. Moving the group moves everything inside it.',
        ),
        actions,
      ],
      { id: 'group' },
    ),
  ];
}

// ---- light -----------------------------------------------------------------------------------

const LIGHT_UNIT: Record<LightType, string> = { point: 'cd', spot: 'cd', directional: 'lx', area: 'nits' };

export function lightInspector(ctx: InspectorContext, sel: LightEntity[]): HTMLElement[] {
  const { app } = ctx;
  const ids = sel.map((l) => l.id);
  const multi = sel.length > 1;
  const cur = (): LightEntity[] => ids.map((id) => app.store.light(id)).filter((l): l is LightEntity => !!l);
  const first = (): LightEntity => cur()[0];
  const mixed = <T>(get: (l: LightEntity) => T) => {
    const l = cur();
    return l.some((x) => JSON.stringify(get(x)) !== JSON.stringify(get(l[0])));
  };
  const bind = <T>(f: { el: HTMLElement; set(v: T, mixed?: boolean): void }, get: (l: LightEntity) => T) => {
    ctx.updaters.push(() => {
      if (cur().length) f.set(get(first()), multi && mixed(get));
    });
    return f.el;
  };
  const edit = (label: string, fn: (l: LightEntity) => Partial<LightEntity>) => ctx.edit<LightEntity>(ids, label, fn);
  const num = (
    label: string,
    get: (l: LightEntity) => number,
    set: (v: number) => Partial<LightEntity>,
    o: { step?: number; min?: number; max?: number; unit?: string; digits?: number; hint?: string } = {},
  ) =>
    row(
      label,
      bind(
        numberField({
          step: o.step ?? 0.1,
          min: o.min,
          max: o.max,
          unit: o.unit,
          digits: o.digits,
          ...ctx.grouped(`Edit ${label}`),
          onChange: (v) => edit(`Edit ${label}`, () => set(v)),
        }),
        get,
      ),
      o.hint,
    );

  const type = segmented<LightType>({
    options: (Object.keys(LIGHT_LABELS) as LightType[]).map((t) => ({
      value: t,
      label: { point: 'Point', spot: 'Spot', directional: 'Sun', area: 'Area' }[t],
      title: LIGHT_LABELS[t],
    })),
    onChange: (v) => edit('Change light type', () => ({ lightType: v })),
  });
  ctx.updaters.push(() => {
    if (!mixed((l) => l.lightType)) type.set(first().lightType);
    else type.buttons.forEach((b) => b.classList.remove('on'));
  });
  const enabled = toggleField({
    label: 'On',
    onChange: (v) => edit(v ? 'Switch light on' : 'Switch light off', () => ({ enabled: v })),
  });
  const shadow = toggleField({
    label: 'Cast shadows',
    title: 'Point and spot shadows cost a lot; only the first few shadow casters are rendered',
    onChange: (v) => edit('Toggle shadows', () => ({ castShadow: v })),
  });
  const color = colorField({
    ...ctx.grouped('Edit light colour'),
    onChange: (v) => edit('Edit light colour', () => ({ color: v })),
  });

  // controls that only make sense for some kinds are shown or hidden as the type changes
  const spotRows: HTMLElement[] = [
    num(
      'Cone angle',
      (l) => l.angle * RAD,
      (v) => ({ angle: Math.min(89, Math.max(1, v)) * DEG }),
      {
        step: 1,
        min: 1,
        max: 89,
        unit: '°',
        digits: 1,
        hint: 'Half-angle of the cone',
      },
    ),
    num(
      'Soft edge',
      (l) => l.penumbra,
      (v) => ({ penumbra: Math.min(1, Math.max(0, v)) }),
      {
        step: 0.05,
        min: 0,
        max: 1,
        digits: 2,
      },
    ),
  ];
  const rangeRow = num(
    'Range',
    (l) => l.range,
    (v) => ({ range: Math.max(0, v) }),
    {
      step: 0.5,
      min: 0,
      unit: 'm',
      hint: 'Distance at which the light fades out completely. 0 = unlimited',
    },
  );
  const areaRows: HTMLElement[] = [
    num(
      'Width',
      (l) => l.size[0],
      (v) => ({ size: [Math.max(0.05, v), first().size[1]] }),
      { step: 0.1, min: 0.05, unit: 'm' },
    ),
    num(
      'Height',
      (l) => l.size[1],
      (v) => ({ size: [first().size[0], Math.max(0.05, v)] }),
      { step: 0.1, min: 0.05, unit: 'm' },
    ),
  ];
  const intensity = row(
    'Intensity',
    bind(
      numberField({
        step: 1,
        min: 0,
        digits: 2,
        ...ctx.grouped('Edit intensity'),
        onChange: (v) => edit('Edit intensity', () => ({ intensity: Math.max(0, v) })),
      }),
      (l) => l.intensity,
    ),
  );
  const unit = h('span', { class: 'num-unit', style: { marginLeft: '6px' } });
  intensity.querySelector('.row-control')!.appendChild(unit);
  // -- VZ-A: photometric readout + flicker / pulse --
  const lumens = h('span', { class: 'readout' });
  const lumensRow = row('Output', lumens, 'Approximate total luminous flux of the light');
  const fx = segmented<'steady' | 'flicker' | 'pulse'>({
    options: [
      { value: 'steady', label: 'Steady' },
      { value: 'flicker', label: 'Flicker', title: 'Candle / faulty-tube style random dips' },
      { value: 'pulse', label: 'Pulse', title: 'Smooth breathing between full and dimmed' },
    ],
    onChange: (v) =>
      edit('Light effect', (l) => {
        if (v === 'steady') return { flicker: undefined };
        return {
          flicker: { mode: v, amount: l.flicker?.amount ?? 0.4, speed: l.flicker?.speed ?? (v === 'pulse' ? 0.5 : 6) },
        };
      }),
  });
  const fxAmount = num(
    'Depth',
    (l) => l.flicker?.amount ?? 0.4,
    (v) => ({
      flicker: {
        mode: first().flicker?.mode ?? 'flicker',
        amount: Math.min(1, Math.max(0, v)),
        speed: first().flicker?.speed ?? 2,
      },
    }),
    { step: 0.05, min: 0, max: 1, digits: 2, hint: 'How far the light dips below its intensity' },
  );
  const fxSpeed = num(
    'Speed',
    (l) => l.flicker?.speed ?? 2,
    (v) => ({
      flicker: {
        mode: first().flicker?.mode ?? 'flicker',
        amount: first().flicker?.amount ?? 0.4,
        speed: Math.min(30, Math.max(0.05, v)),
      },
    }),
    { step: 0.1, min: 0.05, max: 30, unit: 'Hz', digits: 2 },
  );
  ctx.updaters.push(() => {
    if (!cur().length) return;
    const l = first();
    const m = l.flicker?.mode ?? 'steady';
    if (!mixed((x) => x.flicker?.mode)) fx.set(m);
    fxAmount.style.display = fxSpeed.style.display = m === 'steady' ? 'none' : '';
    const cd = l.intensity;
    lumens.textContent =
      l.lightType === 'point'
        ? `≈ ${Math.round(4 * Math.PI * cd)} lm`
        : l.lightType === 'spot'
          ? `≈ ${Math.round(2 * Math.PI * (1 - Math.cos(l.angle)) * cd)} lm`
          : l.lightType === 'area'
            ? `≈ ${Math.round(cd * Math.PI * l.size[0] * l.size[1])} lm`
            : `${cd} lx on a surface facing it`;
  });
  const visibility = () => {
    const t = cur().length ? first().lightType : 'point';
    const same = !mixed((l) => l.lightType);
    for (const r of spotRows) r.style.display = same && t === 'spot' ? '' : 'none';
    rangeRow.style.display = same && (t === 'point' || t === 'spot') ? '' : 'none';
    for (const r of areaRows) r.style.display = same && t === 'area' ? '' : 'none';
    shadow.el.style.display = same && t === 'area' ? 'none' : '';
    unit.textContent = same ? LIGHT_UNIT[t] : '';
  };
  ctx.updaters.push(visibility);

  const out: HTMLElement[] = [ctx.header(sel)];
  out.push(
    section(
      'Light',
      [
        rowStack('Type', type.el),
        row(
          'State',
          bind(enabled, (l) => l.enabled),
        ),
        row(
          'Colour',
          bind(color, (l) => l.color),
        ),
        intensity,
        lumensRow,
        rowStack('Effect', fx.el),
        fxAmount,
        fxSpeed,
        rangeRow,
        ...spotRows,
        ...areaRows,
        row(
          'Shadows',
          bind(shadow, (l) => l.castShadow),
        ),
        h(
          'p',
          { class: 'hint-text' },
          'Lights shine along their −Z axis: rotate one to aim it. Intensities are physical: candela for point and spot lights, lux for the sun, nits for area lights.',
        ),
      ],
      { id: 'light' },
    ),
  );
  if (!multi) {
    out.push(section('Transform', transformRows(ctx, ids[0]), { id: 'transform' }));
  }
  const membership = membershipRow(ctx, ids);
  if (membership) out.push(section('Organise', [membership], { id: 'organise' }));
  return out;
}

// ---- path ------------------------------------------------------------------------------------

export function pathInspector(ctx: InspectorContext, p: PathEntity): HTMLElement[] {
  const { app } = ctx;
  const { store } = app;
  const id = p.id;
  const cur = (): PathEntity => store.path(id) ?? p;

  const closed = toggleField({
    label: 'Closed loop',
    title: 'Connect the last point back to the first (needs three or more points)',
    onChange: (v) => {
      if (v && cur().points.length < 3) {
        app.toast('A closed path needs at least three points', 'warn');
        closed.set(false);
        return;
      }
      store.update(id, { closed: v }, v ? 'Close path' : 'Open path');
    },
  });
  const tension = numberField({
    step: 0.05,
    min: 0,
    max: 1,
    digits: 2,
    ...ctx.grouped('Edit tension'),
    onChange: (v) => store.update(id, { tension: Math.min(1, Math.max(0, v)) }, 'Edit tension'),
  });
  const color = colorField({
    ...ctx.grouped('Edit path colour'),
    onChange: (v) => store.update(id, { color: v }, 'Edit path colour'),
  });
  const length = h('span', { class: 'readout' });
  ctx.updaters.push(() => {
    const e = cur();
    closed.set(e.closed);
    tension.set(e.tension);
    color.set(e.color);
    const len = new PathCurve({ points: e.points, closed: e.closed, tension: e.tension }).length;
    length.textContent = `${fmt(len, 2)} m · ${e.points.length} points`;
  });

  // ---- control points ----
  const list = h('div', { class: 'path-points' });
  let built = '';
  const rebuild = () => {
    const e = cur();
    const sig = `${e.points.length}|${app.pathPoint?.id === id ? app.pathPoint.index : -1}`;
    if (sig === built) {
      // same shape: just refresh the numbers
      list
        .querySelectorAll<HTMLElement>('.path-point')
        .forEach((el, i) => el.dispatchEvent(new CustomEvent('refresh', { detail: e.points[i] })));
      return;
    }
    built = sig;
    list.replaceChildren(
      ...e.points.map((pt, i) => {
        const active = app.pathPoint?.id === id && app.pathPoint.index === i;
        const f = vec3Field({
          step: 0.05,
          digits: 3,
          ...ctx.grouped('Edit path point'),
          onChange: (v) => {
            const c = cur();
            store.update(id, { points: c.points.map((q, j) => (j === i ? v : q)) }, 'Edit path point');
          },
        });
        f.set(pt);
        const holder = h('div', { class: `path-point ${active ? 'active' : ''}`, dataset: { index: String(i) } });
        holder.addEventListener('refresh', (ev) => {
          if (!holder.contains(document.activeElement)) f.set((ev as CustomEvent<Vec3>).detail);
        });
        const mini = (ic: string, title: string, fn: () => void) => {
          const b = h('button', { class: 'icon-btn small', type: 'button', title }, icon(ic));
          b.addEventListener('click', fn);
          return b;
        };
        holder.append(
          h('span', { class: 'path-idx' }, String(i + 1)),
          f.el,
          mini('move', 'Edit this point with the gizmo', () => app.setPathPoint(id, i)),
          mini('plus', 'Insert a point after this one', () => {
            const at = app.editor.insertPathPoint(id, i);
            if (at >= 0) app.setPathPoint(id, at);
          }),
          mini('trash', 'Delete this point', () => {
            if (!app.editor.removePathPoint(id, i))
              app.toast(`A ${cur().closed ? 'closed ' : ''}path keeps at least ${cur().closed ? 3 : 2} points`, 'warn');
          }),
        );
        return holder;
      }),
    );
  };
  ctx.updaters.push(rebuild);

  const parent = membershipRow(ctx, [id]);
  return [
    ctx.header([p]),
    section(
      'Path',
      [
        row('Shape', closed.el),
        row('Tension', tension.el, '0 = smooth Catmull-Rom spline, 1 = straight segments'),
        row('Colour', color.el),
        row('Length', length),
        ...(parent ? [parent] : []),
        h(
          'p',
          { class: 'hint-text' },
          'The curve passes through every point. The green point is the start, the red one the end; arrows show the direction of travel.',
        ),
      ],
      { id: 'path' },
    ),
    section('Transform', transformRows(ctx, id, { rotation: true }), { id: 'transform' }),
    section(
      'Points',
      [
        list,
        button(
          'Add point',
          () => {
            const at = app.editor.insertPathPoint(id, cur().points.length - 1);
            if (at >= 0) app.setPathPoint(id, at);
          },
          { icon: 'plus', title: 'Append a point after the last one' },
        ),
      ],
      { id: 'path-points' },
    ),
  ];
}
