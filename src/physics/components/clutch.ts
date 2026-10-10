/**
 * Runtime of the `clutch` component (definition: `src/model/components/clutch.ts`): a bounded coupling row between the
 * two shafts, `ω_in = ω_out` with |T| ≤ capacity·engagement. Within the capacity the shafts lock exactly (the
 * engine and the gearbox input turn as one); beyond it the row saturates and the plates slip, transmitting the
 * capacity torque — which is how a car pulls away with the engine above the wheel speed.
 */
import { clamp } from '../../core/math';
import type { Row } from './drive/network';
import { approach, pedal, toRpm } from './powered/common';
import type { ComponentRuntime } from './registry';

interface State {
  /** Pedal engagement, 0 … 1 (the centrifugal factor comes on top). */
  engagement: number;
  /** Engagement actually transmitted: pedal × centrifugal. */
  grip: number;
  row: Row | null;
}

export const clutch: ComponentRuntime<State> = {
  type: 'clutch',
  create: (ctx) => ({ engagement: ctx.num('engaged'), grip: ctx.num('engaged'), row: null }),
  paramsChanged: (_s, ctx) => ctx.drive.releaseAll(),
  prestep(s, dt, ctx) {
    const a = ctx.drive.shaft(ctx.str('in'));
    const b = ctx.drive.shaft(ctx.str('out'));
    // a centrifugal clutch bites as the input speeds up: nothing at the engage speed, everything at the lock speed
    let centrifugal = 1;
    if (ctx.bool('centrifugal')) {
      const lo = ctx.num('engageRpm');
      centrifugal = clamp((toRpm(a.omega) - lo) / Math.max(1, ctx.num('lockRpm') - lo), 0, 1);
    }
    const target = ctx.num('engaged') * (1 - clamp(pedal(ctx, 'key', 'axis', 0), 0, 1));
    s.engagement = approach(s.engagement, target, ctx.num('response'), dt);
    s.row = a === b ? null : ctx.drive.couple(a, b, ctx.num('maxTorque') * s.engagement * centrifugal);
    s.grip = s.engagement * centrifugal;
  },
  poststep(s, _dt, ctx) {
    const a = ctx.drive.shaft(ctx.str('in'));
    const b = ctx.drive.shaft(ctx.str('out'));
    const locked = !!s.row && s.grip > 0.999 && !s.row.saturated;
    ctx.state.set([s.grip * 100, toRpm(a.omega - b.omega), s.row?.torque ?? 0, locked ? 1 : 0]);
  },
  saveState: (s) => ({ engagement: s.engagement }),
  loadState(s, data) {
    const d = data as Partial<State> | null;
    if (d) s.engagement = d.engagement ?? s.engagement;
  },
};
