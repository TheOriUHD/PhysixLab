/**
 * Runtime of the `linearActuator` component (definition: `src/model/components/linearActuator.ts`): the cascade
 * position loop of `powered/position.ts` on a slider, plus end stops at the travel limits (one-sided rows that only
 * act when the stroke would be exceeded).
 */
import { clamp, lerp } from '../../core/math';
import { followTarget } from './powered/position';
import type { ComponentRuntime } from './registry';

interface State {
  target: number;
  seen: number;
  integral: number;
  /** Force the motor is estimated to deliver, N. */
  force: number;
}

export const linearActuator: ComponentRuntime<State> = {
  type: 'linearActuator',
  create: (ctx) => ({ target: ctx.num('target'), seen: ctx.num('target'), integral: 0, force: 0 }),
  dispose(_s, ctx) {
    const sh = ctx.drive.own();
    sh?.motorOff();
    sh?.travel(null, null);
  },
  paramsChanged: () => undefined,
  prestep(s, dt, ctx) {
    const sh = ctx.drive.own();
    if (!sh || sh.kind !== 'lin') return;
    const lo = ctx.num('min');
    const hi = ctx.num('max');
    const field = ctx.num('target');
    if (field !== s.seen) {
      s.seen = field;
      s.target = field;
    }
    const axis = ctx.str('axis');
    if (axis) s.target = lerp(lo, hi, (clamp(ctx.input.axis(axis), -1, 1) + 1) / 2);
    else {
      const plus = ctx.str('keyPlus');
      const minus = ctx.str('keyMinus');
      const dir = (plus && ctx.input.key(plus) ? 1 : 0) - (minus && ctx.input.key(minus) ? 1 : 0);
      if (dir) s.target += dir * ctx.num('speed') * dt;
    }
    s.target = clamp(s.target, lo, hi);
    s.force = followTarget(
      sh,
      s.target,
      { kp: ctx.num('kp'), ki: 0, kd: 0, vmax: ctx.num('speed'), fmax: ctx.num('force') },
      s,
      dt,
    ).force;
    sh.travel(lo, hi); // hard end stops at the ends of the stroke
  },
  poststep(s, _dt, ctx) {
    const sh = ctx.drive.own();
    if (!sh) return ctx.state.set([0, 0, 0, 0]);
    ctx.state.set([sh.position, s.target, sh.speed, s.force]);
  },
  saveState: (s) => ({ target: s.target, seen: s.seen }),
  loadState(s, data) {
    const d = data as Partial<State> | null;
    if (!d) return;
    s.target = d.target ?? s.target;
    s.seen = d.seen ?? s.seen;
  },
};
