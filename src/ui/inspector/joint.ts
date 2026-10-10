/** Inspector sections for a joint: connection, anchors and axis, limits, motor, spring / rope settings, live readout. */
import { Vector3 } from 'three';
import { DEG, RAD, vlen } from '../../core/math';
import type { Vec3 } from '../../core/math';
import { JOINT_TYPE_LABELS } from '../../model/factory';
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
  const isUnit = j0.type === 'hinge' || j0.type === 'slider';
  const isTether = j0.type === 'spring' || j0.type === 'rope';
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
      app.store.update(
        id,
        { bodyA: j.bodyB, bodyB: j.bodyA, anchorA: j.anchorB, anchorB: j.anchorA },
        'Swap joint ends',
      );
    },
    {
      cls: 'small',
      title: 'Swap which body is the parent. Anchors swap with it; for hinges / sliders re-check the axis.',
    },
  );
  swap.disabled = !isTether;
  out.push(
    section(
      'Connection',
      [
        row('Type', h('span', { class: 'readout' }, JOINT_TYPE_LABELS[j0.type])),
        row('Body A', link('A')),
        row('Body B', link('B')),
        isTether ? row('', swap) : h('span'),
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
  if (isTether) {
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
  if (isUnit) {
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
        'Axis (unit vector)',
        bind(axis, (j) => j.axis),
        'Local to body A (world if A is the world)',
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

  // ---- limits -------------------------------------------------------------------------------
  if (isUnit) {
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

  // ---- live ---------------------------------------------------------------------------------
  if (app.sim.active) {
    const dl = h('dl', { class: 'readout' });
    const r: Record<string, HTMLElement> = {};
    const defs: [string, string][] =
      j0.type === 'hinge'
        ? [
            ['value', 'Angle'],
            ['speed', 'Speed'],
          ]
        : j0.type === 'slider'
          ? [
              ['value', 'Position'],
              ['speed', 'Speed'],
            ]
          : j0.type === 'spring'
            ? [
                ['value', 'Length'],
                ['speed', 'Rate'],
                ['force', 'Force'],
              ]
            : j0.type === 'rope'
              ? [['value', 'Distance']]
              : [];
    for (const [k, label] of defs) {
      const dd = h('dd', null, '—');
      r[k] = dd;
      dl.append(h('dt', null, label), dd);
    }
    ctx.live.push(() => {
      const s = app.liveJoint(id);
      if (!s) return;
      if (s.broken) {
        for (const k of Object.keys(r)) r[k].textContent = 'broken';
        return;
      }
      if (r.value) r.value.textContent = j0.type === 'hinge' ? `${fmt(s.value * RAD, 1)}°` : `${fmt(s.value, 3)} m`;
      if (r.speed)
        r.speed.textContent =
          j0.type === 'hinge'
            ? `${fmt(s.speed, 2)} rad/s (${fmt((s.speed * 60) / (2 * Math.PI), 1)} rpm)`
            : `${fmt(s.speed, 3)} m/s`;
      if (r.force) r.force.textContent = `${fmt(s.force, 1)} N ${s.force > 0 ? '(tension)' : '(compression)'}`;
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
    if (document.activeElement !== axisInput) axisInput.value = m.axis;
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
