/**
 * Paints the atlas of a die: one cell per face (`diceLayout.ts`), with the pips or numbers of `diceMarks.ts`.
 * The atlas is an ink mask — black where the die is bare, white where there is ink — and `shapeSurface.ts` mixes
 * the ink with the body's colour in the material, so a die of any colour shows readable marks.
 */
import { DIE_CELL_PX, dieLayout, type DieKind } from '../model/shapes/diceLayout';
import { DIGIT_HEIGHT, DIGIT_WIDTH, dieMarks, UNDERLINE_GAP, UNDERLINE_THICKNESS } from '../model/shapes/diceMarks';

const FONT = '"Arial Black", "Helvetica Neue", Arial, Helvetica, sans-serif';

export function paintDiceAtlas(kind: DieKind): HTMLCanvasElement {
  const layout = dieLayout(kind);
  const canvas = document.createElement('canvas');
  canvas.width = layout.cols * DIE_CELL_PX;
  canvas.height = layout.rows * DIE_CELL_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const { face, marks } of dieMarks(kind)) {
    const ox = (face.col + 0.5) * DIE_CELL_PX;
    const oy = (face.row + 0.5) * DIE_CELL_PX;
    for (const m of marks) {
      const x = ox + m.x * DIE_CELL_PX;
      const y = oy - m.y * DIE_CELL_PX;
      if (m.kind === 'pip') {
        ctx.beginPath();
        ctx.arc(x, y, m.r * DIE_CELL_PX, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const em = m.size * DIE_CELL_PX;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-m.angle);
      ctx.font = `900 ${em}px ${FONT}`;
      // keep the digits inside the box the layout reserved for them, whatever font the machine has
      const budget = m.text.length * DIGIT_WIDTH * em;
      const measured = ctx.measureText(m.text).width;
      if (measured > budget) ctx.scale(budget / measured, 1);
      ctx.fillText(m.text, 0, (DIGIT_HEIGHT / 2) * em);
      if (m.underline) {
        const w = budget * 0.9;
        ctx.fillRect(-w / 2, (DIGIT_HEIGHT / 2 + UNDERLINE_GAP) * em, w, UNDERLINE_THICKNESS * em);
      }
      ctx.restore();
    }
  }
  return canvas;
}
