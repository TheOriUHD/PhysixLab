/**
 * What is painted on the faces of a die: pips on the d6, a number on each face of the d8/d10/d12/d20, three corner
 * labels on each face of the d4. Pure geometry — positions and sizes in the cell of the atlas (`diceLayout.ts`),
 * in units of the cell's width with y up and the origin at the middle of the cell — so the layout is testable
 * without a canvas and `src/render/dicePainter.ts` only has to draw it.
 *
 * Numbers are as large as fit: one font size for the whole die (the size at which the widest label still fits the
 * tightest face, as on a real die), each label at the spot of its face where it has the most room — the middle of
 * a pentagon, the broad end of a kite. A number that could be read upside down as another one (6 and 9) carries
 * an underline.
 */
import { memo } from './memo';
import { DIE_FACES, dieLayout, pipPositions, type DieFace, type DieKind, type DieLayout } from './diceLayout';

export type Mark =
  | { kind: 'pip'; x: number; y: number; r: number }
  | {
      kind: 'text';
      text: string;
      /** Centre of the digits. */
      x: number;
      y: number;
      /** Font size (the em), cell widths. */
      size: number;
      /** Counter-clockwise rotation of the text, radians. */
      angle: number;
      underline: boolean;
    };

export interface FaceMarks {
  face: DieFace;
  /** The face polygon in cell units (counter-clockwise, y up) — the area the marks must stay inside. */
  polygon: [number, number][];
  marks: Mark[];
}

/** Digit metrics of the bold sans-serif the painter uses, in ems. */
export const DIGIT_WIDTH = 0.6;
export const DIGIT_HEIGHT = 0.72;
/** Gap between the digits and their underline, and the underline's thickness, in ems. */
export const UNDERLINE_GAP = 0.1;
export const UNDERLINE_THICKNESS = 0.08;
/** How far a label stays from the edge of its face, cell widths. */
const MARGIN = 0.035;
/** Pip radius as a fraction of the face edge. */
const PIP_RADIUS = 0.078;

const EDGE_SCALE = 0.46;

type P2 = [number, number];

/** The face polygon in cell units. */
export function facePolygon(face: DieFace): P2[] {
  const k = EDGE_SCALE / face.halfSpan;
  return face.verts.map((v): P2 => {
    const d = [v[0] - face.centre[0], v[1] - face.centre[1], v[2] - face.centre[2]];
    return [
      (d[0] * face.right[0] + d[1] * face.right[1] + d[2] * face.right[2]) * k,
      (d[0] * face.up[0] + d[1] * face.up[1] + d[2] * face.up[2]) * k,
    ];
  });
}

/** The label as printed: "0"–"9" … "20". */
export const dieLabel = (value: number): string => String(value);

/** True when the label read upside down is another valid number of the die: such a label gets an underline. */
export function needsUnderline(kind: DieKind, value: number): boolean {
  const FLIP: Record<string, string> = { '0': '0', '1': '1', '6': '9', '8': '8', '9': '6' };
  const label = dieLabel(value);
  const digits = label.split('').reverse();
  if (!digits.every((c) => c in FLIP)) return false; // a 2, 3, 4, 5 or 7 does not read as a digit upside down
  const flipped = digits.map((c) => FLIP[c]).join('');
  if (flipped === label) return false;
  const n = Number(flipped);
  const first = kind === 'd10' ? 0 : 1;
  const last = kind === 'd10' ? 9 : DIE_FACES[kind];
  // the upside-down reading must be a real label of the die (“10” read upside down is “01”, which is nobody’s face)
  return Number.isInteger(n) && n >= first && n <= last && String(n) === flipped;
}

/** Half-extent of a rectangle `w × h` along unit direction `n`, the rectangle turned by `angle`. */
const support = (n: P2, w: number, h: number, angle: number): number => {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return Math.abs(n[0] * c + n[1] * s) * (w / 2) + Math.abs(-n[0] * s + n[1] * c) * (h / 2);
};

/** Largest font size at which a `w × h` em text box centred at `c` and turned by `angle` stays inside the polygon. */
export function fitTextSize(polygon: P2[], c: P2, w: number, h: number, angle: number, margin = MARGIN): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    const ex = b[0] - a[0],
      ey = b[1] - a[1];
    const l = Math.hypot(ex, ey) || 1;
    const n: P2 = [-ey / l, ex / l]; // inward for a counter-clockwise polygon
    const room = n[0] * (c[0] - a[0]) + n[1] * (c[1] - a[1]) - margin;
    best = Math.min(best, room / Math.max(1e-9, support(n, w, h, angle)));
  }
  return best;
}

