/**
 * The runtime half of the component system. A `ComponentRuntime` is registered under the same `type` as the
 * document-side `ComponentDef` (`src/model/componentRegistry.ts`) and says what the component *does* inside the
 * physics world, step by step:
 *
 *   create(ctx)            once, when the component is attached (the body / joint is added, the component is
 *                          switched on or added, or the world is rebuilt). Returns the component's own state `S`.
 *   prestep(state, dt, ctx)   every fixed step before the engine steps: apply forces, drive kinematic bodies, read inputs.
 *   poststep(state, dt, ctx)  every fixed step after: measure, publish state, raise events.
 *   onEvent(state, ev, ctx)   a contact / sensor event involving the owner.
 *   paramsChanged(state, ctx) the user edited the parameters while the simulation runs. Implement it when the
 *                          component can adopt new values in place (most can: read `ctx.params` / `ctx.num(...)`
 *                          fresh every step and there is nothing to do); leave it out and the component is
 *                          disposed and created again.
 *   dispose(state, ctx)    when it is switched off, removed, or its owner goes away.
 *   saveState / loadState  state that must survive a snapshot / restore (accumulated time, a spawn counter …).
 *
 * Order is deterministic: every fixed step, components run bodies first (in the order they were added to the
 * world), then joints, each owner's components in the order of its `components` array. Everything a runtime may
 * touch goes through `ctx` (`./context.ts`); never keep references to engine objects across steps.
 *
 * Adding a runtime = one file next to this one exporting a `ComponentRuntime` + one line in `index.ts`. Both threads
 * and the Node tests import `index.ts`, so the worker always has what the page offers.
 */
import type { SimEvent } from '../protocol';
import type { ComponentContext } from './context';

export interface ComponentRuntime<S = unknown> {
  /** Same id as the `ComponentDef`. */
  type: string;
  create(ctx: ComponentContext): S;
  prestep?(state: S, dt: number, ctx: ComponentContext): void;
  poststep?(state: S, dt: number, ctx: ComponentContext): void;
  onEvent?(state: S, ev: SimEvent, ctx: ComponentContext): void;
  paramsChanged?(state: S, ctx: ComponentContext): void;
  dispose?(state: S, ctx: ComponentContext): void;
  saveState?(state: S): unknown;
  loadState?(state: S, data: unknown, ctx: ComponentContext): void;
}

const runtimes = new Map<string, ComponentRuntime>();

/** Register the runtime of a component type. Throws on a duplicate so two packages cannot silently shadow each other. */
export function registerRuntime<S>(rt: ComponentRuntime<S>): void {
  if (!rt.type) throw new Error('component runtime needs a type');
  if (runtimes.has(rt.type)) throw new Error(`component runtime "${rt.type}" is already registered`);
  runtimes.set(rt.type, rt);
}

export function runtimeOf(type: string): ComponentRuntime | undefined {
  return runtimes.get(type);
}
