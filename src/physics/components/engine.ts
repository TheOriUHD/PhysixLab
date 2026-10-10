/**
 * Runtime of the `engine` component (definition: `src/model/components/engine.ts`).
 *
 * The engine owns a flywheel (a shaft with the configured inertia). Every step it registers the torque the combustion
 * produces at the current speed and throttle — the torque curve × throttle × a soft rev-limiter, minus the closed-
 * throttle drag, plus the idle governor — as a source on that shaft, with the slope of the curve as an implicit
 * damper so the steep parts (the limiter, the falling end of the curve) can never destabilise the integration. What
 * the shaft is connected to is not the engine's business: a clutch, gearbox and differential find it by name; on a
 * hinge the engine links its flywheel to the hinge through a fixed reduction and drives it directly.
 *
 *   dω/dt = (T_engine − loads) / I_flywheel          (the loads come from whatever is connected to the shaft)
 */
import { clamp } from '../../core/math';
import type { ComponentContext } from './context';
import type { Shaft } from './drive/network';
import { approach, fromRpm, pedal, toRpm } from './powered/common';
import type { ComponentRuntime } from './registry';

interface State {
  thr: number;
  torque: number;
  started: boolean;
}

/** Net engine torque (N·m) at speed `w` (rad/s) and throttle `thr`. */
function engineTorque(ctx: ComponentContext, w: number, thr: number, direct: boolean): number {
  const rev = ctx.num('revLimit');
  const idle = ctx.num('idle');
  let rpm = toRpm(w);
  if (direct) rpm = Math.max(rpm, idle); // driving a hinge: no stalling at stand-still
  const full = ctx.curveAt('curve', Math.max(rpm, 0));
  const cut = clamp((rev - rpm) / 150, 0, 1); // fuel cut ramps in over the last 150 rpm
  const gov = direct ? 0 : clamp((idle - rpm) / 150, 0, 1); // the idle governor opens the throttle
  const t = Math.max(thr, gov);
  const drag = (1 - t) * ctx.num('braking') * clamp(rpm / rev, -1, 2);
  return t * full * cut - drag;
}

export const engine: ComponentRuntime<State> = {
  type: 'engine',
  create: () => ({ thr: 0, torque: 0, started: false }),
  paramsChanged: (_s, ctx) => ctx.drive.releaseAll(), // shaft names may have changed; re-acquired next step
  prestep(state, dt, ctx) {
    const own = ctx.ownerKind === 'joint' ? ctx.drive.own() : null;
    const direct = ctx.ownerKind === 'joint';
    // a hinge engine has a private crank; a body engine turns the shaft it names
    const crank: Shaft = ctx.drive.shaft(direct ? `~${ctx.componentId}` : ctx.str('out'));
    const ratio = ctx.num('ratio') * (ctx.bool('invert') ? -1 : 1);
    if (!state.started) {
      state.started = true;
      // start turning: at idle on a body, at the speed the hinge already has on a hinge
      if (own) crank.omega = own.speed * ratio;
      else if (crank.refs === 1) crank.omega = fromRpm(ctx.num('idle'));
    }
    ctx.drive.inertia(crank, ctx.num('inertia'));
    state.thr = approach(
      state.thr,
      clamp(pedal(ctx, 'key', 'axis', ctx.num('throttle')), 0, 1),
      ctx.num('response'),
      dt,
    );
    const w = crank.omega;
    const t = engineTorque(ctx, w, state.thr, direct);
    // implicit damper from the slope of the torque characteristic (only where it falls with speed)
    const dw = 0.5;
    const slope = (engineTorque(ctx, w + dw, state.thr, direct) - t) / dw;
    const b = Math.max(0, -slope);
    ctx.drive.torque(crank, t + b * w, b);
    state.torque = t;
    if (own) ctx.drive.gear(crank, own, ratio);
  },
  poststep(state, _dt, ctx) {
    const direct = ctx.ownerKind === 'joint';
    const crank = ctx.drive.shaft(direct ? `~${ctx.componentId}` : ctx.str('out'));
    const w = crank.omega;
    ctx.state.set([toRpm(w), state.torque, state.thr * 100, (state.torque * w) / 1000]);
  },
  saveState: (s) => ({ thr: s.thr, torque: s.torque }),
  loadState(s, data) {
    const d = data as Partial<State> | null;
    if (!d) return;
    s.thr = d.thr ?? s.thr;
    s.torque = d.torque ?? s.torque;
    s.started = true; // the shaft speed comes back with the drive network
  },
};
