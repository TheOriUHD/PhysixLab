/**
 * Runtime of the `jet` component (definition: `src/model/components/jet.ts`).
 *
 * The engine speed N follows the throttle with a first-order lag (spool time); thrust is
 * F = F_dry·N·(1 + (boost − 1)·afterburner)·(1 − (v/v_max)²), v being the airspeed along the thrust direction.
 * The afterburner needs the engine near full speed. Fuel (if any) is part of the body's mass and burns at
 * sfc·F per second, three times that with the afterburner lit.
 */
import { clamp, vdot, vscale } from '../../core/math';
import { Fuel } from './powered/fuel';
import { approach, pedal } from './powered/common';
import { nozzleOf } from './powered/nozzle';
import type { ComponentRuntime } from './registry';

interface State {
  n: number;
  ab: boolean;
  fuel: Fuel;
  thrust: number;
  speed: number;
  seenTank: number;
}

export const jet: ComponentRuntime<State> = {
  type: 'jet',
  create(ctx) {
    const fuel = new Fuel();
    fuel.attach(ctx.body, ctx.num('fuelMass'));
    return { n: 0, ab: false, fuel, thrust: 0, speed: 0, seenTank: ctx.num('fuelMass') };
  },
  paramsChanged(s, ctx) {
    const tank = ctx.num('fuelMass');
    if (tank !== s.seenTank) {
      s.seenTank = tank;
      s.fuel.detach(ctx.body);
      s.fuel.attach(ctx.body, tank);
    }
  },
  dispose(s, ctx) {
    s.fuel.detach(ctx.body);
  },
  prestep(s, dt, ctx) {
    const body = ctx.body;
    s.thrust = 0;
    if (!body || body.type !== 'dynamic') return;
    const unlimited = ctx.num('fuelMass') <= 0;
    const dry = !unlimited && s.fuel.left <= 0; // flame-out
    const target = dry ? 0 : clamp(pedal(ctx, 'key', 'axis', ctx.num('throttle')), 0, 1);
    s.n = approach(s.n, target, ctx.num('spool'), dt);
    s.ab = !dry && s.n > 0.9 && pedal(ctx, 'abKey', 'abAxis', 0) > 0.5;
    if (s.n < 1e-4) {
      s.n = 0;
      return;
    }
    const nz = nozzleOf(ctx, body);
    s.speed = vdot(body.linvel(), nz.dir);
    const fade = clamp(1 - (s.speed / ctx.num('maxSpeed')) ** 2, 0, 1);
    let force = ctx.num('thrust') * s.n * (s.ab ? ctx.num('afterburner') : 1) * fade;
    if (!unlimited) {
      const plan = (ctx.num('sfc') / 1e6) * force * (s.ab ? 3 : 1) * dt; // g/(kN·s) → kg/(N·s)
      const burned = s.fuel.begin(body, plan);
      if (plan > 0) force *= burned / plan;
    }
    body.applyForce(vscale(nz.dir, force), nz.at);
    s.thrust = force;
  },
  poststep(s, _dt, ctx) {
    s.fuel.finish(ctx.body);
    ctx.state.set([s.thrust, s.n * 100, s.ab ? 1 : 0, s.fuel.left, s.speed]);
  },
  saveState: (s) => ({ seenTank: s.seenTank, n: s.n, ab: s.ab, fuel: s.fuel.save() }),
  loadState(s, data, ctx) {
    const d = data as { seenTank?: number; n?: number; ab?: boolean; fuel?: { left?: number; added?: number } } | null;
    if (!d) return;
    s.fuel.restore(ctx.body, d.fuel ?? null);
    s.seenTank = d.seenTank ?? s.seenTank;
    s.n = d.n ?? 0;
    s.ab = d.ab ?? false;
  },
};
