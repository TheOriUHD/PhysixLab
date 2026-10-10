/**
 * Replay files (TM-4): a recorded run as a single deflated JSON file (`.plreplay`) or a share link.
 *
 * A file holds the scene the run started from, the recorder's input log (every op, key set and axis set with the
 * step it was applied before), the optional base state (when the recording began mid-run), the hash checkpoints
 * that let the viewer prove the playback is faithful, and the timeline bookmarks. Loading validates everything:
 * the scene goes through `parseDocument`, entities inside logged ops and in the base state through the same
 * sanitisers, and numbers are clamped, so a damaged or hostile file produces an error message, not a broken world.
 */
import { LIMITS } from '../model/limits';
import { newDocument } from '../model/factory';
import { parseDocument, sanitizeDocument, serializeDocument } from '../model/serialize';
import { isFormat } from '../model/legacy';
import type { Entity, SceneDocument } from '../model/types';
import type { WorldSnapshot } from '../physics/protocol';
import type { InputEntry, ReplayPayload } from '../physics/timelineTypes';

export const REPLAY_FORMAT = 'physixlab-replay';
export const REPLAY_VERSION = 1;
export const REPLAY_EXTENSION = '.plreplay';
/** Largest replay accepted, in bytes of JSON text. */
export const MAX_REPLAY_CHARS = 200 * 1024 * 1024;
const MAX_ENTRIES = 600_000;

export interface Bookmark {
  step: number;
  name: string;
}

export interface ReplayFile {
  name: string;
  createdAt: number;
  scene: SceneDocument;
  replay: ReplayPayload;
  bookmarks: Bookmark[];
}

export class ReplayFormatError extends Error {}

// ---- bytes ↔ text ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deflate(text: string, format: 'deflate' | 'deflate-raw'): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  return new Response(stream).text();
}

// ---- snapshot ↔ JSON ------------------------------------------------------------------------

type WireSnapshot = Omit<WorldSnapshot, 'rapier'> & { rapier: string };

const encodeSnapshot = (s: WorldSnapshot): WireSnapshot => ({ ...s, rapier: bytesToBase64(s.rapier) });

// ---- encode ---------------------------------------------------------------------------------

export function replayToJson(file: ReplayFile): string {
  const { replay } = file;
  return JSON.stringify({
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    name: file.name,
    createdAt: file.createdAt,
    scene: JSON.parse(serializeDocument(file.scene)) as unknown,
    replay: { ...replay, base: replay.base ? encodeSnapshot(replay.base) : null },
    bookmarks: file.bookmarks,
  });
}

export async function encodeReplay(file: ReplayFile): Promise<Uint8Array> {
  return deflate(replayToJson(file), 'deflate');
}

/** A link that opens the replay (only for small ones: the scene and log travel in the URL). */
export async function replayShareLink(file: ReplayFile, base: string = location.href): Promise<string> {
  const bytes = await deflate(replayToJson(file), 'deflate-raw');
  const b64 = bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = new URL(base);
  url.hash = `replay=${b64}`;
  const link = url.toString();
  if (link.length > LIMITS.maxShareLinkChars)
    throw new ReplayFormatError(
      `This replay is too large for a share link (${Math.round(link.length / 1000)} kB; the limit is ${Math.round(LIMITS.maxShareLinkChars / 1000)} kB). Export it as a file instead.`,
    );
  return link;
}

// ---- decode and validation --------------------------------------------------------------------

export async function decodeReplay(bytes: Uint8Array): Promise<ReplayFile> {
  let text: string;
  try {
    text = await inflate(bytes, 'deflate');
  } catch {
    // an uncompressed file is fine too
    text = new TextDecoder().decode(bytes);
  }
  return parseReplay(text);
}

