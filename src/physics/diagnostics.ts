/**
 * The built-in `diagnostics` custom channel: ask the worker what it is running. The reply lists the protocol
 * version, how many bodies / joints / soft bodies / components exist and which component types have a definition but no
 * runtime in this worker (a packaging mistake that would otherwise only show as a component doing nothing).
 *
 *   client.sendCustom('diagnostics', null)  →  client.on('custom', ({ channel, data }) => …)
 */
import { PROTOCOL_VERSION } from './protocol';
import { registerCustomChannel } from './custom';

export interface DiagnosticsReply {
  protocol: number;
  bodies: number;
  joints: number;
  components: number;
  /** Components held by the host; differs from `components` only if some outlived their owner. */
  hostedComponents: number;
  /** Components publishing state, and components that asked for contact events. */
  publishedStates: number;
  contactWatchers: number;
  /** Component types the document model knows but this worker cannot run. */
  missingRuntimes: string[];
  simTime: number;
  stepCount: number;
}

registerCustomChannel('diagnostics', (_data, { world, reply }) => {
  const info: DiagnosticsReply = {
    protocol: PROTOCOL_VERSION,
    bodies: world.bodyIds.length,
    joints: world.jointIds.length,
    components: [...world.bodyIds, ...world.jointIds].reduce((n, id) => n + world.componentsOf(id).length, 0),
    hostedComponents: world.hostedComponents,
    publishedStates: world.publishedStates,
    contactWatchers: world.contactWatchers,
    missingRuntimes: world.missingRuntimes(),
    simTime: world.simTime,
    stepCount: world.stepCount,
  };
  reply('diagnostics', info);
});
