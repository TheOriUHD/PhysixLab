import { Emitter } from '../core/events';
import type { ColorMode } from '../render/bodyViews';
import { DEFAULT_OVERLAYS, type OverlayOptions } from '../render/overlays';
import type { Quality } from '../render/viewport';
import type { JointType } from '../model/types';
import { sanitizeAccent, sanitizeTheme, type ThemeId } from '../ui/theme';

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
  /** Ids of registered panels (src/app/registry/panels.ts); an unknown id falls back to the first tab. */
  leftTab: string;
  rightTab: string;
  showLeft: boolean;
  showRight: boolean;
  showBottom: boolean;
  bottomTab: string;
  seenWelcome: boolean;
  // -- VZ-50: UI theme --
  theme: ThemeId;
  /** Custom accent colour `#rrggbb`, or '' for the theme's own accent. */
  accent: string;
}

export const DEFAULT_PREFS: Prefs = {
  tool: 'select',
  gizmo: 'translate',
  space: 'world',
  snap: true,
  snapGrid: 0.25,
  snapAngle: 15,
  timeScale: 1,
  colorMode: 'material',
  overlays: { ...DEFAULT_OVERLAYS },
  showJoints: true,
  quality: 'medium',
  jointType: 'hinge',
  followSelection: false,
  blastStrength: 60,
  shootSpeed: 28,
  shootSize: 0.4,
  leftTab: 'add',
  rightTab: 'inspector',
  showLeft: true,
  showRight: true,
  showBottom: true,
  bottomTab: 'energy',
  seenWelcome: false,
  theme: 'dark',
  accent: '',
};

const KEY = 'physicslab:prefs:v1';

/** Reactive, persisted UI preferences. */
export class PrefsStore extends Emitter<{ change: (keyof Prefs)[] }> {
  value: Prefs;

  constructor() {
    super();
    this.value = { ...DEFAULT_PREFS, overlays: { ...DEFAULT_OVERLAYS } };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Prefs>;
        this.value = { ...this.value, ...saved, overlays: { ...DEFAULT_OVERLAYS, ...(saved.overlays ?? {}) } };
        this.value.tool = 'select';
        this.value.theme = sanitizeTheme(this.value.theme);
        this.value.accent = sanitizeAccent(this.value.accent);
      }
    } catch {
      /* storage unavailable */
    }
  }

  get<K extends keyof Prefs>(k: K): Prefs[K] {
    return this.value[k];
  }

  set(patch: Partial<Prefs>): void {
    if ('theme' in patch) patch = { ...patch, theme: sanitizeTheme(patch.theme) };
    if ('accent' in patch) patch = { ...patch, accent: sanitizeAccent(patch.accent) };
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
