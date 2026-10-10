/** Sanitising of the saved cameras (`SceneDocument.cameras`): bookmarks, cinematic shots, view setups. */
import { clamp } from '../../core/math';
import type { CameraBookmark, CameraShot, MinimapSettings, SceneCameras, ShotKey, ViewPane } from '../types';
import { bool, idStr, nameStr, num, oneOf, position3, str, vec3 } from './primitives';

export const CAMERA_LIMITS = { bookmarks: 64, shots: 16, keys: 64, panes: 3, pips: 4, thumb: 24_000 } as const;

export const emptyCameras = (): SceneCameras => ({
  bookmarks: [],
  shots: [],
  split: 1,
  panes: [],
  pips: [],
  minimap: { enabled: false, range: 40, rotate: false, corner: 'br' },
});

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown, max: number): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter(isRec).slice(0, max) : [];

/** Only small JPEG / PNG / WebP data URLs are kept as thumbnails. */
export function thumbOf(v: unknown): string | undefined {
  return typeof v === 'string' &&
    v.length <= CAMERA_LIMITS.thumb &&
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v)
    ? v
    : undefined;
}

function bookmark(r: Record<string, unknown>, i: number): CameraBookmark {
  const b: CameraBookmark = {
    id: idStr(r.id, `cb_${i}`),
    name: nameStr(r.name, `View ${i + 1}`),
    position: position3(r.position, [8, 6, 10]),
    target: position3(r.target, [0, 1, 0]),
    fov: clamp(num(r.fov, 48), 5, 120),
    ortho: bool(r.ortho, false),
    orthoSize: clamp(num(r.orthoSize, 12), 0.1, 2000),
  };
  const t = thumbOf(r.thumb);
  if (t) b.thumb = t;
  return b;
}

function key(r: Record<string, unknown>, duration: number): ShotKey {
  return {
    t: clamp(num(r.t, 0), 0, duration),
    u: clamp(num(r.u, 0), 0, 1),
    fov: clamp(num(r.fov, 48), 5, 120),
    ease: oneOf(r.ease, ['linear', 'in', 'out', 'inOut'], 'inOut'),
  };
}

function shot(r: Record<string, unknown>, i: number): CameraShot {
  const duration = clamp(num(r.duration, 8), 0.5, 3600);
  const keys = list(r.keys, CAMERA_LIMITS.keys)
    .map((k) => key(k, duration))
    .sort((a, b) => a.t - b.t);
  if (keys.length < 2)
    keys.splice(0, keys.length, { t: 0, u: 0, fov: 48, ease: 'inOut' }, { t: duration, u: 1, fov: 48, ease: 'inOut' });
  const look = isRec(r.look) ? r.look : {};
  return {
    id: idStr(r.id, `cs_${i}`),
    name: nameStr(r.name, `Shot ${i + 1}`),
    pathId: str(r.pathId, ''),
    duration,
    loop: bool(r.loop, false),
    keys,
    look: {
      mode: oneOf(look.mode, ['tangent', 'body', 'point'], 'tangent'),
      bodyId: str(look.bodyId, ''),
      point: position3(look.point, [0, 1, 0]),
    },
  };
}

function pane(r: Record<string, unknown>, i: number, kind: string): ViewPane {
  return {
    id: idStr(r.id, `${kind}_${i}`),
    mode: oneOf(r.mode, ['chase', 'topdown', 'mount', 'bookmark', 'shot'], 'chase'),
    subject: typeof r.subject === 'string' && r.subject ? r.subject : null,
    ref: str(r.ref, ''),
    fov: clamp(num(r.fov, 60), 5, 120),
    offset: vec3(r.offset, [0, 0.5, 0]).map((v) => clamp(v, -100, 100)) as [number, number, number],
    yaw: clamp(num(r.yaw, 0), -180, 180),
    pitch: clamp(num(r.pitch, 0), -89, 89),
    x: clamp(num(r.x, 0.68), 0, 0.95),
    y: clamp(num(r.y, 0.62), 0, 0.95),
    w: clamp(num(r.w, 0.28), 0.1, 0.9),
  };
}

function minimap(r: unknown): MinimapSettings {
  const m = isRec(r) ? r : {};
  return {
    enabled: bool(m.enabled, false),
    range: clamp(num(m.range, 40), 2, 2000),
    rotate: bool(m.rotate, false),
    corner: oneOf(m.corner, ['tl', 'tr', 'bl', 'br'], 'br'),
  };
}

export function sanitizeCameras(raw: unknown): SceneCameras {
  if (!isRec(raw)) return emptyCameras();
  const seen = new Set<string>();
  const unique = <T extends { id: string }>(items: T[]): T[] =>
    items.filter((x) => !seen.has(x.id) && !!seen.add(x.id));
  const split = Math.round(num(raw.split, 1));
  return {
    bookmarks: unique(list(raw.bookmarks, CAMERA_LIMITS.bookmarks).map(bookmark)),
    shots: unique(list(raw.shots, CAMERA_LIMITS.shots).map(shot)),
    split: (split >= 2 && split <= 4 ? split : 1) as 1 | 2 | 3 | 4,
    panes: unique(list(raw.panes, CAMERA_LIMITS.panes).map((p, i) => pane(p, i, 'pane'))),
    pips: unique(list(raw.pips, CAMERA_LIMITS.pips).map((p, i) => pane(p, i, 'pip'))),
    minimap: minimap(raw.minimap),
  };
}
