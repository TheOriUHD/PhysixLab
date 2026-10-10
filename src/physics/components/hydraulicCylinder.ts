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
import type { Row } from './drive/network';
import { signed } from './powered/common';
import type { ComponentRuntime } from './registry';

interface State {
  row: Row | null;
  area: number;
  valve: number;
  /** Stroke at the end of the previous step, for the mean speed the gauge shows. */
  last: number;
}

const BAR = 1e5;

export const hydraulicCylinder: ComponentRuntime<State> = {
  type: 'hydraulicCylinder',
  create: () => ({ row: null, area: 1, valve: 0, last: NaN }),
  paramsChanged: () => undefined,
  prestep(s, dt, ctx) {
    s.row = null;
    const sh = ctx.drive.own();
    if (!sh || sh.kind !== 'lin') return;
    const bore = ctx.num('bore') / 1000;
    const rod = ctx.num('rod') / 1000;
    const aBore = (Math.PI / 4) * bore * bore;
    const aRet = Math.max(1e-9, aBore - (Math.PI / 4) * rod * rod);
    const p = ctx.num('pressure') * BAR;
    const q = ctx.num('flow') / 60000; // L/min → m³/s
    const u = signed(ctx, 'key', 'keyReverse', 'axis', 0);
    s.valve = u;
    if (Math.abs(u) > 1e-3) {
      const area = u > 0 ? aBore : aRet;
      s.area = area;
      s.row = ctx.drive.drive(sh, (u * q) / area, Math.abs(u) * p * area);
    } else if (ctx.str('idle') === 'hold') {
      s.area = aRet;
      s.row = ctx.drive.drive(sh, 0, ctx.num('relief') * BAR * aRet);
    }
    const x = sh.position;
    ctx.drive.limit(sh, (ctx.num('max') - x) / dt, 1, 1e9);
    ctx.drive.limit(sh, (ctx.num('min') - x) / dt, -1, 1e9);
  },
  poststep(s, dt, ctx) {
    const sh = ctx.drive.own();
    if (!sh) return ctx.state.set([0, 0, 0, 0]);
    const f = s.row?.torque ?? 0;
    const x = sh.position;
    // the displacement over the step is the speed that matters (the engine's end-of-step speed differs by what
    // gravity added inside the step)
    const speed = Number.isNaN(s.last) ? 0 : (x - s.last) / dt;
    s.last = x;
    ctx.state.set([x * 1000, speed * 1000, f, clamp(Math.abs(f) / s.area / BAR, 0, 1e6)]);
  },
};
