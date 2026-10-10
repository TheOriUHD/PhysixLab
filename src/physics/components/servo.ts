/**
 * Runtime of the `servo` component (definition: `src/model/components/servo.ts`): a cascade position loop on a hinge
 * (see `powered/position.ts`). The target is held in the component's state; editing the target field while running
 * moves it, jog keys slew it, and an analog axis replaces it with a position inside the travel range.
 */
import { clamp, lerp } from '../../core/math';
import { DEG } from './powered/common';
import { positionRow, type PositionLoop } from './powered/position';
import type { Row } from './drive/network';
import type { ComponentRuntime } from './registry';

interface State extends PositionLoop {
  /** Commanded angle, rad. */
  target: number;
  /** The `target` field as last seen (an edit of the field restarts the target). */
  seen: number;
  row: Row | null;
}

export const servo: ComponentRuntime<State> = {
  type: 'servo',
  create: (ctx) => ({ target: ctx.num('target') * DEG, seen: ctx.num('target'), integral: 0, row: null }),
  paramsChanged: () => undefined,
  prestep(state, dt, ctx) {
    state.row = null;
    const sh = ctx.drive.own();
    if (!sh || sh.kind !== 'rot') return;
    const lo = ctx.num('minAngle') * DEG;
    const hi = ctx.num('maxAngle') * DEG;
    const field = ctx.num('target');
    if (field !== state.seen) {
      state.seen = field;
      state.target = field * DEG;
    }
    const axis = ctx.str('axis');
    if (axis) {
      state.target = lerp(lo, hi, (clamp(ctx.input.axis(axis), -1, 1) + 1) / 2);
    } else {
      const plus = ctx.str('keyPlus');
      const minus = ctx.str('keyMinus');
      const dir = (plus && ctx.input.key(plus) ? 1 : 0) - (minus && ctx.input.key(minus) ? 1 : 0);
      if (dir) state.target += dir * ctx.num('jogRate') * DEG * dt;
    }
    state.target = clamp(state.target, lo, hi);
    state.row = positionRow(
      ctx.drive,
      sh,
      state.target,
      {
        kp: ctx.num('kp'),
        ki: ctx.num('ki'),
        kd: ctx.num('kd'),
        vmax: ctx.num('maxSpeed') * DEG,
        fmax: ctx.num('maxTorque'),
      },
      state,
      dt,
    );
  },
  poststep(state, _dt, ctx) {
    const sh = ctx.drive.own();
    if (!sh) return ctx.state.set([0, 0, 0, 0]); // not on a hinge: the inspector warns; the gauges read zero
    ctx.state.set([sh.position / DEG, state.target / DEG, sh.speed / DEG, state.row?.torque ?? 0]);
  },
  saveState: (s) => ({ target: s.target, seen: s.seen, integral: s.integral }),
  loadState(s, data) {
    const d = data as Partial<State> | null;
    if (!d) return;
    s.target = d.target ?? s.target;
    s.seen = d.seen ?? s.seen;
    s.integral = d.integral ?? 0;
  },
};
