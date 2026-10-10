// File: src/physics/components/spin.ts   (then add `spin` to the list in src/physics/components/index.ts)
import { vdot, vnorm, vscale } from '../../src/core/math';
import type { ComponentRuntime } from '../../src/physics/components/registry';

export const spin: ComponentRuntime<null> = {
  type: 'spin',
  create: () => null,
  // The parameters are read fresh every step, so edits made while the simulation runs need no work here.
  paramsChanged: () => undefined,
  prestep(_state, _dt, ctx) {
    const body = ctx.body;
    if (!body || body.type !== 'dynamic') return;
    const axis = vnorm(ctx.vec3('axis'), [0, 1, 0]);
    body.setVelocity(body.linvel(), vscale(axis, ctx.num('speed')));
  },
  poststep(_state, _dt, ctx) {
    const body = ctx.body;
    if (body) ctx.state.set([vdot(body.angvel(), vnorm(ctx.vec3('axis'), [0, 1, 0]))]);
  },
};
