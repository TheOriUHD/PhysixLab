/**
 * Ranking of palette items for a query: every whitespace-separated word of the query must match the item's label
 * (fuzzily: its letters in order) or — at a lower weight, and only as a whole piece of text — one of its keywords,
 * its group or its description. Scattered letters are good enough for a short label ("sg" → "Snap grid") but would
 * match almost any long sentence, so the secondary fields need the word itself. Items run recently get a small boost;
 * with an empty query the recent items come first and the rest keep their order.
 */
import { fuzzyMatch } from './fuzzy';

export interface Searchable {
  id: string;
  label: string;
  /** Extra words that can match ("undo" for "Revert"). */
  keywords: readonly string[];
  /** Section the item belongs to ("Edit", "Examples" …); also searchable. */
  group: string;
  detail?: string;
}

export interface Ranked<T> {
  item: T;
  score: number;
  /** Matched stretches of `item.label`, for highlighting. */
  ranges: [number, number][];
  /** The item is in the recent list (shown first when the query is empty). */
  recent: boolean;
}

/** A word that only matches a keyword counts for this fraction of what it would be worth in the label. */
const SECONDARY = 0.55;
/** What each letter of a whole-word match in a secondary field is worth (a label letter is worth ~11–12). */
const PER_LETTER = 11;
const WORD_START = 8;

const isAlnum = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);

/** Score of `word` occurring as is in `field` (null if it does not); a match at the start of a word scores more. */
function wholeWord(word: string, field: string): number | null {
  const at = field.toLowerCase().indexOf(word.toLowerCase());
  if (at < 0) return null;
  return word.length * PER_LETTER + (at === 0 || !isAlnum(field[at - 1]) ? WORD_START : 0);
}
const MAX_RESULTS = 80;

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const tail = out[out.length - 1];
    if (tail && r[0] <= tail[1]) tail[1] = Math.max(tail[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

export function rankItems<T extends Searchable>(
  items: readonly T[],
  query: string,
  recent: readonly string[],
): Ranked<T>[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const recentRank = new Map(recent.map((id, i) => [id, i]));

  if (!words.length) {
    const first: Ranked<T>[] = [];
    const rest: Ranked<T>[] = [];
    for (const item of items) {
      const r = recentRank.get(item.id);
      (r === undefined ? rest : first).push({ item, score: 0, ranges: [], recent: r !== undefined });
    }
    first.sort((a, b) => (recentRank.get(a.item.id) ?? 0) - (recentRank.get(b.item.id) ?? 0));
    return [...first, ...rest];
  }

  const out: (Ranked<T> & { order: number })[] = [];
  items.forEach((item, order) => {
    let score = 0;
    const ranges: [number, number][] = [];
    for (const word of words) {
      const inLabel = fuzzyMatch(word, item.label);
      let secondary: number | null = null;
      for (const field of [...item.keywords, item.group, item.detail ?? '']) {
        if (!field) continue;
        const m = wholeWord(word, field);
        if (m !== null && (secondary === null || m > secondary)) secondary = m;
      }
      const primary = inLabel ? inLabel.score : null;
      const viaKeyword = secondary === null ? null : secondary * SECONDARY;
      if (primary !== null && (viaKeyword === null || primary >= viaKeyword)) {
        score += primary;
        ranges.push(...inLabel!.ranges);
      } else if (viaKeyword !== null) {
        score += viaKeyword;
      } else {
        return; // this word matches nothing about the item
      }
    }
    const r = recentRank.get(item.id);
    if (r !== undefined) score += Math.max(0, 12 - 1.5 * r);
    out.push({ item, score, ranges: mergeRanges(ranges), recent: r !== undefined, order });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out
    .slice(0, MAX_RESULTS)
    .map(({ item, score, ranges, recent: wasRecent }) => ({ item, score, ranges, recent: wasRecent }));
}
