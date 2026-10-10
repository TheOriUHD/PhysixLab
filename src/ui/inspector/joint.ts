/** Inspector sections for a joint: connection, anchors and axis, limits, motor, spring / rope settings, live readout. */
import { Vector3 } from 'three';
import { DEG, RAD, qrot, vadd, vdist, vlen } from '../../core/math';
import type { Vec3 } from '../../core/math';
import { JOINT_TYPE_LABELS } from '../../model/factory';
import { AXIS_TYPES, INDEPENDENT_ANCHOR_TYPES } from '../../model/jointParams';
import { anchorBFromGeometry, convertJoint, convertibleTo } from '../../model/jointConvert';
import type { JointEntity, MotorMode } from '../../model/types';
import {
  fmt,
  keyField,
  numberField,
  row,
  rowStack,
  section,
  segmented,
  sliderField,
  toggleField,
  vec3Field,
  button,
} from '../controls';
import type { Field } from '../controls';
import { h } from '../dom';
import { breakageSection } from './jointBreakage';
import { copyJointSettingsTo } from '../../app/jointOps';
import { openMenu } from '../menu';
import { jointDiagram, openJointPicker } from './jointPicker';
import { AXIS_LABELS, jointTypeSections, liveDefs } from './jointTypes';
import type { InspectorContext } from './shared';

