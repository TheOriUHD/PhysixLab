/** Camera preferences (per browser, not per scene): lens, speeds, distances, motion. Stored under their own key. */
import { clamp } from '../../core/math';

export type ForwardAxis = '+x' | '-x' | '+z' | '-z';
export type MotionPref = 'auto' | 'reduce' | 'full';

export interface CameraSettings {
  fov: number;
  /** Which local axis of a body counts as "forward" for first-person, third-person and chase cameras. */
  forwardAxis: ForwardAxis;
  flySpeed: number;
  tpDistance: number;
  tpHeight: number;
  chaseDistance: number;
  chaseHeight: number;
  /** Keep the near plane proportional to the distance to what is looked at (less z-fighting, no clipping). */
  autoNearFar: boolean;
  /** 0 = no camera shake, 1 = as authored, up to 2. */
  shake: number;
  motion: MotionPref;
  /** Seconds a mode switch takes. */
  transition: number;
}

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  fov: 48,
  forwardAxis: '+x',
  flySpeed: 8,
  tpDistance: 6,
  tpHeight: 2.2,
  chaseDistance: 7,
  chaseHeight: 2.6,
  autoNearFar: true,
  shake: 1,
  motion: 'auto',
  transition: 0.6,
};

const KEY = 'physixlab:camera:v1';

export function sanitizeCameraSettings(raw: unknown): CameraSettings {
  const d = DEFAULT_CAMERA_SETTINGS;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (k: keyof CameraSettings, lo: number, hi: number): number => {
    const v = r[k];
    return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : (d[k] as number);
  };
  return {
    fov: n('fov', 10, 110),
    forwardAxis: (['+x', '-x', '+z', '-z'] as const).find((a) => a === r.forwardAxis) ?? d.forwardAxis,
    flySpeed: n('flySpeed', 0.5, 200),
    tpDistance: n('tpDistance', 1, 60),
    tpHeight: n('tpHeight', 0, 30),
    chaseDistance: n('chaseDistance', 1, 80),
    chaseHeight: n('chaseHeight', 0, 40),
    autoNearFar: typeof r.autoNearFar === 'boolean' ? r.autoNearFar : d.autoNearFar,
    shake: n('shake', 0, 2),
    motion: (['auto', 'reduce', 'full'] as const).find((a) => a === r.motion) ?? d.motion,
    transition: n('transition', 0, 3),
  };
}

export function loadCameraSettings(): CameraSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return sanitizeCameraSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_CAMERA_SETTINGS };
  }
}

export function saveCameraSettings(s: CameraSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

/** Is motion reduced right now (the user's preference, else the operating system's)? */
export function reducedMotion(s: CameraSettings): boolean {
  if (s.motion === 'reduce') return true;
  if (s.motion === 'full') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
