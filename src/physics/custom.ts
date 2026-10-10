/**
 * The custom channel (protocol v2): a package that needs a private conversation with the physics worker registers
 * a handler for a channel name here, and the page talks to it with `SimClient.sendCustom(channel, data)`; replies come
 * back as `{ type: 'custom' }` messages (`SimClient` emits them as the `'custom'` event).
 *
 * Handlers run inside the worker (and in Node tests: `PhysicsWorld.custom`) and get the live world, so they can add
 * bodies, read state or run queries. Register from a module the worker imports (e.g. a package's `physics/…/index.ts`
 * pulled in by `physics/components/index.ts`), not from main-thread-only code.
 */
import type { PhysicsWorld } from './world/physicsWorld';

export interface CustomApi {
  /** The simulated world the message arrived for. */
  world: PhysicsWorld;
  /** Send a reply to the page on any channel (usually the same one). */
  reply: (channel: string, data: unknown) => void;
}

export type CustomHandler = (data: unknown, api: CustomApi) => void;

const handlers = new Map<string, CustomHandler>();

/** Register the handler of `channel`. A channel has one handler; registering twice is a programming error. */
export function registerCustomChannel(channel: string, handler: CustomHandler): void {
  if (!channel) throw new Error('custom channel needs a name');
  if (handlers.has(channel)) throw new Error(`custom channel "${channel}" is already registered`);
  handlers.set(channel, handler);
}

/** Remove a handler (tests). */
export function unregisterCustomChannel(channel: string): void {
  handlers.delete(channel);
}

/** Run the handler of `channel`; returns the replies it produced ([] for an unknown channel). */
export function dispatchCustom(
  world: PhysicsWorld,
  channel: string,
  data: unknown,
): { channel: string; data: unknown }[] {
  const h = handlers.get(channel);
  if (!h) return [];
  const replies: { channel: string; data: unknown }[] = [];
  h(data, { world, reply: (c, d) => replies.push({ channel: c, data: d }) });
  return replies;
}
