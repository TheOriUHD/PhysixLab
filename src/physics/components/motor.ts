/**
 * Runtime of the `motor` component (definition: `src/model/components/motor.ts`).
 *
 * A permanent-magnet DC motor: T = T_stall·(u − ω/ω_free), where u ∈ [−1, 1] is the drive command. The back-EMF term
 * is exactly linear in ω, so it is registered as an implicit damper (`b = T_stall/ω_free`) and stays stable however
 * light the rotor is. The supply caps the torque (current limit, optional power limit); with the command at zero the
 * motor either brakes (the same law with u = 0) or coasts.
 */
import { clamp } from '../../core/math';
import type { Shaft } from './drive/network';
import { fromRpm, signed, toRpm } from './powered/common';
import type { ComponentRuntime } from './registry';

interface State {
  torque: number;
  u: number;
  started: boolean;
}

export const motor: ComponentRuntime<State> = {
  type: 'motor',
  create: () => ({ torque: 0, u: 0, started: false }),
  paramsChanged: (_s, ctx) => ctx.drive.releaseAll(),
  prestep(state, _dt, ctx) {
    const direct = ctx.ownerKind === 'joint';
    const own = direct ? ctx.drive.own() : null;
    const rotor: Shaft = ctx.drive.shaft(direct ? `~${ctx.componentId}` : ctx.str('out'));
    const ratio = ctx.num('ratio') * (ctx.bool('invert') ? -1 : 1);
    if (!state.started) {
      state.started = true;
      if (own) rotor.omega = own.speed * ratio;
    }
    ctx.drive.inertia(rotor, ctx.num('inertia'));
    const u = signed(ctx, 'key', 'keyReverse', 'axis', ctx.num('duty'));
    state.u = u;
    const w = rotor.omega;
    const stall = ctx.num('stallTorque');
    const wFree = fromRpm(ctx.num('noLoadRpm'));
    const coast = ctx.str('idle') === 'coast' && u === 0;
    let limit = Math.min(stall, ctx.num('currentLimit'));
    const power = ctx.num('powerLimit');
    if (power > 0) limit = Math.min(limit, power / Math.max(Math.abs(w), 1));
    const t = coast ? 0 : stall * (u - w / wFree);
    if (!coast && Math.abs(t) <= limit) {
      // inside the supply limit the law is linear in ω: take the back-EMF term implicitly
      ctx.drive.torque(rotor, stall * u, stall / wFree);
      state.torque = t;
    } else {
      const c = clamp(t, -limit, limit);
      ctx.drive.torque(rotor, c);
      state.torque = c;
    }
    if (own) ctx.drive.gear(rotor, own, ratio);
  },
  poststep(state, _dt, ctx) {
    const direct = ctx.ownerKind === 'joint';
    const rotor = ctx.drive.shaft(direct ? `~${ctx.componentId}` : ctx.str('out'));
    const w = rotor.omega;
    ctx.state.set([toRpm(w), state.torque, state.u * 100, state.torque * w]);
  },
  saveState: (s) => ({ torque: s.torque, u: s.u }),
  loadState(s, data) {
    const d = data as Partial<State> | null;
    if (d) {
      s.torque = d.torque ?? 0;
      s.u = d.u ?? 0;
    }
    s.started = true;
  },
};
