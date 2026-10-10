/**
 * Environment presets (VZ-11): each describes a sky look (the visible gradient), the image-based lighting built from
 * a tiny procedural "studio" (gradient dome + light panels, prefiltered by PMREM), the sun light and the
 * recommended sun direction. Presets are data; `environment.ts` applies them.
 */
import {
  BackSide,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import type { SkyPreset } from '../model/types';

export interface EnvPanel {
  w: number;
  h: number;
  /** Direction from the centre (does not need to be normalised). */
  dir: [number, number, number];
  intensity: number;
  color: string;
}

export interface EnvPresetDef {
  id: Exclude<SkyPreset, 'physical' | 'hdri'>;
  label: string;
  /** Visible sky gradient. */
  zenith: string;
  horizon: string;
  ground: string;
  /** Dome gradient used for the lighting (top / middle / bottom), linear-ish, multiplied by `domeGain`. */
  top: string;
  mid: string;
  low: string;
  domeGain: number;
  panels: EnvPanel[];
  /** Sun light colour and intensity at full strength (0 = no direct sun). */
  sunColor: string;
  sunIntensity: number;
  /** Recommended sun azimuth / elevation (degrees) applied when the preset is picked in the UI. */
  sunAzimuth: number;
  sunElevation: number;
  ambientColor: string;
  ambientIntensity: number;
  /** Scales `scene.environmentIntensity`. */
  envIntensity: number;
  /** Recommended fog colour when fog is enabled. */
  fog: string;
  /** Recommended ground colour. */
  groundColor: string;
}

const soft = (w: number, h: number, dir: [number, number, number], intensity: number, color: string): EnvPanel => ({
  w,
  h,
  dir,
  intensity,
  color,
});

export const ENV_PRESETS: EnvPresetDef[] = [
  {
    id: 'studio',
    label: 'Studio',
    zenith: '#0b1019',
    horizon: '#27344a',
    ground: '#10151d',
    top: '#1a2440',
    mid: '#4d6185',
    low: '#121419',
    domeGain: 1.2,
    panels: [
      soft(30, 18, [-20, 30, 15], 9, '#fff1de'),
      soft(18, 10, [25, 12, -18], 3.2, '#9ec5ff'),
      soft(40, 6, [0, 8, 30], 1.6, '#ffffff'),
    ],
    sunColor: '#fff3e0',
    sunIntensity: 3.2,
    sunAzimuth: 235,
    sunElevation: 52,
    ambientColor: '#8fa3c4',
    ambientIntensity: 0.18,
    envIntensity: 0.85,
    fog: '#1b2330',
    groundColor: '#2b3038',
  },
  {
    id: 'day',
    label: 'Sunny field',
    zenith: '#3f7fd6',
    horizon: '#bcd8f2',
    ground: '#6b7f5a',
    top: '#4f8fe0',
    mid: '#b8d4f0',
    low: '#6f8a5a',
    domeGain: 1.5,
    panels: [soft(10, 10, [-30, 55, 20], 22, '#fff4de')],
    sunColor: '#fff1d6',
    sunIntensity: 4.2,
    sunAzimuth: 220,
    sunElevation: 55,
    ambientColor: '#b9d2f0',
    ambientIntensity: 0.25,
    envIntensity: 0.9,
    fog: '#b7d3ee',
    groundColor: '#5d7a45',
  },
  {
    id: 'overcast',
    label: 'Overcast',
    zenith: '#8a949f',
    horizon: '#c3c9cf',
    ground: '#7d8186',
    top: '#9ba5b0',
    mid: '#c8ced4',
    low: '#868a8e',
    domeGain: 1.2,
    panels: [],
    sunColor: '#e8eef5',
    sunIntensity: 0.6,
    sunAzimuth: 220,
    sunElevation: 60,
    ambientColor: '#c8d2dc',
    ambientIntensity: 0.4,
    envIntensity: 1.05,
    fog: '#bcc3ca',
    groundColor: '#62686e',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    zenith: '#2c2f5e',
    horizon: '#ff8c52',
    ground: '#2a1d1f',
    top: '#3a3f7a',
    mid: '#e9825a',
    low: '#2b1e22',
    domeGain: 1.3,
    panels: [soft(14, 8, [-60, 6, 10], 28, '#ff9a55')],
    sunColor: '#ff9a5c',
    sunIntensity: 3.4,
    sunAzimuth: 265,
    sunElevation: 6,
    ambientColor: '#c88a8a',
    ambientIntensity: 0.22,
    envIntensity: 0.9,
    fog: '#d9825e',
    groundColor: '#3a2e2c',
  },
  {
    id: 'night',
    label: 'Night city',
    zenith: '#02040a',
    horizon: '#1a2342',
    ground: '#05070c',
    top: '#070b1c',
    mid: '#1d2a52',
    low: '#05060a',
    domeGain: 1.0,
    panels: [
      soft(6, 3, [-40, 4, 20], 7, '#ffb347'),
      soft(5, 3, [30, 3, -30], 6, '#5ec8ff'),
      soft(8, 2, [10, 3, 40], 5, '#ff5d9e'),
      soft(10, 10, [20, 60, -30], 0.8, '#aabbff'),
    ],
    sunColor: '#8fa6ff',
    sunIntensity: 0.45,
    sunAzimuth: 120,
    sunElevation: 38,
    ambientColor: '#3a4a7a',
    ambientIntensity: 0.14,
    envIntensity: 1.0,
    fog: '#0a1022',
    groundColor: '#12151c',
  },
  {
    id: 'blueprint',
    label: 'Blueprint',
    zenith: '#0e3a78',
    horizon: '#1d5fb0',
    ground: '#0b2f66',
    top: '#1d5fb0',
    mid: '#3b86d6',
    low: '#0b2f66',
    domeGain: 1.0,
    panels: [soft(30, 18, [-20, 30, 15], 4, '#e6f2ff')],
    sunColor: '#e6f2ff',
    sunIntensity: 2.4,
    sunAzimuth: 235,
    sunElevation: 50,
    ambientColor: '#9fc6ff',
    ambientIntensity: 0.3,
    envIntensity: 0.8,
    fog: '#12468c',
    groundColor: '#0d3a7a',
  },
  {
    id: 'space',
    label: 'Space',
    zenith: '#000003',
    horizon: '#02030a',
    ground: '#000002',
    top: '#010208',
    mid: '#03040c',
    low: '#000002',
    domeGain: 1.0,
    panels: [soft(8, 8, [40, 30, 20], 40, '#fff8ee'), soft(20, 20, [-40, -10, -20], 0.6, '#5a7bff')],
    sunColor: '#fff8ee',
    sunIntensity: 5.0,
    sunAzimuth: 40,
    sunElevation: 28,
    ambientColor: '#1a2240',
    ambientIntensity: 0.05,
    envIntensity: 0.7,
    fog: '#000003',
    groundColor: '#15171c',
  },
  {
    id: 'lab',
    label: 'Lab',
    zenith: '#cfd6dd',
    horizon: '#e7ebef',
    ground: '#9aa0a6',
    top: '#e6ebf0',
    mid: '#f0f3f6',
    low: '#a7adb3',
    domeGain: 1.3,
    panels: [
      soft(24, 24, [0, 40, 0], 6, '#ffffff'),
      soft(14, 8, [-30, 14, 10], 3, '#f4faff'),
      soft(14, 8, [30, 14, -10], 3, '#f4faff'),
    ],
    sunColor: '#ffffff',
    sunIntensity: 1.6,
    sunAzimuth: 235,
    sunElevation: 70,
    ambientColor: '#ffffff',
    ambientIntensity: 0.35,
    envIntensity: 1.0,
    fog: '#dfe4e9',
    groundColor: '#c9ced3',
  },
  {
    id: 'desert',
    label: 'Desert',
    zenith: '#4b86c8',
    horizon: '#f0d7a8',
    ground: '#b9935d',
    top: '#5d97d8',
    mid: '#f1d9ad',
    low: '#c49b62',
    domeGain: 1.5,
    panels: [soft(10, 10, [-25, 60, 20], 26, '#fff0d0')],
    sunColor: '#fff0d2',
    sunIntensity: 4.6,
    sunAzimuth: 225,
    sunElevation: 62,
    ambientColor: '#f3d9ae',
    ambientIntensity: 0.28,
    envIntensity: 0.95,
    fog: '#ecd2a4',
    groundColor: '#c9a468',
  },
  {
    id: 'snow',
    label: 'Snow',
    zenith: '#9db7d6',
    horizon: '#e6eef7',
    ground: '#dfe8f2',
    top: '#aac4e2',
    mid: '#e8f0f8',
    low: '#dde7f2',
    domeGain: 1.5,
    panels: [soft(12, 12, [-20, 45, 25], 12, '#f4f8ff')],
    sunColor: '#f4f8ff',
    sunIntensity: 3.0,
    sunAzimuth: 215,
    sunElevation: 35,
    ambientColor: '#d8e6f6',
    ambientIntensity: 0.4,
    envIntensity: 1.1,
    fog: '#dde8f4',
    groundColor: '#e8eef6',
  },
];

export const ENV_PRESET_BY_ID = new Map(ENV_PRESETS.map((p) => [p.id as string, p]));

/** Sun direction (unit, pointing from the origin toward the sun) for compass azimuth / elevation in degrees. */
export function sunDirection(azimuthDeg: number, elevationDeg: number, out = new Vector3()): Vector3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

/** Sun azimuth / elevation for a solar time (hours): rises in the east at 6, due south and highest at 12, sets west at 18. */
export function sunFromTime(hours: number): { azimuth: number; elevation: number } {
  const t = ((hours % 24) + 24) % 24;
  return { azimuth: (90 + (t - 6) * 15 + 360) % 360, elevation: 68 * Math.sin(((t - 6) / 12) * Math.PI) };
}

/** Procedural lighting scene of a preset: a three-colour dome plus softbox panels (and the sun as a bright disc). */
export function buildEnvScene(p: EnvPresetDef, sun: Vector3): Scene {
  const env = new Scene();
  const dome = new Mesh(
    new SphereGeometry(50, 32, 16),
    new ShaderMaterial({
      uniforms: {
        uTop: { value: new Color(p.top) },
        uMid: { value: new Color(p.mid) },
        uLow: { value: new Color(p.low) },
        uGain: { value: p.domeGain },
      },
      vertexShader:
        'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP; uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uLow; uniform float uGain;
        void main(){ float h = vP.y;
          vec3 c = h > 0.0 ? mix(uMid, uTop, pow(h, 0.6)) : mix(uMid, uLow, pow(-h, 0.5));
          gl_FragColor = vec4(c * uGain, 1.0); }`,
      side: BackSide,
    }),
  );
  env.add(dome);
  const panel = (w: number, h: number, dir: Vector3, intensity: number, color: string) => {
    const m = new Mesh(
      new PlaneGeometry(w, h),
      new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity), side: DoubleSide }),
    );
    m.position.copy(dir).normalize().multiplyScalar(40);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  for (const q of p.panels) panel(q.w, q.h, new Vector3(...q.dir), q.intensity, q.color);
  if (p.sunIntensity > 1 && sun.y > -0.05) panel(6, 6, sun, p.sunIntensity * 4, p.sunColor);
  return env;
}

/** Free the geometries / materials of a scene built by `buildEnvScene`. */
export function disposeEnvScene(s: Scene): void {
  s.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as { dispose?: () => void } | undefined;
    mat?.dispose?.();
  });
}
