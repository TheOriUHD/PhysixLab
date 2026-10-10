/**
 * Runtime of the `differential` component (definition: `src/model/components/differential.ts`).
 *
 * The carrier row `ω_in = (fd/2)·(ω_L + ω_R)` is one multiplier acting on both outputs with the same coefficient, so
 * the outputs get *equal* torque and any speed difference is free — an open differential. Locking adds the row
 * `ω_L = ω_R` (unbounded), after which the torque goes wherever the traction takes it; a limited-slip differential adds
 * the same row with a torque bound (preload plus a share of the carrier torque), so a small speed difference is
 * resisted and a large one slips at the limit.
 */
import { clamp } from '../../core/math';
import type { Row } from './drive/network';
import { UNBOUNDED } from './drive/network';
import { toRpm } from './powered/common';
import type { ComponentRuntime } from './registry';

interface State {
  carrier: Row | null;
  coupling: Row | null;
  prevTorque: number;
  locked: boolean;
}

export const differential: ComponentRuntime<State> = {
  type: 'differential',
  create: () => ({ carrier: null, coupling: null, prevTorque: 0, locked: false }),
  paramsChanged: (_s, ctx) => ctx.drive.releaseAll(),
  prestep(s, _dt, ctx) {
    s.carrier = null;
    s.coupling = null;
    const input = ctx.drive.shaft(ctx.str('in'));
    const left = ctx.drive.shaft(ctx.str('left'));
    const right = ctx.drive.shaft(ctx.str('right'));
    if (input === left || input === right || left === right) return;
    const fd = ctx.num('finalDrive');
    ctx.drive.inertia(input, ctx.num('inertia'));
    s.carrier = ctx.drive
      .row(0, -UNBOUNDED, UNBOUNDED)
      .add(input, 1)
      .add(left, -fd / 2)
      .add(right, -fd / 2);
    const key = ctx.str('lockKey');
    const mode = ctx.str('mode');
    s.locked = mode === 'locked' || (!!key && ctx.input.key(key));
    if (s.locked) s.coupling = ctx.drive.row(0, -UNBOUNDED, UNBOUNDED).add(left, 1).add(right, -1);
    else {
      // a limited-slip pack (preload plus a share of the carrier torque) and/or an adjustable locker on the axis
      const axis = ctx.str('lockAxis');
      const dial = axis ? clamp(ctx.input.axis(axis), 0, 1) * ctx.num('lockTorque') : 0;
      const slip = mode === 'lsd' ? ctx.num('preload') + ctx.num('bias') * Math.abs(s.prevTorque) * fd : 0;
      const pack = Math.max(slip, dial);
      if (pack > 0) s.coupling = ctx.drive.couple(left, right, pack);
    }
  },
  poststep(s, _dt, ctx) {
    const left = ctx.drive.shaft(ctx.str('left'));
    const right = ctx.drive.shaft(ctx.str('right'));
    const c = s.carrier;
    s.prevTorque = c ? c.torqueOn(0) : 0; // torque the carrier took from the input shaft
    // torque each output receives: from the carrier row, plus the coupling row (+ on the left, − on the right)
    const k = s.coupling ? s.coupling.torque : 0;
    const tl = (c ? c.torqueOn(1) : 0) + k;
    const tr = (c ? c.torqueOn(2) : 0) - k;
    ctx.state.set([
      toRpm(left.omega),
      toRpm(right.omega),
      tl,
      tr,
      s.locked || (s.coupling && !s.coupling.saturated) ? 1 : 0,
    ]);
  },
  saveState: (s) => ({ prevTorque: s.prevTorque }),
  loadState(s, data) {
    const d = data as { prevTorque?: number } | null;
    if (d) s.prevTorque = d.prevTorque ?? 0;
  },
};
