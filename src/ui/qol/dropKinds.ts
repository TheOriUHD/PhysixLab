/**
 * What a dropped file is (UI-42). Pure: classification by name / type, and a sniff of JSON text (a scene, a replay
 * and a prefab pack are all `.json`). Whether PhysixLab can *do* something with a kind is decided by the handlers
 * registered in `dropHandlers.ts`, so the overlay never promises an import that does not exist.
 */
import { isFormat } from '../../model/legacy';
import { isRecord } from './storage';

export type DropKind = 'scene' | 'replay' | 'prefabPack' | 'image' | 'mesh' | 'audio' | 'json' | 'unknown';

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const MESH = /\.(obj|stl|glb|gltf|ply|fbx|dae|3mf)$/i;
const AUDIO = /\.(wav|mp3|ogg|oga|m4a|flac|opus)$/i;
const REPLAY = /\.(plreplay|replay)(\.json)?$/i;

/** By file name and MIME type alone (all a drag gives before the drop). A `.json` is `'json'` until its text is read. */
export function classifyByName(name: string, mime = ''): DropKind {
  if (REPLAY.test(name)) return 'replay';
  if (/\.json$/i.test(name) || mime === 'application/json') return 'json';
  if (IMAGE.test(name) || mime.startsWith('image/')) return 'image';
  if (MESH.test(name) || mime.startsWith('model/')) return 'mesh';
  if (AUDIO.test(name) || mime.startsWith('audio/')) return 'audio';
  return 'unknown';
}

/** What a JSON text holds: a scene (has `entities`), a replay, a prefab pack, or something else. */
export function sniffJsonKind(text: string): DropKind {
  const head = text.trimStart();
  if (!head.startsWith('{')) return 'unknown';
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'unknown';
  }
  if (!isRecord(raw)) return 'unknown';
  if (Array.isArray(raw.entities)) return 'scene';
  if (isFormat(raw.format, 'physixlab-replay') || Array.isArray(raw.frames) || isRecord(raw.replay)) return 'replay';
  if (isFormat(raw.format, 'physixlab-prefabs') || Array.isArray(raw.prefabs)) return 'prefabPack';
  return 'unknown';
}

export const KIND_LABEL: Record<DropKind, string> = {
  scene: 'scene',
  replay: 'replay',
  prefabPack: 'prefab pack',
  image: 'image',
  mesh: 'mesh',
  audio: 'audio file',
  json: 'JSON file',
  unknown: 'file',
};

/** The message shown for a kind nobody can import yet (never pretends). */
export function unsupportedMessage(kind: DropKind, name: string): string {
  switch (kind) {
    case 'replay':
      return "Replays aren't supported yet: there is no replay format to import.";
    case 'prefabPack':
      return "Prefab packs aren't supported yet: PhysixLab cannot import them.";
    case 'image':
      return `Images aren't supported yet: “${name}” was not imported (nothing in a scene can use an image file).`;
    case 'mesh':
      return `Mesh files aren't supported yet: “${name}” was not imported (OBJ, STL and glTF import is not available).`;
    case 'audio':
      return `Audio files aren't supported yet: “${name}” was not imported.`;
    default:
      return `“${name}” is not a PhysixLab scene, so it was not imported.`;
  }
}

export interface DragInfo {
  kind: string;
  type: string;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The drop overlay's text while files are dragged over the window. `supported` says which kinds have a handler. */
export function describeDrag(
  items: readonly DragInfo[],
  supported: ReadonlySet<DropKind>,
): { title: string; detail: string; ok: boolean } {
  const files = items.filter((i) => i.kind === 'file');
  if (!files.length) return { title: 'Drop a file', detail: 'Scene files (.json) open in the editor.', ok: true };
  // A drag only exposes the MIME type, so a `.json` may be a scene, a replay or a pack until it is dropped.
  const kinds = files.map((f) => classifyByName('', f.type));
  const sceneish = (k: DropKind) => k === 'json' || k === 'scene';
  if (kinds.every(sceneish) || (kinds.every((k) => k === 'unknown') && supported.has('scene')))
    return {
      title: files.length > 1 ? 'Drop to open the first scene' : 'Drop to open this scene',
      detail: 'Replaces the current scene (you are asked first if it has unsaved edits).',
      ok: true,
    };
  const first = kinds.find((k) => !sceneish(k) && k !== 'unknown') ?? 'unknown';
  if (supported.has(first)) return { title: `Drop to import the ${KIND_LABEL[first]}`, detail: '', ok: true };
  return {
    title:
      first === 'unknown'
        ? 'This file type can’t be imported'
        : `${capitalise(KIND_LABEL[first])}s can’t be imported yet`,
    detail: 'Only PhysixLab scene files (.json) can be dropped here for now.',
    ok: false,
  };
}
