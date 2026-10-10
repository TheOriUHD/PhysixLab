/**
 * The viewer's cross-window message protocol (DT-22), version 1. Documented in docs/EMBED.md.
 *
 * Parent → viewer: `{ type: 'physixlab', v?: 1, id?: string, cmd: 'hello'|'play'|'pause'|'reset'|'step'|'loadScene'|'setCamera'|'getState', … }`
 * Viewer → parent: `{ type: 'physixlab', v: 1, event: 'ready'|'state'|'error', id?: string, … }`
 *
 * Everything here is pure so the validation can be unit tested without a browser.
 */

export const PROTOCOL_VERSION = 1;
export const MESSAGE_TYPE = 'physixlab';

export type Vec3Tuple = [number, number, number];

export type EmbedCommand =
  | { cmd: 'hello' }
  | { cmd: 'play' }
  | { cmd: 'pause' }
  | { cmd: 'reset' }
  | { cmd: 'step'; count: number }
  | { cmd: 'loadScene'; template?: string; share?: string; document?: Record<string, unknown> }
  | { cmd: 'setCamera'; reset: boolean; position?: Vec3Tuple; target?: Vec3Tuple }
  | { cmd: 'getState' };

export interface ParsedCommand {
  id?: string;
  command: EmbedCommand;
}

export interface EmbedState {
  mode: 'edit' | 'paused' | 'running';
  /** Simulated seconds since the last reset (0 in edit mode). */
  time: number;
  sceneName: string;
  bodies: number;
  camera: { position: Vec3Tuple; target: Vec3Tuple };
}

export type EmbedEvent =
  | { event: 'ready'; capabilities: string[]; state: EmbedState }
  | { event: 'state'; state: EmbedState; reason: string }
  | { event: 'error'; code: string; message: string };

const COMMANDS = new Set(['hello', 'play', 'pause', 'reset', 'step', 'loadScene', 'setCamera', 'getState']);
const MAX_COORD = 1e5;
const MAX_STEPS = 600;
const MAX_ID = 64;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function vec3(v: unknown): Vec3Tuple | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  for (const n of v) if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > MAX_COORD) return null;
  return [v[0] as number, v[1] as number, v[2] as number];
}

export type ParseResult =
  | { kind: 'ignore' } // not ours at all: stay silent
  | { kind: 'invalid'; id?: string; message: string }
  | { kind: 'ok'; parsed: ParsedCommand };

/** Validates the `data` of a message event. Anything that does not carry `type: 'physixlab'` is ignored silently. */
export function parseMessage(data: unknown): ParseResult {
  if (!isRecord(data) || data.type !== MESSAGE_TYPE) return { kind: 'ignore' };
  // A viewer's own events echoed back (e.g. by a host that reflects messages) are not commands.
  if (typeof data.event === 'string') return { kind: 'ignore' };
  let id: string | undefined;
  if (data.id !== undefined) {
    if (typeof data.id !== 'string' || data.id.length > MAX_ID)
      return { kind: 'invalid', message: `"id" must be a string of at most ${MAX_ID} characters` };
    id = data.id;
  }
  if (data.v !== undefined && data.v !== PROTOCOL_VERSION)
    return {
      kind: 'invalid',
      id,
      message: `Unsupported protocol version ${JSON.stringify(data.v)} (this viewer speaks ${PROTOCOL_VERSION})`,
    };
  const cmd = data.cmd;
  if (typeof cmd !== 'string' || !COMMANDS.has(cmd))
    return { kind: 'invalid', id, message: `Unknown command ${JSON.stringify(cmd)}` };
  const bad = (message: string): ParseResult => ({ kind: 'invalid', id, message });
  switch (cmd) {
    case 'play':
    case 'pause':
    case 'reset':
    case 'getState':
    case 'hello':
      return { kind: 'ok', parsed: { id, command: { cmd } } };
    case 'step': {
      const c = data.count === undefined ? 1 : data.count;
      if (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > MAX_STEPS)
        return bad(`"count" must be an integer from 1 to ${MAX_STEPS}`);
      return { kind: 'ok', parsed: { id, command: { cmd, count: c } } };
    }
    case 'setCamera': {
      if (data.reset !== undefined && typeof data.reset !== 'boolean') return bad('"reset" must be a boolean');
      const position = data.position === undefined ? undefined : vec3(data.position);
      const target = data.target === undefined ? undefined : vec3(data.target);
      if (position === null || target === null)
        return bad('"position" and "target" must be [x, y, z] arrays of finite numbers');
      if (!data.reset && !position && !target)
        return bad('setCamera needs "reset": true, or a "position" and / or "target"');
      return { kind: 'ok', parsed: { id, command: { cmd, reset: data.reset === true, position, target } } };
    }
    default: {
      // loadScene: exactly one of template / share / document
      const given = ['template', 'share', 'document'].filter((k) => data[k] !== undefined);
      if (given.length !== 1) return bad('loadScene needs exactly one of "template", "share" or "document"');
      if (data.template !== undefined) {
        if (typeof data.template !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(data.template))
          return bad('"template" must be a template id string');
        return { kind: 'ok', parsed: { id, command: { cmd: 'loadScene', template: data.template } } };
      }
      if (data.share !== undefined) {
        if (typeof data.share !== 'string' || data.share.length > 2_000_000)
          return bad('"share" must be a share link or the "s=…" payload text');
        return { kind: 'ok', parsed: { id, command: { cmd: 'loadScene', share: data.share } } };
      }
      if (!isRecord(data.document)) return bad('"document" must be a PhysixLab scene object');
      return { kind: 'ok', parsed: { id, command: { cmd: 'loadScene', document: data.document } } };
    }
  }
}

/**
 * May a message from `origin` control the viewer? With an allow-list, only listed origins; without one, any
 * parent. An opaque origin (`"null"`, sandboxed frames) is only accepted when there is no allow-list.
 */
export function originAllowed(origin: string, allowList: readonly string[]): boolean {
  if (!allowList.length) return true;
  return allowList.includes(origin);
}

/** Envelope for events sent to the parent. */
export function envelope(ev: EmbedEvent, id?: string): Record<string, unknown> {
  const out: Record<string, unknown> = { type: MESSAGE_TYPE, v: PROTOCOL_VERSION, ...ev };
  if (id !== undefined) out.id = id;
  return out;
}

/** The hash payload (`s=…` / `scene=…`) of a share link, a bare `#…` hash or a bare payload; null when none is found. */
export function extractSharePayload(text: string): string | null {
  const m = /(?:^|[#&?])(s|scene)=([A-Za-z0-9_-]+)/.exec(text.trim());
  return m ? `${m[1]}=${m[2]}` : null;
}
