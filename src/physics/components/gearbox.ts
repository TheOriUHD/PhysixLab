/**
 * Runtime of the `gearbox` component (definition: `src/model/components/gearbox.ts`).
 *
 * A gear pair is a rigid row `ω_in = ratio·ω_out` in the drive network. The solver conserves power across it, so the
 * output carries `ratio` times the input torque and turns `ratio` times slower, and the inertia of everything
 * downstream is felt by the engine divided by ratio². Neutral (and the shift interval) removes the row. Efficiency is a
 * loss torque on the output, a fraction of the torque the pair transmitted in the previous step.
 */
import { clamp } from '../../core/math';
import { parseRatios } from '../../model/components/gearbox';
import type { Row } from './drive/network';
import { Edge, toRpm } from './powered/common';
import type { ComponentRuntime } from './registry';

interface State {
  /** −1 reverse, 0 neutral, 1 … N forward. */
  gear: number;
  shifting: number;
  up: Edge;
  down: Edge;
  neutral: Edge;
  reverse: Edge;
  axisUp: Edge;
  axisDown: Edge;
  row: Row | null;
  outTorque: number;
  ratioText: string;
  ratios: number[];
}

export const gearbox: ComponentRuntime<State> = {
  type: 'gearbox',
  create: (ctx) => ({
    gear: Math.round(ctx.num('gear')),
    shifting: 0,
    up: new Edge(),
    down: new Edge(),
    neutral: new Edge(),
    reverse: new Edge(),
    axisUp: new Edge(),
    axisDown: new Edge(),
    row: null,
    outTorque: 0,
    ratioText: '',
    ratios: [],
  }),
  paramsChanged: (_s, ctx) => ctx.drive.releaseAll(),
  prestep(s, dt, ctx) {
    const a = ctx.drive.shaft(ctx.str('in'));
    const b = ctx.drive.shaft(ctx.str('out'));
    const text = ctx.str('ratios');
    if (text !== s.ratioText) {
      s.ratioText = text;
      s.ratios = parseRatios(text);
    }
    const n = s.ratios.length;
    s.row = null;
    if (n === 0 || a === b) return;
    const key = (field: string) => {
      const code = ctx.str(field);
      return !!code && ctx.input.key(code);
    };
    const before = s.gear;
    // the shift axis acts like two keys: past +0.6 is "up", past −0.6 is "down" (a push counts once)
    const axisName = ctx.str('shiftAxis');
    const stick = axisName ? ctx.input.axis(axisName) : 0;
    const up = s.up.pressed(key('upKey'));
    const down = s.down.pressed(key('downKey'));
    if (s.axisUp.pressed(stick > 0.6) || up) s.gear = Math.min(n, s.gear + 1);
    if (s.axisDown.pressed(stick < -0.6) || down) s.gear = Math.max(-1, s.gear - 1);
    if (s.neutral.pressed(key('neutralKey'))) s.gear = 0;
    if (s.reverse.pressed(key('reverseKey'))) s.gear = -1;
    if (ctx.str('mode') === 'auto' && s.gear >= 1 && s.shifting <= 0) {
      const rpm = toRpm(a.omega);
      if (rpm > ctx.num('upRpm') && s.gear < n) s.gear++;
      else if (rpm < ctx.num('downRpm') && s.gear > 1) s.gear--;
    }
    s.gear = clamp(s.gear, -1, n);
    if (s.gear !== before) s.shifting = s.gear === 0 ? 0 : ctx.num('shiftTime');
    else s.shifting = Math.max(0, s.shifting - dt);
    ctx.drive.inertia(a, ctx.num('inertia'));
    if (s.gear === 0 || s.shifting > 0) {
      s.outTorque = 0;
      return;
    }
    const ratio = s.gear > 0 ? s.ratios[s.gear - 1] : -ctx.num('reverse');
    s.row = ctx.drive.gear(a, b, ratio);
    // losses: a share of the torque the pair carried last step, against the output's motion
    const loss = (1 - ctx.num('efficiency')) * Math.abs(s.outTorque);
    ctx.drive.torque(b, (-loss * b.omega) / (Math.abs(b.omega) + 0.5));
  },
  poststep(s, _dt, ctx) {
    const a = ctx.drive.shaft(ctx.str('in'));
    const b = ctx.drive.shaft(ctx.str('out'));
    s.outTorque = s.row ? s.row.torqueOn(1) : 0;
    const ratio = s.gear > 0 ? (s.ratios[s.gear - 1] ?? 0) : s.gear < 0 ? -ctx.num('reverse') : 0;
    ctx.state.set([s.gear, ratio, toRpm(a.omega), toRpm(b.omega), s.outTorque]);
  },
  saveState: (s) => ({ gear: s.gear, shifting: s.shifting, outTorque: s.outTorque }),
  loadState(s, data) {
    const d = data as Partial<State> | null;
    if (!d) return;
    s.gear = d.gear ?? s.gear;
    s.shifting = d.shifting ?? 0;
    s.outTorque = d.outTorque ?? 0;
  },
};
