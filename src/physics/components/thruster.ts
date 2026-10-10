/**
 * Runtime of the `thruster` component (definition: `src/model/components/thruster.ts`).
 *
 * Thrust F = F_max·throttle pushes the body along `direction` at the nozzle point. With fuel, mass flows out at
 * ṁ = (fuel mass ÷ burn time)·throttle, so the exhaust speed v_e = F/ṁ is constant and the body obeys the rocket
 * equation Δv = v_e·ln(m₀/m₁): the fuel is added to the body's mass when the component starts and removed as it
 * burns (see `powered/fuel.ts`). A liquid motor follows its throttle (key, axis or the fixed setting); a solid motor
 * lights once and runs at full thrust until the fuel is gone. Events `ignite` and `burnout` are raised for sound and
 * particle effects; the published thrust level drives the flame the viewport draws.
 */
import { clamp, vscale } from '../../core/math';
import { Fuel } from './powered/fuel';
import { approach, hasControl, pedal } from './powered/common';
import { nozzleOf } from './powered/nozzle';
import type { ComponentRuntime } from './registry';

interface State {
  thr: number;
  lit: boolean;
  burning: boolean;
  burnedOut: boolean;
  fuel: Fuel;
  thrust: number;
  /** The `fuelMass` field as last seen: a change of it is a refuel. */
  seenTank: number;
}

export const thruster: ComponentRuntime<State> = {
  type: 'thruster',
  create(ctx) {
    const fuel = new Fuel();
    fuel.attach(ctx.body, ctx.num('fuelMass'));
    return {
      thr: 0,
      lit: !hasControl(ctx),
      burning: false,
      burnedOut: false,
      fuel,
      thrust: 0,
      seenTank: ctx.num('fuelMass'),
    };
  },
  paramsChanged(s, ctx) {
    // a changed tank size is a refuel; everything else (thrust, direction …) is read fresh each step
    const tank = ctx.num('fuelMass');
    if (tank !== s.seenTank) {
      s.seenTank = tank;
      s.fuel.detach(ctx.body);
      s.fuel.attach(ctx.body, tank);
      s.burnedOut = false;
    }
  },
  dispose(s, ctx) {
    s.fuel.detach(ctx.body);
  },
  prestep(s, dt, ctx) {
    const body = ctx.body;
    s.thrust = 0;
    if (!body || body.type !== 'dynamic') {
      s.thr = 0;
      return;
    }
    const unlimited = ctx.num('fuelMass') <= 0;
    const out = !unlimited && s.fuel.left <= 0;
    // ---- throttle ----
    let target: number;
    if (ctx.str('mode') === 'solid') {
      // ignition: a key press / the axis passing 0.5 / the start (no controls)
      if (!s.lit && !out && pedal(ctx, 'key', 'axis', 1) > 0.5) s.lit = true;
      target = s.lit && !out ? 1 : 0;
    } else target = out ? 0 : clamp(pedal(ctx, 'key', 'axis', ctx.num('throttle')), 0, 1);
    s.thr = approach(s.thr, target, ctx.num('ramp'), dt);
    if (s.thr < 1e-4) s.thr = 0;
    if (s.thr <= 0) return;
    // ---- fuel and force ----
    const full = ctx.num('thrust');
    let force = full * s.thr;
    if (!unlimited) {
      const plan = (ctx.num('fuelMass') / ctx.num('burnTime')) * s.thr * dt;
      const burned = s.fuel.begin(body, plan);
      if (plan > 0) force *= burned / plan; // the last drops: a part-step of thrust
    }
    const n = nozzleOf(ctx, body);
    body.applyForce(vscale(n.dir, force), n.at);
    s.thrust = force;
  },
  poststep(s, _dt, ctx) {
    const body = ctx.body;
    s.fuel.finish(body);
    const unlimited = ctx.num('fuelMass') <= 0;
    const burning = s.thrust > 0;
    if (burning && !s.burning) ctx.emit('ignite', { thrust: s.thrust });
    if (!burning && s.burning && !unlimited && s.fuel.left <= 0 && !s.burnedOut) {
      s.burnedOut = true;
      ctx.emit('burnout', { mass: body?.mass ?? 0 });
    }
    s.burning = burning;
    const mdot = unlimited ? 0 : ctx.num('fuelMass') / ctx.num('burnTime');
    ctx.state.set([s.thrust, s.thr * 100, s.fuel.left, body?.mass ?? 0, mdot > 0 ? ctx.num('thrust') / mdot : 0]);
  },
  saveState: (s) => ({
    seenTank: s.seenTank,
    thr: s.thr,
    lit: s.lit,
    burning: s.burning,
    burnedOut: s.burnedOut,
    fuel: s.fuel.save(),
  }),
  loadState(s, data, ctx) {
    const d = data as {
      seenTank?: number;
      thr?: number;
      lit?: boolean;
      burning?: boolean;
      burnedOut?: boolean;
      fuel?: { left?: number; added?: number };
    } | null;
    if (!d) return;
    s.fuel.restore(ctx.body, d.fuel ?? null);
    s.seenTank = d.seenTank ?? s.seenTank;
    s.thr = d.thr ?? 0;
    s.lit = d.lit ?? s.lit;
    s.burning = d.burning ?? false;
    s.burnedOut = d.burnedOut ?? false;
  },
};