export async function replayFromHash(hash: string): Promise<ReplayFile | null> {
  const m = /replay=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  let text: string;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    text = await inflate(base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), 'deflate-raw');
  } catch {
    throw new ReplayFormatError('This replay link is damaged or incomplete.');
  }
  return parseReplay(text);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown, lo: number, hi: number, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
    throw new ReplayFormatError(`${what} is not valid.`);
  return v;
};

/** Run entities through the scene sanitiser; the result is keyed by id. */
function cleanEntities(entities: Entity[]): Map<string, Entity> {
  const doc = newDocument('replay');
  // joints must not be dropped because their bodies are not part of this little document
  const refs = new Map<string, [string | null, string | null]>();
  const list = entities.map((e) => {
    if (e.kind !== 'joint') return e;
    refs.set(e.id, [e.bodyA, e.bodyB]);
    return { ...e, bodyA: null, bodyB: null };
  });
  doc.entities = list;
  const out = new Map<string, Entity>();
  for (const e of sanitizeDocument(doc).entities) {
    const r = refs.get(e.id);
    out.set(e.id, e.kind === 'joint' && r ? { ...e, bodyA: r[0], bodyB: r[1] } : e);
  }
  return out;
}

const OP_NAMES = new Set([
  'addBody',
  'addJoint',
  'remove',
  'updateBody',
  'updateJoint',
  'settings',
  'teleport',
  'setVelocity',
  'grab',
  'grabMove',
  'release',
  'impulse',
  'explode',
  'addSoft',
  'updateSoft',
  'grabSoft',
  'wakeAll',
  'setSeed',
  'events',
  'setPath',
]);

const OP_ENTITY_FIELD: Record<string, string> = {
  addBody: 'body',
  updateBody: 'body',
  addJoint: 'joint',
  updateJoint: 'joint',
  addSoft: 'soft',
  updateSoft: 'soft',
  setPath: 'path',
};

/** One entity through the scene sanitiser (null if it is rejected). */
function cleanEntity(e: unknown): Entity | null {
  if (!isObj(e)) return null;
  const list = cleanEntities([e as unknown as Entity]);
  return [...list.values()][0] ?? null;
}

function cleanEntries(raw: unknown, endStep: number): InputEntry[] {
  if (!Array.isArray(raw)) throw new ReplayFormatError('The input log is missing.');
  if (raw.length > MAX_ENTRIES) throw new ReplayFormatError('The input log is too long.');
  const out: InputEntry[] = [];
  let lastStep = 0;
  for (const r of raw as unknown[]) {
    if (!isObj(r)) throw new ReplayFormatError('The input log has a damaged entry.');
    const step = finite(r.step, 0, endStep, 'A step number');
    if (step < lastStep) throw new ReplayFormatError('The input log is out of order.');
    lastStep = step;
    if (r.kind === 'keys') {
      if (!Array.isArray(r.keys)) throw new ReplayFormatError('A key set is damaged.');
      out.push({
        step,
        kind: 'keys',
        keys: (r.keys as unknown[]).filter((k): k is string => typeof k === 'string').slice(0, 64),
      });
    } else if (r.kind === 'axes') {
      const axes: Record<string, number> = {};
      if (isObj(r.axes))
        for (const [k, v] of Object.entries(r.axes))
          if (typeof v === 'number' && Number.isFinite(v) && k.length < 64) axes[k] = Math.max(-1e3, Math.min(1e3, v));
      out.push({ step, kind: 'axes', axes });
    } else if (r.kind === 'op' && isObj(r.op) && typeof r.op.op === 'string' && OP_NAMES.has(r.op.op)) {
      const op = { ...r.op } as Record<string, unknown>;
      const field = OP_ENTITY_FIELD[r.op.op];
      if (field) {
        const clean = cleanEntity(op[field]);
        if (!clean) throw new ReplayFormatError('An edit in the input log is damaged.');
        op[field] = clean;
      }
      out.push({ step, kind: 'op', op: op as unknown as Extract<InputEntry, { kind: 'op' }>['op'] });
    } else throw new ReplayFormatError('The input log has an entry of an unknown kind.');
  }
  return out;
}

