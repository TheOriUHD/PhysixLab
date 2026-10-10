/**
 * VZ-40: highlight upgrades. Options (prefs `highlight`), palettes (one of them colour-blind safe: Okabe–Ito hues that
 * stay apart for the common forms of colour blindness), and `SelectionDecor`, the optional world-aligned bounding
 * box and local axis triad drawn around selected bodies.
 */
import {
  AxesHelper,
  Box3,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Vector3,
  type Object3D,
} from 'three';

export type HighlightPalette = 'default' | 'colorblind';

export interface HighlightOptions {
  palette: HighlightPalette;
  /** Pulse the selection outline (a slow breathing of its strength). */
  pulse: boolean;
  /** Draw the bounding box of every selected body. */
  bbox: boolean;
  /** Draw the local axes of every selected body. */
  axes: boolean;
  /** Outline bodies linked to the selection (a joint's two bodies glow). */
  linked: boolean;
}

export const DEFAULT_HIGHLIGHT: HighlightOptions = {
  palette: 'default',
  pulse: false,
  bbox: false,
  axes: false,
  linked: true,
};

export interface HighlightColors {
  /** A single selected object. */
  selected: string;
  /** Each member of a multi-selection. */
  multi: string;
  hover: string;
  /** Bodies linked to the selection (the ends of a selected joint). */
  linked: string;
  /** Colour of the part of an outline hidden behind other geometry. */
  hiddenFactor: number;
}

export const PALETTES: Record<HighlightPalette, HighlightColors> = {
  default: { selected: '#5ec8ff', multi: '#b48cff', hover: '#ffd166', linked: '#7dffa8', hiddenFactor: 0.4 },
  // Okabe–Ito: sky blue / orange-vermillion / yellow / bluish green — distinguishable under deuter-, prot- and tritanopia.
  colorblind: { selected: '#56b4e9', multi: '#d55e00', hover: '#f0e442', linked: '#cc79a7', hiddenFactor: 0.45 },
};

export function sanitizeHighlight(raw: unknown): HighlightOptions {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    palette: r.palette === 'colorblind' ? 'colorblind' : 'default',
    pulse: b(r.pulse, DEFAULT_HIGHLIGHT.pulse),
    bbox: b(r.bbox, DEFAULT_HIGHLIGHT.bbox),
    axes: b(r.axes, DEFAULT_HIGHLIGHT.axes),
    linked: b(r.linked, DEFAULT_HIGHLIGHT.linked),
  };
}

/** Ids of the bodies a selection of joints points at (their two ends), excluding anything already selected. */
export function linkedBodyIds(
  selection: readonly string[],
  jointEnds: (id: string) => readonly (string | null)[] | undefined,
): string[] {
  const sel = new Set(selection);
  const out = new Set<string>();
  for (const id of selection) {
    for (const end of jointEnds(id) ?? []) if (end && !sel.has(end)) out.add(end);
  }
  return [...out];
}

const MAX_DECORATED = 24;

// Edges of a unit box centred on the origin.
const BOX_EDGES = (() => {
  const c = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  const out: number[] = [];
  for (const i of e) out.push(c[i][0] * 0.5, c[i][1] * 0.5, c[i][2] * 0.5);
  return new Float32BufferAttribute(out, 3);
})();

interface Slot {
  box: LineSegments;
  axes: AxesHelper;
}

/** Bounding boxes and axis triads for the selected bodies; pooled, so selecting does not allocate. */
export class SelectionDecor {
  readonly group = new Group();
  private slots: Slot[] = [];
  private readonly geo = new BufferGeometry();
  private readonly mat = new LineBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false, fog: false });
  private readonly box3 = new Box3();
  private readonly size = new Vector3();
  private readonly centre = new Vector3();

  constructor() {
    this.geo.setAttribute('position', BOX_EDGES);
    this.group.renderOrder = 990;
    this.group.visible = false;
  }

  setColor(css: string): void {
    this.mat.color.set(css);
  }

  /** Place the decor around `objects` (body pose carriers); `bbox` / `axes` choose what is drawn. */
  update(objects: readonly Object3D[], bbox: boolean, axes: boolean): void {
    const n = bbox || axes ? Math.min(objects.length, MAX_DECORATED) : 0;
    this.group.visible = n > 0;
    for (let i = 0; i < Math.max(n, this.slots.length); i++) {
      if (i >= n) {
        if (this.slots[i]) {
          this.slots[i].box.visible = false;
          this.slots[i].axes.visible = false;
        }
        continue;
      }
      const slot = (this.slots[i] ??= this.makeSlot());
      const o = objects[i];
      this.box3.setFromObject(o);
      if (this.box3.isEmpty()) {
        slot.box.visible = slot.axes.visible = false;
        continue;
      }
      this.box3.getSize(this.size);
      this.box3.getCenter(this.centre);
      slot.box.visible = bbox;
      if (bbox) {
        slot.box.position.copy(this.centre);
        slot.box.scale.copy(this.size).addScalar(0.02);
      }
      slot.axes.visible = axes;
      if (axes) {
        const k = Math.max(0.3, Math.max(this.size.x, this.size.y, this.size.z) * 0.75);
        o.getWorldPosition(slot.axes.position);
        o.getWorldQuaternion(slot.axes.quaternion);
        slot.axes.scale.setScalar(k);
      }
    }
  }

  private makeSlot(): Slot {
    const box = new LineSegments(this.geo, this.mat);
    box.frustumCulled = false;
    const axes = new AxesHelper(1);
    (axes.material as LineBasicMaterial).depthTest = false;
    axes.frustumCulled = false;
    axes.renderOrder = 991;
    this.group.add(box, axes);
    return { box, axes };
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    for (const s of this.slots) {
      (s.axes.material as LineBasicMaterial).dispose();
      s.axes.geometry.dispose();
    }
  }
}
