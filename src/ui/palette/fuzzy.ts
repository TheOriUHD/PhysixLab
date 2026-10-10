/**
 * Fuzzy matching for the command palette: a query matches a text when its characters occur in the text in order
 * (a subsequence, case-insensitive). Among all the ways to place them, the best-scoring alignment wins, so
 * "sg" finds "**S**napping **g**rid" through its word starts rather than through the first "s" and the first "g".
 *
 * Score of an alignment, summed over the matched characters:
 *   +10 per character, +1 when the case also matches
 *   +8  when the character starts a word (after a space or punctuation, a lowercase→Uppercase step, or at 0)
 *   +6  when it directly follows the previously matched character (runs beat scattered letters)
 *   −1  per skipped character between two matches
 *   first match: −0.3 per leading character (at most −3), +5 when it is the very first character of the text
 * and a tiny preference for shorter texts. The best alignment is found with a dynamic programme in O(query × text);
 * `alignmentScore` is the same scoring written out for one alignment, which the unit tests use to check the
 * programme against brute force.
 */

export interface FuzzyMatch {
  score: number;
  /** Matched stretches of the text as half-open `[start, end)` index pairs, ascending, merged when adjacent. */
  ranges: [number, number][];
}

const MATCH = 10;
const CASE = 1;
const WORD_START = 8;
const CONSECUTIVE = 6;
const GAP = 1;
const LEADING = 0.3;
const LEADING_CAP = 3;
const PREFIX = 5;
const LENGTH = 0.02;

const isAlnum = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);
const isLower = (c: string): boolean => c !== c.toUpperCase();
const isUpper = (c: string): boolean => c !== c.toLowerCase();

function wordStarts(text: string): boolean[] {
  const out: boolean[] = [];
  for (let j = 0; j < text.length; j++) {
    const prev = j > 0 ? text[j - 1] : '';
    out.push(j === 0 || !isAlnum(prev) || (isLower(prev) && isUpper(text[j])));
  }
  return out;
}

/** What a character earns wherever it sits: the match itself, case agreement and word-start bonus. */
function baseScore(q: string, text: string, starts: boolean[], j: number): number {
  return MATCH + (text[j] === q ? CASE : 0) + (starts[j] ? WORD_START : 0);
}

/** What the first matched character earns for its position in the text. */
const leadScore = (j: number): number => -Math.min(LEADING_CAP, LEADING * j) + (j === 0 ? PREFIX : 0);

/** Bonus (or penalty) of a match that follows the previous match after `gap` skipped characters. */
const stepScore = (gap: number): number => (gap === 0 ? CONSECUTIVE : -GAP * gap);

/** Score of a specific alignment (`positions[i]` = index in `text` of query character i). For tests. */
export function alignmentScore(query: string, text: string, positions: readonly number[]): number {
  const starts = wordStarts(text);
  let total = 0;
  positions.forEach((j, i) => {
    total += baseScore(query[i], text, starts, j);
    total += i === 0 ? leadScore(j) : stepScore(j - positions[i - 1] - 1);
  });
  return total - text.length * LENGTH;
}

/** Best alignment of `query` in `text`, or null if it is not a subsequence. An empty query matches with score 0. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const n = query.length;
  const m = text.length;
  if (n === 0) return { score: 0, ranges: [] };
  if (n > m) return null;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Quick reject: is it a subsequence at all?
  let at = 0;
  for (let j = 0; j < m && at < n; j++) if (t[j] === q[at]) at++;
  if (at < n) return null;

  const starts = wordStarts(text);
  const NEG = -Infinity;
  // best[i][j]: best score of matching query[0..i] with query[i] at text[j]; from[i][j]: where query[i-1] sat.
  const best: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(m).fill(NEG);
    const back = new Int32Array(m).fill(-1);
    if (i === 0) {
      for (let j = 0; j < m; j++) if (t[j] === q[0]) row[j] = baseScore(query[0], text, starts, j) + leadScore(j);
    } else {
      const prev = best[i - 1];
      // The best earlier position after a gap: max over k ≤ j−2 of prev[k] − GAP·(j−k−1)
      // = (max of prev[k] + GAP·k) − GAP·(j−1), so the running maximum needs no decay.
      let h = NEG;
      let hk = -1;
      for (let j = 0; j < m; j++) {
        if (j >= 2 && prev[j - 2] !== NEG) {
          const c = prev[j - 2] + GAP * (j - 2);
          if (c > h) {
            h = c;
            hk = j - 2;
          }
        }
        if (t[j] !== q[i]) continue;
        let val = NEG;
        let k = -1;
        if (j >= 1 && prev[j - 1] !== NEG) {
          val = prev[j - 1] + CONSECUTIVE;
          k = j - 1;
        }
        if (hk >= 0 && h - GAP * (j - 1) > val) {
          val = h - GAP * (j - 1);
          k = hk;
        }
        if (k >= 0) {
          row[j] = val + baseScore(query[i], text, starts, j);
          back[j] = k;
        }
      }
    }
    best.push(row);
    from.push(back);
  }

  const last = best[n - 1];
  let endJ = -1;
  let bestScore = NEG;
  for (let j = 0; j < m; j++) {
    if (last[j] > bestScore) {
      bestScore = last[j];
      endJ = j;
    }
  }
  if (endJ < 0) return null;

  const positions = new Array<number>(n);
  for (let i = n - 1, j = endJ; i >= 0; i--) {
    positions[i] = j;
    j = from[i][j];
  }
  const ranges: [number, number][] = [];
  for (const p of positions) {
    const tail = ranges[ranges.length - 1];
    if (tail && tail[1] === p) tail[1] = p + 1;
    else ranges.push([p, p + 1]);
  }
  return { score: bestScore - m * LENGTH, ranges };
}