export function jointInspector(ctx: InspectorContext, j0: JointEntity): HTMLElement[] {
  const { app } = ctx;
  const id = j0.id;
  const get = () => app.store.joint(id)!;
  const out: HTMLElement[] = [ctx.header([j0])];
  const bind = <T>(f: Field<T>, g: (j: JointEntity) => T) => {
    ctx.updaters.push(() => {
      if (app.store.joint(id)) f.set(g(get()));
    });
    return f.el;
  };
  const edit = (label: string, fn: (j: JointEntity) => Partial<JointEntity>) => app.store.update(id, fn(get()), label);
  const grouped = (label: string) => ctx.grouped(label);
  // hinge / slider: limits, motor and re-zero; `hasAxis` types show the axis row; `independentEnds` types have their own end B
  const isUnit = j0.type === 'hinge' || j0.type === 'slider';
  const hasAxis = AXIS_TYPES.includes(j0.type);
  const independentEnds = INDEPENDENT_ANCHOR_TYPES.includes(j0.type);
  const unit = j0.type === 'hinge' ? '°' : 'm';
  const toUI = (v: number) => (j0.type === 'hinge' ? v * RAD : v);
  const fromUI = (v: number) => (j0.type === 'hinge' ? v * DEG : v);

  // ---- connection -----------------------------------------------------------------------------
  const nameOf = (bid: string | null) => (bid ? (app.store.body(bid)?.name ?? '?') : 'World');
  const link = (side: 'A' | 'B') => {
    const b = h('button', { class: 'btn small', type: 'button', title: 'Select this body' });
    b.addEventListener('click', () => {
      const bid = side === 'A' ? get().bodyA : get().bodyB;
      if (bid) app.store.setSelection([bid]);
    });
    ctx.updaters.push(() => {
      const bid = side === 'A' ? get().bodyA : get().bodyB;
      b.textContent = nameOf(bid);
      b.disabled = !bid;
    });
    return b;
  };
  const swap = button(
    'Swap A ↔ B',
    () => {
      const j = get();
      const p = j.params;
      // Everything that names an end follows the swap: shafts, radii, the pulley's fixed points, reciprocal ratios.
      const params = {
        ...p,
        axisB: j.axis,
        radiusA: p.radiusB,
        radiusB: p.radiusA,
        pulleyA: p.pulleyB,
        pulleyB: p.pulleyA,
        ratio: j.type === 'gear' || j.type === 'pulley' ? Math.min(1000, Math.max(0.01, 1 / p.ratio)) : p.ratio,
      };
      app.store.update(
        id,
        { bodyA: j.bodyB, bodyB: j.bodyA, anchorA: j.anchorB, anchorB: j.anchorA, axis: p.axisB, params },
        'Swap joint ends',
      );
    },
    {
      cls: 'small',
      title: 'Swap which body is the parent. Anchors, shafts and ratios swap with it.',
    },
  );
  // A rack's two ends have different roles (pinion / rack), so they cannot trade places.
  swap.disabled = !independentEnds || j0.type === 'rack';
  swap.title = j0.type === 'rack' ? 'The pinion and the rack have different roles and cannot be swapped' : swap.title;

  // Copy settings to…: limits, motor, spring and behaviour params go to other joints of the same type (one undo step).
  const copyBtn = button(
    'Copy settings to…',
    () => {
      const me = get();
      const others = app.store.joints().filter((o) => o.id !== id && o.type === me.type);
      openMenu(
        [
          {
            label: `All other ${JOINT_TYPE_LABELS[me.type]} joints (${others.length})`,
            action: () => {
              copyJointSettingsTo(
                app,
                id,
                others.map((o) => o.id),
              );
            },
          },
          { sep: true },
          ...others.slice(0, 14).map((o) => ({
            label: o.name,
            action: () => {
              copyJointSettingsTo(app, id, [o.id]);
            },
          })),
          ...(others.length > 14
            ? [{ label: `… and ${others.length - 14} more`, action: () => {}, disabled: true }]
            : []),
        ],
        copyBtn,
      );
    },
    {
      cls: 'small',
      title:
        'Copy limits, motor, spring and behaviour settings (not the position or axis) to other joints of this type',
    },
  );
  ctx.updaters.push(() => {
    const n = app.store.joints().filter((o) => o.id !== id && o.type === get().type).length;
    copyBtn.disabled = n === 0;
  });

  // Change type…: the grouped picker with diagrams; one undo step, bodies and anchors stay.
  const typeBtn = button('Change type…', () => {}, {
    cls: 'small',
    title: 'Convert this joint to another type, keeping its bodies and anchors',
  });
  typeBtn.addEventListener('click', () => {
    const j = get();
    openJointPicker(typeBtn, {
      current: j.type,
      title: 'Change joint type',
      targets: convertibleTo(j),
      onPick: (type) => {
        const cur = get();
        const pose = (bid: string | null) => {
          const b = bid ? app.store.body(bid) : undefined;
          return b ? { position: b.position, rotation: b.rotation } : null;
        };
        const wa = pose(cur.bodyA);
        const wb = pose(cur.bodyB);
        const worldOf = (p: ReturnType<typeof pose>, a: Vec3): Vec3 => (p ? vadd(p.position, qrot(p.rotation, a)) : a);
        const ownEnds = INDEPENDENT_ANCHOR_TYPES.includes(cur.type);
        const patch = convertJoint(cur, type, {
          anchorB: anchorBFromGeometry(cur, wa, wb),
          distance: ownEnds ? vdist(worldOf(wa, cur.anchorA), worldOf(wb, cur.anchorB)) : undefined,
        });
        app.store.update(id, patch, `Change joint type to ${JOINT_TYPE_LABELS[type]}`);
      },
    });
  });
  ctx.updaters.push(() => {
    typeBtn.disabled = app.sim.active;
    typeBtn.title = app.sim.active
      ? 'Stop the simulation to change the joint type'
      : 'Convert this joint to another type, keeping its bodies and anchors';
  });
  out.push(
    section(
      'Connection',
      [
        row(
          'Type',
          h(
            'div',
            { class: 'jt-type-row' },
            jointDiagram(j0.type),
            h('span', { class: 'readout' }, JOINT_TYPE_LABELS[j0.type]),
          ),
        ),
        row('Body A', link('A')),
        row('Body B', link('B')),
        independentEnds ? row('', swap) : h('span'),
        row(
          'Collide',
          bind(
            toggleField({
              label: 'Connected bodies collide',
              onChange: (v) => edit('Toggle joint collisions', () => ({ collideConnected: v })),
            }),
            (j) => j.collideConnected,
          ),
        ),
        h('div', { class: 'jt-actions' }, typeBtn, copyBtn),
      ],
      { id: 'joint-conn' },
    ),
  );

  // ---- anchors & axis -----------------------------------------------------------------------
  const anchorA = vec3Field({
    step: 0.05,
    unit: 'm',
    ...grouped('Move joint anchor'),
    onChange: (v) => edit('Move joint anchor', () => ({ anchorA: v })),
  });
  const rows: HTMLElement[] = [
    h('p', { class: 'hint-text' }, j0.bodyA ? 'Anchor in body A’s local frame.' : 'Anchor in world coordinates.'),
    rowStack(
      'Anchor A (m)',
      bind(anchorA, (j) => j.anchorA),
    ),
  ];
  if (independentEnds) {
    const anchorB = vec3Field({
      step: 0.05,
      unit: 'm',
      ...grouped('Move joint anchor'),
      onChange: (v) => edit('Move joint anchor', () => ({ anchorB: v })),
    });
    rows.push(
      rowStack(
        'Anchor B (m)',
        bind(anchorB, (j) => j.anchorB),
      ),
    );
    const endSeg = segmented<'A' | 'B'>({
      options: [
        { value: 'A', label: 'End A' },
        { value: 'B', label: 'End B' },
      ],
      value: app.jointEnd,
      onChange: (v) => app.setJointEnd(v),
    });
    ctx.updaters.push(() => endSeg.set(app.jointEnd));
    rows.push(row('Gizmo end', endSeg.el, 'Which end the move gizmo drags'));
  }
  if (hasAxis) {
    const axisInfo = AXIS_LABELS[j0.type] ?? {
      label: 'Axis (unit vector)',
      hint: 'Local to body A (world if A is the world)',
    };
    const axis = vec3Field({
      step: 0.1,
      digits: 3,
      ...grouped('Edit axis'),
      onChange: (v) => {
        const l = vlen(v) || 1;
        edit('Edit axis', () => ({ axis: [v[0] / l, v[1] / l, v[2] / l] }));
      },
    });
    rows.push(
      rowStack(
        axisInfo.label,
        bind(axis, (j) => j.axis),
        axisInfo.hint,
      ),
    );
    const axes = h('div', { class: 'chips' });
    for (const [label, w] of [
      ['X', [1, 0, 0]],
      ['Y', [0, 1, 0]],
      ['Z', [0, 0, 1]],
    ] as [string, Vec3][]) {
      const b = h('button', { class: 'chip', type: 'button', title: `Align the axis with world ${label}` }, label);
      b.addEventListener('click', () =>
        edit('Set joint axis', (j) => ({ axis: app.editor.worldAxisToLocal(j.bodyA, w) })),
      );
      axes.appendChild(b);
    }
    rows.push(row('Align to world', axes));
  }
  out.push(section('Anchors', rows, { id: 'joint-anchor' }));
  // ---- type-specific sections (JT-A types) ------------------------------------------------------
  out.push(...jointTypeSections({ ctx, app, id, get, bind, edit }, j0.type));

  // ---- limits -------------------------------------------------------------------------------
  if (isUnit) {
    // Reference pose (JT-22): where the joint's zero is. Limits, motor targets and the live value count from it.
    const setRef = (label: string, p: Partial<JointEntity['params']>) =>
      edit(label, (j) => ({ params: { ...j.params, ...p } }));
    const lock = toggleField({
      label: 'Lock reference pose',
      title: 'A locked reference cannot be re-zeroed by accident',
      onChange: (v) => setRef(v ? 'Lock reference pose' : 'Unlock reference pose', { refLocked: v }),
    });
    const rezero = button(
      'Re-zero reference pose',
      () => {
        const j = get();
        if (j.params.refLocked) return;
        // While simulating the current pose becomes zero; in the editor the zero returns to the starting pose.
        const live = app.sim.active ? app.liveJoint(id) : null;
        if (app.sim.active && (!live || live.broken)) return;
        setRef('Re-zero reference pose', { refOffset: live ? j.params.refOffset - live.value : 0 });
      },
      { cls: 'small' },
    );
    const refInfo = h('div', { class: 'jt-info' });
    ctx.updaters.push(() => {
      const j = get();
      const off = j.params.refOffset;
      const shown = j0.type === 'hinge' ? `${fmt(off * RAD, 2)}°` : `${fmt(off, 3)} m`;
      refInfo.replaceChildren(
        'Starting pose reads ',
        h('b', null, shown),
        off === 0 ? ' (zero = starting pose)' : ' (limits and readout count from the re-zeroed pose)',
      );
      rezero.disabled = j.params.refLocked || (!app.sim.active && off === 0);
      rezero.title = j.params.refLocked
        ? 'Unlock the reference pose to re-zero it'
        : app.sim.active
          ? 'Make the current pose the joint’s zero: limits, motor targets and the readout are measured from it'
          : 'Return the joint’s zero to the pose it has when the simulation starts';
    });
    const referenceRows = (): HTMLElement[] => [refInfo, h('div', { class: 'jt-actions' }, rezero, lock.el)];
    ctx.updaters.push(() => lock.set(get().params.refLocked));
    const lim = toggleField({
      label: 'Limit the range of motion',
      onChange: (v) => edit('Toggle limits', (j) => ({ limit: { ...j.limit, enabled: v } })),
    });
    const mn = numberField({
      step: j0.type === 'hinge' ? 5 : 0.05,
      unit,
      digits: 2,
      ...grouped('Edit limit'),
      onChange: (v) => edit('Edit limit', (j) => ({ limit: { ...j.limit, min: fromUI(v) } })),
    });
    const mx = numberField({
      step: j0.type === 'hinge' ? 5 : 0.05,
      unit,
      digits: 2,
      ...grouped('Edit limit'),
      onChange: (v) => edit('Edit limit', (j) => ({ limit: { ...j.limit, max: fromUI(v) } })),
    });
    ctx.updaters.push(() => {
      const j = get();
      lim.set(j.limit.enabled);
      mn.set(toUI(j.limit.min));
      mx.set(toUI(j.limit.max));
    });
    out.push(
      section(
        'Limits',
        [
          lim.el,
          h(
            'p',
            { class: 'hint-text' },
            `Measured from the pose when the simulation starts (positive ${j0.type === 'hinge' ? 'rotation follows the right-hand rule about the axis' : 'travel is along the axis'}).`,
          ),
          row('Min', mn.el),
          row('Max', mx.el),
          ...referenceRows(),
        ],
        { id: 'joint-limits' },
      ),
    );
    out.push(motorSection(ctx, id, j0.type));
  }

  // ---- spring / rope ------------------------------------------------------------------------
  if (j0.type === 'spring') {
    const setS = (label: string, p: Partial<JointEntity['spring']>) =>
      edit(label, (j) => ({ spring: { ...j.spring, ...p } }));
    const rest = numberField({
      step: 0.05,
      min: 0,
      unit: 'm',
      ...grouped('Edit rest length'),
      onChange: (v) => setS('Edit rest length', { restLength: v }),
    });
    const k = sliderField({
      min: 1,
      max: 1e6,
      log: true,
      unit: 'N/m',
      digits: 0,
      ...grouped('Edit stiffness'),
      onChange: (v) => setS('Edit stiffness', { stiffness: Math.round(v) }),
    });
    const c = sliderField({
      min: 0.01,
      max: 1e5,
      log: true,
      unit: 'N·s/m',
      digits: 2,
      ...grouped('Edit damping'),
      onChange: (v) => setS('Edit damping', { damping: v }),
    });
    const br = numberField({
      step: 100,
      min: 0,
      unit: 'N',
      digits: 0,
      ...grouped('Edit break force'),
      onChange: (v) => setS('Edit break force', { breakForce: v }),
    });
    ctx.updaters.push(() => {
      const s = get().spring;
      rest.set(s.restLength);
      k.set(s.stiffness);
      c.set(Math.max(0.01, s.damping));
      br.set(s.breakForce);
    });
    const crit = h('span', { class: 'readout', style: { fontSize: '11.5px', color: 'var(--text-3)' } });
    ctx.updaters.push(() => {
      const s = get().spring;
      const ma = get().bodyB ? (app.sim.client.info.mass[get().bodyB!] ?? 0) : 0;
      crit.textContent =
        ma > 0
          ? `Critical damping ≈ ${fmt(2 * Math.sqrt(s.stiffness * ma), 1)} N·s/m · period ≈ ${fmt(2 * Math.PI * Math.sqrt(ma / s.stiffness), 2)} s`
          : '';
    });
    out.push(
      section(
        'Spring',
        [
          row('Rest length', rest.el),
          row('Stiffness k', k.el),
          row('Damping c', c.el),
          crit,
          row('Break force', br.el, 'The spring snaps when its force exceeds this. 0 = unbreakable'),
          h(
            'p',
            { class: 'hint-text' },
            'Force = k·(length − rest) + c·(relative speed). Very stiff springs act like rigid struts and can be used to build trusses; give them a break force to make them fail.',
          ),
        ],
        { id: 'joint-spring' },
      ),
    );
  }
  if (j0.type === 'rope') {
    const len = numberField({
      step: 0.05,
      min: 0.05,
      unit: 'm',
      ...grouped('Edit rope length'),
      onChange: (v) => edit('Edit rope length', () => ({ ropeLength: v })),
    });
    ctx.updaters.push(() => len.set(get().ropeLength));
    out.push(
      section(
        'Rope',
        [
          row('Max length', len.el, 'The ends can come closer, but never further apart than this'),
          button(
            'Match current distance',
            () => {
              const f = app.joints.frameOf(get(), { a: new Vector3(), b: new Vector3(), axis: new Vector3() });
              if (f) edit('Rope length', () => ({ ropeLength: Math.max(0.05, f.a.distanceTo(f.b)) }));
            },
            { cls: 'small' },
          ),
        ],
        { id: 'joint-rope' },
      ),
    );
  }

  // -- JT-B: breakage thresholds and load readout (springs keep their own break force) --
  if (j0.type !== 'spring') out.push(breakageSection(ctx, id));

  // ---- live ---------------------------------------------------------------------------------
  if (app.sim.active) {
    const defs = liveDefs(j0.type);
    const dl = h('dl', { class: 'readout' });
    const r: Partial<Record<'value' | 'speed' | 'force', HTMLElement>> = {};
    for (const d of defs) {
      const dd = h('dd', null, '—');
      r[d.key] = dd;
      dl.append(h('dt', null, d.label), dd);
    }
    ctx.live.push(() => {
      const s = app.liveJoint(id);
      if (!s) return;
      for (const d of defs) {
        const el = r[d.key];
        if (el) el.textContent = s.broken ? 'broken' : d.format(s[d.key]);
      }
    });
    if (defs.length) out.push(section('Live', [dl], { id: 'live', badge: 'LIVE' }));
  }
  return out;
}

