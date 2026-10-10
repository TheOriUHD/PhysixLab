import { Emitter } from '../core/events';
import { sanitizeHighlight, DEFAULT_HIGHLIGHT, type HighlightOptions } from '../render/highlight';
import { cloneGraphics, DEFAULT_GRAPHICS, sanitizeGraphics, type GraphicsOptions } from '../render/graphics';
import type { ColorMode } from '../render/bodyViews';
import { DEFAULT_OVERLAYS, type OverlayOptions } from '../render/overlays';
import type { Quality } from '../render/viewport';
import type { JointType } from '../model/types';
// ── FX: visual-effects settings live in the preferences ──
import { DEFAULT_FX_SETTINGS, sanitizeFxSettings, type FxSettings } from '../render/fx/settings';
// ── FX: sound settings live in the preferences too ──
import { sanitizeAudioSettings, type AudioSettings } from '../audio/settings';
import { DEFAULT_INPUT, sanitizeInput, type InputSettings } from './input/settings';

/** The interaction mode (`ToolDef.mode`): 'select', 'joint', 'measure', 'blast', 'shoot' … — any registered tool's mode. */
export type ToolId = string;
export type GizmoKind = 'none' | 'translate' | 'rotate' | 'scale';

export interface Prefs {
  tool: ToolId;
  gizmo: GizmoKind;
  space: 'world' | 'local';
  snap: boolean;
  snapGrid: number;
  snapAngle: number;
  // -- ED-A snap: object snapping modes (src/model/edit/snap.ts); `snap` above stays the grid toggle --
  snapVertex: boolean;
  snapEdge: boolean;
  snapFace: boolean;
  snapBounds: boolean;
  /** Dragging / dropping puts objects flush on the surface under the pointer. */
  snapSurface: boolean;
  /** …and turns their up axis onto the surface normal. */
  snapAlignNormal: boolean;
  // -- /ED-A snap --
  timeScale: number;
  colorMode: ColorMode;
  overlays: OverlayOptions;
  showJoints: boolean;
  quality: Quality;
  jointType: JointType;
  followSelection: boolean;
  blastStrength: number;
  shootSpeed: number;
  shootSize: number;
  // -- ED-B: tool options (blast variants, throw/aim, paint, pin, grab) --
  blastKind: 'radial' | 'directional' | 'implosion' | 'ring' | 'gust';
  blastFalloff: 'quadratic' | 'linear' | 'smooth' | 'constant' | 'steep';
  blastRadius: number;
  /** Projectile type id (src/app/projectileTypes.ts). */
  shootType: string;
  /** Projectile mass in kg; 0 = the type's own mass. */
  shootMass: number;
  paintColor: string;
  paintPalette: string;
  paintMode: 'color' | 'material';
  paintMaterial: string;
  pinJoint: 'hinge' | 'ball' | 'fixed';
  /** Grab spring strength multiplier (1 = default). */
  grabStrength: number;
  /** Velocity kept on release (0 = drop, 1 = throw with the hand's velocity, 2 = boosted). */
  grabThrow: number;
  /** Ids of registered panels (src/app/registry/panels.ts); an unknown id falls back to the first tab. */
  leftTab: string;
  rightTab: string;
  showLeft: boolean;
  showRight: boolean;
  showBottom: boolean;
  bottomTab: string;
  seenWelcome: boolean;
  // ── FX: particles, impact effects, skid marks, explosions (src/render/fx) ──
  fx: FxSettings;
  // ── FX: sound — master volume, mute, per-category volumes, spatialisation (src/audio) ──
  audio: AudioSettings;
  // -- CM-A: key bindings, gamepad, touch and axis settings --
  input: InputSettings;
  // -- VZ-B: per-effect graphics options, tri-state `on` follows the quality tier --
  graphics: GraphicsOptions;
  // -- VZ-B: selection / hover highlight options (VZ-40) --
  highlight: HighlightOptions;
}

export const DEFAULT_PREFS: Prefs = {
  tool: 'select',
  gizmo: 'translate',
  space: 'world',
  snap: true,
  snapGrid: 0.25,
  snapAngle: 15,
  // -- ED-A snap --
  snapVertex: true,
  snapEdge: false,
  snapFace: false,
  snapBounds: false,
  snapSurface: true,
  snapAlignNormal: false,
  // -- /ED-A snap --
  timeScale: 1,
  colorMode: 'material',
  overlays: { ...DEFAULT_OVERLAYS },
  showJoints: true,
  quality: 'auto', // -- VZ-B: Auto governor (VZ-22) --
  jointType: 'hinge',
  followSelection: false,
  blastStrength: 60,
  shootSpeed: 28,
  shootSize: 0.4,
  blastKind: 'radial',
  blastFalloff: 'quadratic',
  blastRadius: 7,
  shootType: 'ball',
  shootMass: 0,
  paintColor: '#ff5d5d',
  paintPalette: 'vivid',
  paintMode: 'color',
  paintMaterial: 'plastic',
  pinJoint: 'hinge',
  grabStrength: 1,
  grabThrow: 1,
  leftTab: 'add',
  rightTab: 'inspector',
  showLeft: true,
  showRight: true,
  showBottom: true,
  bottomTab: 'energy',
  seenWelcome: false,
  fx: { ...DEFAULT_FX_SETTINGS },
  audio: sanitizeAudioSettings(undefined),
  input: DEFAULT_INPUT, // -- CM-A --
  // -- VZ-B: per-effect graphics options (VZ-20..22) --
  graphics: cloneGraphics(DEFAULT_GRAPHICS),
  highlight: { ...DEFAULT_HIGHLIGHT },
};

const KEY = 'physicslab:prefs:v1';

/** Reactive, persisted UI preferences. */
export class PrefsStore extends Emitter<{ change: (keyof Prefs)[] }> {
  value: Prefs;

  constructor() {
    super();
    this.value = {
      ...DEFAULT_PREFS,
      overlays: { ...DEFAULT_OVERLAYS },
      fx: { ...DEFAULT_FX_SETTINGS },
      audio: sanitizeAudioSettings(undefined), // ── FX ──
      graphics: cloneGraphics(DEFAULT_GRAPHICS), // -- VZ-B --
      highlight: { ...DEFAULT_HIGHLIGHT },
    };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Prefs>;
        this.value = { ...this.value, ...saved, overlays: { ...DEFAULT_OVERLAYS, ...(saved.overlays ?? {}) } };
        this.value.tool = 'select';
        this.value.fx = sanitizeFxSettings(saved.fx); // ── FX: stored values are validated ──
        this.value.audio = sanitizeAudioSettings(saved.audio); // ── FX ──
        this.value.input = sanitizeInput(saved.input); // -- CM-A --
        this.value.graphics = sanitizeGraphics(saved.graphics); // -- VZ-B --
        this.value.highlight = sanitizeHighlight(saved.highlight);
      }
    } catch {
      /* storage unavailable */
    }
  }

  get<K extends keyof Prefs>(k: K): Prefs[K] {
    return this.value[k];
  }

  set(patch: Partial<Prefs>): void {
    const keys: (keyof Prefs)[] = [];
    for (const k of Object.keys(patch) as (keyof Prefs)[]) {
      if (this.value[k] !== patch[k]) keys.push(k);
    }
    if (!keys.length) return;
    this.value = { ...this.value, ...patch };
    this.emit('change', keys);
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value));
    } catch {
      /* ignore */
    }
  }

  setOverlay(patch: Partial<OverlayOptions>): void {
    this.set({ overlays: { ...this.value.overlays, ...patch } });
  }
}
