/**
 * Search and grouping of the shape palette — pure functions over the shape registry, so the Add tab and the tests
 * share them. A query is split into words and every word must match something of the shape: its name (best), its
 * id, its category, a keyword (`ShapeDef.keywords`, e.g. "dice" finds the d20, "wheel" the tyre and the gear), or
 * its one-line description. Short words match the start of a word; longer ones also match fuzzily, so "tors" and
 * "trs" both find the torus.
 */
import { SHAPE_CATEGORY_LABELS, type ShapeCategory, type ShapeDef } from '../model/shapeRegistry';
import { shapeKeywords } from '../model/shapes/keywords';
import { fuzzyMatch } from './palette/fuzzy';

export interface ShapeHit {
  def: ShapeDef;
  /** Position in the registry (the number key of the first nine). */
  index: number;
  score: number;
}

export const CATEGORY_ORDER: readonly ShapeCategory[] = ['basic', 'structural', 'mechanical', 'solids', 'special'];

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** How well one query word matches a shape; 0 = not at all. */
function scoreWord(q: string, def: ShapeDef): number {
  const label = def.label.toLowerCase();
  const id = def.id.toLowerCase();
  let best = 0;
  const bump = (v: number) => {
    if (v > best) best = v;
  };
  if (label === q || id === q) bump(100);
  if (label.startsWith(q) || id.startsWith(q)) bump(80);
  if (words(def.label).some((w) => w.startsWith(q)) || words(def.id).some((w) => w.startsWith(q))) bump(65);
  if (label.includes(q)) bump(50);
  const category = SHAPE_CATEGORY_LABELS[def.category].toLowerCase();
  if (category.startsWith(q)) bump(35);
  for (const k of shapeKeywords(def)) {
    const kw = k.toLowerCase();
    if (kw === q) bump(45);
    else if (kw.startsWith(q) || words(kw).some((w) => w.startsWith(q))) bump(38);
    else if (q.length >= 3 && kw.includes(q)) bump(28);
  }
  if (def.blurb && words(def.blurb).some((w) => w.startsWith(q))) bump(20);
  if (best === 0 && q.length >= 3) {
    const m = fuzzyMatch(q, def.label) ?? fuzzyMatch(q, def.id);
    if (m && m.score > 20) bump(Math.min(30, 10 + m.score / 4));
  }
  return best;
}

/** The shapes that match `query` (best first), or every shape in registry order for an empty query. */
export function searchShapes(defs: readonly ShapeDef[], query: string): ShapeHit[] {
  const terms = words(query);
  const all = defs.map((def, index): ShapeHit => ({ def, index, score: 0 }));
  if (!terms.length) return all;
  const hits: ShapeHit[] = [];
  for (const hit of all) {
    let total = 0;
    let ok = true;
    for (const t of terms) {
      const s = scoreWord(t, hit.def);
      if (s === 0) {
        ok = false;
        break;
      }
      total += s;
    }
    if (ok) hits.push({ ...hit, score: total });
  }
  return hits.sort((a, b) => b.score - a.score || a.index - b.index);
}

export interface ShapeGroup {
  category: ShapeCategory;
  label: string;
  hits: ShapeHit[];
}

/** Hits grouped by category, in the order of the palette; categories with nothing are left out. */
export function groupByCategory(hits: readonly ShapeHit[]): ShapeGroup[] {
  const order = [...CATEGORY_ORDER, ...new Set(hits.map((h) => h.def.category))].filter(
    (c, i, a) => a.indexOf(c) === i,
  );
  return order
    .map((category) => ({
      category,
      label: SHAPE_CATEGORY_LABELS[category],
      hits: hits.filter((h) => h.def.category === category),
    }))
    .filter((g) => g.hits.length > 0);
}