function motorSection(ctx: InspectorContext, id: string, type: string): HTMLElement {
  const { app } = ctx;
  const get = () => app.store.joint(id)!;
  const hinge = type === 'hinge';
  const uv = hinge ? 'rad/s' : 'm/s';
  const up = hinge ? '°' : 'm';
  const setM = (label: string, p: Partial<JointEntity['motor']>) =>
    app.store.update(id, { motor: { ...get().motor, ...p } }, label);
  const mode = segmented<MotorMode>({
    options: [
      { value: 'off', label: 'Off', title: 'Joint moves freely' },
      { value: 'velocity', label: 'Velocity', title: 'Drive toward a target speed (wheels, conveyors, winches)' },
      {
        value: 'position',
        label: 'Position',
        title: 'Spring toward a target position (servos, suspension, steering)',
      },
    ],
    onChange: (v) => setM('Motor mode', { mode: v }),
  });
  const tv = numberField({
    step: 0.5,
    unit: uv,
    digits: 2,
    ...ctx.grouped('Edit motor'),
    onChange: (v) => setM('Edit motor', { targetVelocity: v }),
  });
  const tp = numberField({
    step: hinge ? 5 : 0.05,
    unit: up,
    digits: 2,
    ...ctx.grouped('Edit motor'),
    onChange: (v) => setM('Edit motor', { targetPosition: hinge ? v * DEG : v }),
  });
  const stiff = sliderField({
    min: 1,
    max: 1e7,
    log: true,
    unit: hinge ? 'N·m/rad' : 'N/m',
    digits: 0,
    ...ctx.grouped('Edit motor'),
    onChange: (v) => setM('Edit motor', { stiffness: Math.round(v) }),
  });
  const damp = sliderField({
    min: 0.1,
    max: 1e6,
    log: true,
    unit: hinge ? 'N·m·s/rad' : 'N·s/m',
    digits: 1,
    ...ctx.grouped('Edit motor'),
    onChange: (v) => setM('Edit motor', { damping: v }),
  });
  const maxF = sliderField({
    min: 1,
    max: 1e7,
    log: true,
    unit: hinge ? 'N·m' : 'N',
    digits: 0,
    ...ctx.grouped('Edit motor'),
    onChange: (v) => setM('Edit motor', { maxForce: Math.round(v) }),
  });
  const kp = keyField({ onChange: (c) => setM('Motor key', { keyPos: c }), placeholder: 'None' });
  const kn = keyField({ onChange: (c) => setM('Motor key', { keyNeg: c }), placeholder: 'None' });
  // -- CM-A: analog axis name (gamepad stick, touch joystick, ramped keys) --
  const axisInput = h('input', {
    class: 'plain comp-text',
    type: 'text',
    spellcheck: false,
    maxLength: 40,
    placeholder: 'e.g. steer, drive',
    title: 'Analog input axis: gamepad sticks, touch joysticks and the ramped keys above all drive this name',
  });
  axisInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') axisInput.blur();
  });
  axisInput.addEventListener('change', () => setM('Motor axis', { axis: axisInput.value.trim() }));
  const slew = numberField({
    step: 0.5,
    min: 0,
    unit: hinge ? 'rad/s' : 'm/s',
    digits: 2,
    ...ctx.grouped('Edit motor'),
    onChange: (v) => setM('Edit motor', { slewRate: v }),
  });
  const brake = toggleField({
    label: 'Hold position when no key is pressed',
    onChange: (v) => setM('Motor brake', { brake: v }),
  });

  const rowVel = row('Target speed', tv.el, 'Speed reached at full input');
  const rowPos = row('Target', tp.el, 'With keys bound this is the deflection at full input');
  const rowStiff = row('Stiffness', stiff.el);
  const rowDamp = row('Damping', damp.el, 'Velocity mode: how hard it pushes toward the target speed');
  const rowSlew = row('Slew rate', slew.el, 'How fast the target moves while a key is held');
  const rowBrake = brake.el;
  ctx.updaters.push(() => {
    const m = get().motor;
    mode.set(m.mode);
    tv.set(m.targetVelocity);
    tp.set(hinge ? m.targetPosition * RAD : m.targetPosition);
    stiff.set(m.stiffness);
    damp.set(m.damping);
    maxF.set(m.maxForce);
    kp.set(m.keyPos);
    kn.set(m.keyNeg);
    if (document.activeElement !== axisInput) axisInput.value = m.axis ?? '';
    slew.set(m.slewRate);
    brake.set(m.brake);
    const off = m.mode === 'off';
    rowVel.style.display = m.mode === 'velocity' ? '' : 'none';
    rowPos.style.display = m.mode === 'position' ? '' : 'none';
    rowStiff.style.display = m.mode === 'position' ? '' : 'none';
    rowSlew.style.display = m.mode === 'position' ? '' : 'none';
    rowBrake.style.display = m.mode === 'velocity' ? '' : 'none';
    rowDamp.style.display = off ? 'none' : '';
    for (const el of [rowMax, rowKp, rowKn, rowAxis]) el.style.display = off ? 'none' : '';
  });
  const rowMax = row('Max force', maxF.el, 'Largest force / torque the motor can apply');
  const rowKp = row(
    'Key (+)',
    kp.el,
    hinge ? 'Positive rotation follows the right-hand rule about the axis' : 'Positive = along the axis',
  );
  const rowKn = row('Key (−)', kn.el);
  const rowAxis = row(
    'Analog axis',
    axisInput,
    'Name of an analog input (−1 … 1) added to the keys: a gamepad stick or touch joystick. With the keys above, the keys ramp up like a stick.',
  );
  return section(
    'Motor',
    [
      rowStack('Mode', mode.el),
      rowVel,
      rowPos,
      rowStiff,
      rowDamp,
      rowMax,
      rowKp,
      rowKn,
      rowAxis,
      rowSlew,
      rowBrake,
      h(
        'p',
        { class: 'hint-text' },
        'Bind keys to drive the motor while the simulation runs: velocity mode for wheels and winches, position mode for steering and servos. Without keys the motor is always on.',
      ),
    ],
    { id: 'joint-motor' },
  );
}