/** The spot of the polygon where a `w × h` em box fits largest, and that size. */
export function bestSpot(polygon: P2[], w: number, h: number): { x: number; y: number; size: number } {
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const p of polygon) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
  }
  let best = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, size: -Infinity };
  // coarse grid, then twice finer around the best spot
  let sx = (x1 - x0) / 2,
    sy = (y1 - y0) / 2;
  for (let pass = 0; pass < 4; pass++) {
    const cx = best.size === -Infinity ? (x0 + x1) / 2 : best.x;
    const cy = best.size === -Infinity ? (y0 + y1) / 2 : best.y;
    for (let i = -10; i <= 10; i++)
      for (let j = -10; j <= 10; j++) {
        const x = cx + (i / 10) * sx,
          y = cy + (j / 10) * sy;
        const size = fitTextSize(polygon, [x, y], w, h, 0);
        if (size > best.size) best = { x, y, size };
      }
    sx /= 5;
    sy /= 5;
  }
  return best;
}

/** The text box of a label in ems: its width, and its height with the underline when it has one. */
function boxOf(text: string, underline: boolean): { w: number; h: number; dy: number } {
  const w = text.length * DIGIT_WIDTH;
  if (!underline) return { w, h: DIGIT_HEIGHT, dy: 0 };
  const extra = UNDERLINE_GAP + UNDERLINE_THICKNESS;
  // the box covers the digits and the bar below; its centre sits half the bar lower than the digits'
  return { w, h: DIGIT_HEIGHT + extra, dy: -extra / 2 };
}

export function dieMarks(kind: DieKind): FaceMarks[] {
  return memo(`die|marks|${kind}`, () => {
    const layout: DieLayout = dieLayout(kind);
    if (kind === 'd6') {
      return layout.faces.map((face): FaceMarks => {
        const k = EDGE_SCALE / face.halfSpan;
        const r = PIP_RADIUS * 2 * face.halfSpan * k;
        return {
          face,
          polygon: facePolygon(face),
          marks: pipPositions(face.value).map(([x, y]): Mark => ({
            kind: 'pip',
            x: x * 2 * face.halfSpan * k,
            y: y * 2 * face.halfSpan * k,
            r,
          })),
        };
      });
    }
    if (kind === 'd4') {
      return layout.faces.map((face): FaceMarks => {
        const polygon = facePolygon(face);
        const k = EDGE_SCALE / face.halfSpan;
        // one font size for the three labels: the largest at which each fits near its corner
        const corners = (face.corners ?? []).map((c) => ({ label: c.label, x: c.x * k, y: c.y * k }));
        const marks: Mark[] = [];
        let size = Infinity;
        const placed = corners.map((c) => {
          const t = 0.5; // the label's centre, as a fraction of the way from the middle of the face to the corner
          const x = c.x * t,
            y = c.y * t;
          const angle = Math.atan2(c.y, c.x) - Math.PI / 2;
          const text = dieLabel(c.label);
          const box = boxOf(text, needsUnderline(kind, c.label));
          size = Math.min(size, fitTextSize(polygon, [x, y], box.w, box.h, angle));
          return { x, y, angle, text, label: c.label };
        });
        for (const p of placed)
          marks.push({
            kind: 'text',
            text: p.text,
            x: p.x,
            y: p.y,
            size: Math.max(0.04, Math.min(size, 0.34)),
            angle: p.angle,
            underline: needsUnderline(kind, p.label),
          });
        return { face, polygon, marks };
      });
    }
    // numbered faces: one size for all, each label at its roomiest spot
    const polygons = layout.faces.map(facePolygon);
    const longest = Math.max(...layout.faces.map((f) => dieLabel(f.value).length));
    let size = 0.34;
    const spots = layout.faces.map((face, i) => {
      const under = needsUnderline(kind, face.value);
      const box = boxOf(dieLabel(face.value), under);
      const wide = boxOf('0'.repeat(longest), under);
      const spot = bestSpot(polygons[i], wide.w, wide.h);
      size = Math.min(size, spot.size);
      return { box, under };
    });
    return layout.faces.map((face, i): FaceMarks => {
      const { box, under } = spots[i];
      const spot = bestSpot(polygons[i], box.w, box.h);
      return {
        face,
        polygon: polygons[i],
        marks: [
          {
            kind: 'text',
            text: dieLabel(face.value),
            x: spot.x,
            // the digits sit above the centre of the box when there is an underline below them
            y: spot.y - box.dy * size,
            size,
            angle: 0,
            underline: under,
          },
        ],
      };
    });
  });
}
