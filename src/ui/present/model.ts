/**
 * Presentation / photo mode (UI-41), the pure part: options and their validation, camera presets, lens presets,
 * depth-of-field presets, the capture size arithmetic, the turntable step and the caption fade.
 * No DOM, no three.js objects — `tests/qol.test.ts` covers all of it.
 *
 * Depth of field is the renderer's real DOF pass (package VZ: a depth-driven blur that focuses on the orbit target);
 * the presets here only set its aperture and maximum blur through the same graphics options the Graphics section
 * edits. Lighting is the scene's own environment (sky preset, sun, image-based light — package VZ), set from the panel.
 */
import { isRecord } from '../qol/storage';

export type Vec3 = [number, number, number];

// ---- camera presets --------------------------------------------------------------------------------------------

export type CameraPresetId = 'front' | 'back' | 'left' | 'right' | 'top' | 'iso';

export interface CameraPreset {
  id: CameraPresetId;
  label: string;
  /** Direction from the target towards the camera (need not be normalised). */
  dir: Vec3;
}

export const CAMERA_PRESETS: readonly CameraPreset[] = [
  { id: 'front', label: 'Front', dir: [0, 0.18, 1] },
  { id: 'back', label: 'Back', dir: [0, 0.18, -1] },
  { id: 'left', label: 'Left', dir: [-1, 0.18, 0] },
  { id: 'right', label: 'Right', dir: [1, 0.18, 0] },
  { id: 'top', label: 'Top', dir: [0, 1, 0.02] },
  { id: 'iso', label: 'Isometric', dir: [1, 0.82, 1] },
];

/** Distance at which a sphere of `radius` fills the view (the same rule the viewport's frame() uses). */
export function fitDistance(radius: number, fovDeg: number): number {
  return Math.max(2.2, (Math.max(0.1, radius) / Math.tan((fovDeg * Math.PI) / 360)) * 1.35);
}

/** Camera position and target for a preset looking at `target` from `distance` away. */
export function presetPose(preset: CameraPreset, target: Vec3, distance: number): { position: Vec3; target: Vec3 } {
  const [x, y, z] = preset.dir;
  const len = Math.hypot(x, y, z) || 1;
  return {
    position: [target[0] + (x / len) * distance, target[1] + (y / len) * distance, target[2] + (z / len) * distance],
    target,
  };
}

// ---- lens ("depth of field" honest alternative) ---------------------------------------------------------------

export interface LensPreset {
  id: string;
  label: string;
  /** Focal length on a full-frame 36×24 mm sensor, which the vertical field of view is derived from. */
  mm: number;
}

export const LENS_PRESETS: readonly LensPreset[] = [
  { id: 'wide', label: 'Wide 24 mm', mm: 24 },
  { id: 'standard', label: 'Standard 35 mm', mm: 35 },
  { id: 'portrait', label: 'Portrait 85 mm', mm: 85 },
  { id: 'tele', label: 'Telephoto 135 mm', mm: 135 },
];

/** Vertical field of view in degrees of a lens on a 24 mm tall sensor. */
export const fovForMm = (mm: number): number => (2 * Math.atan(12 / mm) * 180) / Math.PI;

// ---- depth of field ------------------------------------------------------------------------------------------

export type DofPresetId = 'tier' | 'off' | 'soft' | 'portrait' | 'macro';

export interface DofPreset {
  id: DofPresetId;
  label: string;
  blurb: string;
  /** `on: null` follows the graphics quality tier (the default); the numbers are the pass's own parameters. */
  on: boolean | null;
  aperture: number;
  maxBlur: number;
}

export const DOF_PRESETS: readonly DofPreset[] = [
  {
    id: 'tier',
    label: 'Quality default',
    blurb: 'No blur unless the graphics tier turns it on',
    on: null,
    aperture: 0.35,
    maxBlur: 12,
  },
  { id: 'off', label: 'Off', blurb: 'Everything in focus', on: false, aperture: 0.35, maxBlur: 12 },
  {
    id: 'soft',
    label: 'Soft',
    blurb: 'A hint of blur away from the focus point',
    on: true,
    aperture: 0.15,
    maxBlur: 6,
  },
  {
    id: 'portrait',
    label: 'Portrait',
    blurb: 'Clear subject, softly blurred surroundings',
    on: true,
    aperture: 0.4,
    maxBlur: 14,
  },
  { id: 'macro', label: 'Macro', blurb: 'Razor-thin focus, strong blur', on: true, aperture: 0.85, maxBlur: 26 },
];

/** Which preset the stored DOF settings correspond to (null when the user tuned them by hand). */
export function matchDofPreset(dof: { on: boolean | null; aperture: number; maxBlur: number }): DofPresetId | null {
  for (const p of DOF_PRESETS) {
    if (dof.on !== p.on) continue;
    if (p.on !== true) return p.id; // aperture / blur are irrelevant while it is off or follows the tier
    if (Math.abs(dof.aperture - p.aperture) < 1e-6 && Math.abs(dof.maxBlur - p.maxBlur) < 1e-6) return p.id;
  }
  return null;
}

// ---- capture ---------------------------------------------------------------------------------------------------

export const CAPTURE_SCALES = [1, 2, 4] as const;
export type CaptureScale = (typeof CAPTURE_SCALES)[number];
/** Keeps a 4× capture of a big window within what a software or mobile GPU can allocate. */
export const MAX_CAPTURE_PIXELS = 36_000_000;