function cleanBase(raw: unknown): WorldSnapshot | null {
  if (raw === null || raw === undefined) return null;
  if (!isObj(raw) || raw.version !== 1 || typeof raw.rapier !== 'string')
    throw new ReplayFormatError('The starting state is damaged.');
  const snap = { ...raw, rapier: base64ToBytes(raw.rapier) } as unknown as WorldSnapshot;
  if (
    !Array.isArray(snap.bodies) ||
    !Array.isArray(snap.joints) ||
    !Array.isArray(snap.softs) ||
    !Array.isArray(snap.paths)
  )
    throw new ReplayFormatError('The starting state is damaged.');
  // every definition inside goes through the scene sanitiser
  const defs: Entity[] = [
    ...snap.bodies.map((b) => b.def),
    ...snap.joints.map((j) => j.def),
    ...snap.softs.map((x) => x.def),
    ...snap.paths,
  ];
  const clean = cleanEntities(defs);
  const pick = <T extends Entity>(d: T): T => {
    const c = clean.get(d.id);
    if (!c) throw new ReplayFormatError('The starting state contains an object that could not be read.');
    return c as T;
  };
  snap.bodies = snap.bodies.map((b) => ({ ...b, def: pick(b.def) }));
  snap.joints = snap.joints.map((j) => ({ ...j, def: pick(j.def) }));
  snap.softs = snap.softs.map((x) => ({ ...x, def: pick(x.def) }));
  snap.paths = snap.paths.map(pick);
  snap.settings = sanitizeDocument({ ...newDocument('x'), settings: snap.settings }).settings;
  return snap;
}

export function parseReplay(text: string): ReplayFile {
  if (text.length > MAX_REPLAY_CHARS) throw new ReplayFormatError('This replay file is too large.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ReplayFormatError('This is not a PhysixLab replay file.');
  }
  if (!isObj(raw) || !isFormat(raw.format, REPLAY_FORMAT)) throw new ReplayFormatError('This is not a PhysixLab replay file.');
  if (typeof raw.version !== 'number' || raw.version > REPLAY_VERSION)
    throw new ReplayFormatError('This replay was saved by a newer version of PhysixLab.');
  if (!isObj(raw.replay)) throw new ReplayFormatError('The replay has no recording.');
  const scene = parseDocument(JSON.stringify(raw.scene));
  const r = raw.replay;
  const endStep = finite(r.endStep, 0, 50_000_000, 'The length of the replay');
  const startStep = finite(r.startStep, 0, endStep, 'The start of the replay');
  const hz = finite(r.hz, 30, 1000, 'The simulation rate');
  const hashes: [number, string][] = [];
  if (Array.isArray(r.hashes))
    for (const h of (r.hashes as unknown[]).slice(0, 1_000_000))
      if (Array.isArray(h) && typeof h[0] === 'number' && typeof h[1] === 'string' && h[1].length <= 32)
        hashes.push([h[0], h[1]]);
  const bookmarks: Bookmark[] = [];
  if (Array.isArray(raw.bookmarks))
    for (const b of (raw.bookmarks as unknown[]).slice(0, 500))
      if (isObj(b) && typeof b.step === 'number' && Number.isFinite(b.step))
        bookmarks.push({
          step: Math.max(0, Math.min(endStep, Math.round(b.step))),
          name: (typeof b.name === 'string' ? b.name : '').slice(0, LIMITS.maxNameLength),
        });
  return {
    name: (typeof raw.name === 'string' ? raw.name : scene.name).slice(0, LIMITS.maxNameLength),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    scene,
    replay: {
      base: cleanBase(r.base),
      startStep,
      endStep,
      entries: cleanEntries(r.entries, endStep),
      hashes,
      hz,
    },
    bookmarks,
  };
}
