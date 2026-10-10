/**
 * Runtime of the `hydraulicCylinder` component (definition: `src/model/components/hydraulicCylinder.ts`).
 *
 * The pump delivers pressure P and flow Q. With the proportional valve open by u ∈ [−1, 1] the piston is driven at
 * u·Q/A (A = the area oil acts on: the bore area when extending, the bore minus rod area when retracting) with a force
 * of at most |u|·P·A: a `drive` row of the network, exact while the load is within the force, saturated (the piston
 * stalls and is pushed back) beyond it. With the valve centred the trapped oil holds the load, up to the relief
 * pressure, or — open centre — lets it move. The stroke ends are hard stops.
 */
import { clamp } from '../../core/math';
import { signed } from './powered/common';
import { HOLD_GAIN } from './powered/position';
import type { ComponentRuntime } from './registry';

interface State {
  /** Speed the motor was told to hold, m/s, and its force limit, N (0 = motor off). */
  command: number;
  cap: number;
  area: number;
  /** Stroke at the end of the previous step, for the mean speed the gauge shows. */
  last: number;
}

const BAR = 1e5;

export const hydraulicCylinder: ComponentRuntime<State> = {
  type: 'hydraulicCylinder',
  create: () => ({ command: 0, cap: 0, area: 1, last: NaN }),
  paramsChanged: () => undefined,
  // -- TM: the stroke at the end of the previous step (the gauge's speed is its difference); the rest is recomputed every step --
  saveState: (s) => s.last,
  loadState: (s, d) => void (s.last = typeof d === 'number' ? d : NaN),
  dispose(_s, ctx) {
    const sh = ctx.drive.own();
    sh?.motorOff();
    sh?.travel(null, null);
  },
  prestep(s, _dt, ctx) {
    s.cap = 0;
    const sh = ctx.drive.own();
    if (!sh || sh.kind !== 'lin') return;
    const bore = ctx.num('bore') / 1000;
    const rod = ctx.num('rod') / 1000;
    const aBore = (Math.PI / 4) * bore * bore;
    const aRet = Math.max(1e-9, aBore - (Math.PI / 4) * rod * rod);
    const p = ctx.num('pressure') * BAR;
    const q = ctx.num('flow') / 60000; // L/min → m³/s
    const u = signed(ctx, 'key', 'keyReverse', 'axis', 0);
    if (Math.abs(u) > 1e-3) {
      const area = u > 0 ? aBore : aRet;
      s.area = area;
      s.command = (u * q) / area;
      s.cap = Math.abs(u) * p * area;
    } else if (ctx.str('idle') === 'hold') {
      s.area = aRet;
      s.command = 0;
      s.cap = ctx.num('relief') * BAR * aRet;
    }
    // The oil is the engine's own joint motor: it follows the valve's speed with at most the pressure's force, and
    // with the valve centred it holds the load (or, open centre, lets go). Being part of the constraint solve it moves
    // the whole mechanism the cylinder pushes — a boom, a payload — not just the two bodies it joins.
    if (s.cap > 0) sh.motorVelocity(s.command, HOLD_GAIN.lin, s.cap);
    else sh.motorOff();
    sh.travel(ctx.num('min'), ctx.num('max')); // the ends of the stroke are hard stops
  },
  poststep(s, dt, ctx) {
    const sh = ctx.drive.own();
    if (!sh) return ctx.state.set([0, 0, 0, 0]);
    const x = sh.position;
    // the displacement over the step is the speed that matters (the end-of-step speed differs by what gravity added)
    const speed = Number.isNaN(s.last) ? 0 : (x - s.last) / dt;
    s.last = x;
    // the force the motor delivered: gain × (commanded − actual speed), which saturates at the pressure's limit
    const f = s.cap > 0 ? clamp(HOLD_GAIN.lin * (s.command - sh.speed), -s.cap, s.cap) : 0;
    ctx.state.set([x * 1000, speed * 1000, f, clamp(Math.abs(f) / s.area / BAR, 0, 1e6)]);
  },
};
