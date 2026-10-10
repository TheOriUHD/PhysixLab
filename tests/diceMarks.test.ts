/**
 * Package SH, chunk 2 — the marks painted on the dice (SH-10): pips on the d6, one number per face of the d8 … d20,
 * three corner labels per face of the d4. The placement is pure geometry (`diceMarks.ts`), so it is checked without a
 * canvas: every label sits inside its face with room to spare, one font size serves the whole die, and a number
 * that reads as another one upside down (6 and 9) carries an underline.
 */
import { describe, expect, it } from 'vitest';
import { DIE_FACES, DIE_KINDS, dieLayout } from '../src/model/shapes/diceLayout';
import { DIGIT_HEIGHT, DIGIT_WIDTH, dieMarks, fitTextSize, needsUnderline } from '../src/model/shapes/diceMarks';

type P2 = [number, number];

/** Corners of the text box of a mark, counter-clockwise rotated, in cell units. */
function corners(m: { x: number; y: number; size: number; angle: number; text: string; underline: boolean }): P2[] {
  const w = m.text.length * DIGIT_WIDTH * m.size,
    h = DIGIT_HEIGHT * m.size;
  const c = Math.cos(m.angle),
    s = Math.sin(m.angle);
  return (
    [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ] as P2[]
  ).map(([x, y]): P2 => [m.x + x * c - y * s, m.y + x * s + y * c]);
}

function inside(poly: P2[], p: P2, margin = 0): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0],
      ey = b[1] - a[1];
    const l = Math.hypot(ex, ey);
    if ((-ey / l) * (p[0] - a[0]) + (ex / l) * (p[1] - a[1]) < margin) return false;
  }
  return true;
}

describe('dice marks (SH-10)', () => {
  it.each(DIE_KINDS)('%s: a mark set for every face, all inside the cell of the atlas', (kind) => {
    const marks = dieMarks(kind);
    expect(marks).toHaveLength(DIE_FACES[kind]);
    for (const fm of marks) {
      expect(fm.marks.length).toBeGreaterThan(0);
      for (const m of fm.marks) {
        expect(Math.abs(m.x)).toBeLessThan(0.5);
        expect(Math.abs(m.y)).toBeLessThan(0.5);
      }
    }
  });

  it('d6: the pips of a face are as many as its number, inside the face, round and the same size', () => {
    for (const fm of dieMarks('d6')) {
      expect(fm.marks).toHaveLength(fm.face.value);
      const radii = new Set(fm.marks.map((m) => (m.kind === 'pip' ? m.r.toFixed(6) : 'text')));
      expect(radii.size).toBe(1);
      for (const m of fm.marks) {
        expect(m.kind).toBe('pip');
        if (m.kind === 'pip') {
          expect(Math.abs(m.x) + m.r).toBeLessThan(0.46);
          expect(Math.abs(m.y) + m.r).toBeLessThan(0.46);
        }
      }
    }
  });

  it.each(['d8', 'd10', 'd12', 'd20'] as const)(
    '%s: each face carries its number, fully inside the face and at one size',
    (kind) => {
      const marks = dieMarks(kind);
      const sizes = new Set<string>();
      for (const fm of marks) {
        expect(fm.marks).toHaveLength(1);
        const m = fm.marks[0];
        if (m.kind !== 'text') throw new Error('expected a number');
        expect(m.text).toBe(String(fm.face.value));
        sizes.add(m.size.toFixed(6));
        for (const c of corners(m)) expect(inside(fm.polygon, c, 0.01), `${kind} ${m.text}`).toBe(true);
        expect(m.size).toBeGreaterThan(0.1); // large enough to read
      }
      expect(sizes.size).toBe(1);
    },
  );

  it('d4: three corner labels per face, each upright toward its corner, all different from the face’s own number', () => {
    for (const fm of dieMarks('d4')) {
      expect(fm.marks).toHaveLength(3);
      const texts = fm.marks.map((m) => (m.kind === 'text' ? m.text : ''));
      expect(new Set(texts).size).toBe(3);
      expect(texts).not.toContain(String(fm.face.value));
      for (const m of fm.marks) {
        if (m.kind !== 'text') throw new Error('expected a label');
        for (const c of corners(m)) expect(inside(fm.polygon, c, 0.005), `d4 label ${m.text}`).toBe(true);
        // the top of the label points away from the middle of the face, to the corner the label belongs to
        const up: P2 = [-Math.sin(m.angle), Math.cos(m.angle)];
        expect(up[0] * m.x + up[1] * m.y).toBeGreaterThan(0);
      }
    }
  });

  it('6 and 9 are underlined, other numbers are not; d10 0–9 likewise', () => {
    expect(needsUnderline('d20', 6)).toBe(true);
    expect(needsUnderline('d20', 9)).toBe(true);
    for (const v of [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
      expect(needsUnderline('d20', v), String(v)).toBe(false);
    expect(needsUnderline('d10', 0)).toBe(false);
    expect(needsUnderline('d10', 6)).toBe(true);
    expect(needsUnderline('d10', 9)).toBe(true);
    expect(needsUnderline('d8', 6)).toBe(false); // there is no 9 on a d8 to mistake it for
    const flagged = dieMarks('d20').flatMap((fm) => fm.marks.filter((m) => m.kind === 'text' && m.underline));
    expect(flagged).toHaveLength(2);
  });

  it('fitTextSize: a box fits a square at half its width, and not at all outside', () => {
    const square: P2[] = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ];
    expect(fitTextSize(square, [0, 0], 1, 1, 0, 0)).toBeCloseTo(1, 9);
    expect(fitTextSize(square, [0.4, 0], 1, 1, 0, 0)).toBeCloseTo(0.2, 9);
    expect(fitTextSize(square, [2, 0], 1, 1, 0, 0)).toBeLessThan(0);
    // turned by 45° the box needs more room
    expect(fitTextSize(square, [0, 0], 1, 1, Math.PI / 4, 0)).toBeCloseTo(1 / Math.SQRT2, 9);
  });

  it('every face of every die has its own cell (the marks of two faces never share texels)', () => {
    for (const kind of DIE_KINDS) {
      const cells = new Set(dieLayout(kind).faces.map((f) => `${f.col},${f.row}`));
      expect(cells.size).toBe(DIE_FACES[kind]);
    }
  });
});