/** The scale actually used: the requested one, reduced until the image fits the GPU's largest edge and the pixel budget. */
export function effectiveScale(
  cssW: number,
  cssH: number,
  requested: number,
  maxEdge: number,
  maxPixels = MAX_CAPTURE_PIXELS,
): { scale: number; width: number; height: number; reduced: boolean } {
  let scale = Math.max(1, requested);
  const fits = (k: number) =>
    cssW * k <= maxEdge && cssH * k <= maxEdge && Math.round(cssW * k) * Math.round(cssH * k) <= maxPixels;
  while (scale > 1 && !fits(scale)) scale = Math.max(1, scale - 0.25);
  return { scale, width: Math.round(cssW * scale), height: Math.round(cssH * scale), reduced: scale < requested };
}

// ---- turntable -------------------------------------------------------------------------------------------------

/** Rotate `pos` about the vertical axis through `target` by `speedDeg * dt` degrees. Returns the new x / z. */
export function turntableStep(pos: Vec3, target: Vec3, speedDeg: number, dt: number): { x: number; z: number } {
  const a = (speedDeg * dt * Math.PI) / 180;
  const dx = pos[0] - target[0],
    dz = pos[2] - target[2];
  const c = Math.cos(a),
    s = Math.sin(a);
  return { x: target[0] + dx * c - dz * s, z: target[2] + dx * s + dz * c };
}

// ---- caption ---------------------------------------------------------------------------------------------------

export type CaptionPos = 'top-left' | 'top' | 'top-right' | 'bottom-left' | 'bottom' | 'bottom-right' | 'center';
export const CAPTION_POSITIONS: readonly { id: CaptionPos; label: string }[] = [
  { id: 'top-left', label: 'Top left' },
  { id: 'top', label: 'Top' },
  { id: 'top-right', label: 'Top right' },
  { id: 'center', label: 'Centre' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'bottom-right', label: 'Bottom right' },
];

/**
 * Opacity of a caption `t` seconds after presenting started. `hold` = 0 keeps it on; otherwise it fades in over
 * `fade` seconds, holds for `hold` seconds and fades out over `fade` seconds.
 */
export function captionOpacity(t: number, hold: number, fade: number): number {
  if (hold <= 0) return 1;
  const f = Math.max(0.05, fade);
  if (t < 0) return 0;
  if (t < f) return t / f;
  if (t < f + hold) return 1;
  return Math.max(0, 1 - (t - f - hold) / f);
}

// ---- options ---------------------------------------------------------------------------------------------------

export interface PresentOptions {
  captionOn: boolean;
  title: string;
  subtitle: string;
  captionPos: CaptionPos;
  /** Title size in CSS pixels (the subtitle is 45 % of it). */
  captionSize: number;
  /** 0 = always visible; otherwise seconds the caption stays after it fades in (then fades out). */
  captionHold: number;
  /** Draw the caption into captured images too. */
  captionInCapture: boolean;
  /** Vertical field of view in degrees. */
  fov: number;
  captureScale: CaptureScale;
  /** Switch to the high graphics tier (ambient occlusion, bigger shadow maps) for the capture only. */
  captureBest: boolean;
  turntableSpeed: number;
  /** Start turning as soon as presentation mode is entered. */
  turntableOnEnter: boolean;
  showToasts: boolean;
  /** Hide the joint markers (anchors, axes) while presenting and in captures; ropes and springs go with them. */
  hideJoints: boolean;
}

export const DEFAULT_PRESENT: PresentOptions = {
  captionOn: false,
  title: '',
  subtitle: '',
  captionPos: 'bottom-left',
  captionSize: 40,
  captionHold: 0,
  captionInCapture: true,
  fov: 48,
  captureScale: 2,
  captureBest: false,
  turntableSpeed: 12,
  turntableOnEnter: false,
  showToasts: false,
  hideJoints: true,
};

const POSITIONS = new Set<string>(CAPTION_POSITIONS.map((p) => p.id));
const num = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, max: number, d: string): string => (typeof v === 'string' ? v.slice(0, max) : d);

/** Validate options read from storage (or from anywhere else): wrong types and out-of-range values fall back. */
export function sanitizePresent(raw: unknown): PresentOptions {
  const d = DEFAULT_PRESENT;
  if (!isRecord(raw)) return { ...d };
  const scale = Number(raw.captureScale);
  return {
    captionOn: bool(raw.captionOn, d.captionOn),
    title: str(raw.title, 140, d.title),
    subtitle: str(raw.subtitle, 240, d.subtitle),
    captionPos:
      typeof raw.captionPos === 'string' && POSITIONS.has(raw.captionPos)
        ? (raw.captionPos as CaptionPos)
        : d.captionPos,
    captionSize: num(raw.captionSize, 14, 120, d.captionSize),
    captionHold: num(raw.captionHold, 0, 600, d.captionHold),
    captionInCapture: bool(raw.captionInCapture, d.captionInCapture),
    fov: num(raw.fov, 8, 100, d.fov),
    captureScale: (CAPTURE_SCALES as readonly number[]).includes(scale) ? (scale as CaptureScale) : d.captureScale,
    captureBest: bool(raw.captureBest, d.captureBest),
    turntableSpeed: num(raw.turntableSpeed, -90, 90, d.turntableSpeed),
    turntableOnEnter: bool(raw.turntableOnEnter, d.turntableOnEnter),
    showToasts: bool(raw.showToasts, d.showToasts),
    hideJoints: bool(raw.hideJoints, d.hideJoints),
  };
}

/** `my-scene-2x-1600x900.png` */
export function captureFileName(sceneName: string, scale: number, w: number, h: number): string {
  const base = (sceneName || 'scene').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'scene';
  return `${base}-${scale}x-${w}x${h}.png`;
}
