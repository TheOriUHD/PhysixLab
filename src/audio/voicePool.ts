/**
 * Voice limiting and priority, independent of WebAudio: a bounded set of sounding voices with a budget per category
 * and a total, where a louder newcomer steals the quietest voice and a quieter one is turned away.
 *
 * Priority is "how much would you miss it": the linear loudness after distance, scaled by how important the kind of
 * sound is. A voice that has been sounding for a while counts for a little less (`effective`), so a long ring does
 * not hold its place against a fresh hit of the same loudness. A newcomer must beat the victim by 15 % to steal, which
 * keeps two equally loud sounds from trading places every frame.
 */
export interface PoolVoice {
  category: string;
  /** Loudness-like importance, > 0. */
  priority: number;
  /** Start time, seconds (the audio clock). */
  start: number;
}

export interface PoolLimits {
  total: number;
  perCategory: Readonly<Record<string, number>>;
}

/** Fraction by which a newcomer must exceed the victim's effective priority to steal its place. */
export const STEAL_MARGIN = 1.15;
/** Time constant, seconds, over which an old voice becomes up to 45 % more stealable. */
const AGE_TAU = 1.5;

export type Admission<V> = { ok: true; steals: V[] } | { ok: false };

export class VoicePool<V extends PoolVoice> {
  readonly voices: V[] = [];

  constructor(public limits: PoolLimits) {}

  count(category?: string): number {
    if (category === undefined) return this.voices.length;
    let n = 0;
    for (const v of this.voices) if (v.category === category) n++;
    return n;
  }

  /** Priority discounted by age: the quantity compared when voices compete. */
  effective(v: PoolVoice, now: number): number {
    const age = Math.max(0, now - v.start);
    return v.priority * (0.55 + 0.45 * Math.exp(-age / AGE_TAU));
  }

  private weakest(now: number, pick: (v: V) => boolean, skip: readonly V[]): V | null {
    let best: V | null = null;
    let bestP = Infinity;
    for (const v of this.voices) {
      if (!pick(v) || skip.includes(v)) continue;
      const p = this.effective(v, now);
      if (p < bestP) {
        bestP = p;
        best = v;
      }
    }
    return best;
  }

  /**
   * May a voice of this category and priority start? `ok` with the voices to stop first (none when there is room),
   * or not ok when every place is held by something at least as important. Does not modify the pool.
   */
  admit(category: string, priority: number, now: number): Admission<V> {
    const steals: V[] = [];
    const catLimit = this.limits.perCategory[category] ?? this.limits.total;
    if (this.count(category) >= catLimit) {
      const victim = this.weakest(now, (v) => v.category === category, steals);
      if (!victim || priority <= this.effective(victim, now) * STEAL_MARGIN) return { ok: false };
      steals.push(victim);
    }
    if (this.voices.length - steals.length >= this.limits.total) {
      const victim = this.weakest(now, () => true, steals);
      if (!victim || priority <= this.effective(victim, now) * STEAL_MARGIN) return { ok: false };
      steals.push(victim);
    }
    return { ok: true, steals };
  }

  add(v: V): void {
    this.voices.push(v);
  }

  remove(v: V): boolean {
    const i = this.voices.indexOf(v);
    if (i < 0) return false;
    this.voices[i] = this.voices[this.voices.length - 1];
    this.voices.pop();
    return true;
  }
}

/**
 * The `n` largest of a stream of scored candidates, without allocating per candidate: a fixed-size insertion list.
 * Used each frame to pick the loudest rolling bodies and motors out of thousands. A candidate that is already
 * sounding gets `stickiness` × its score, so voices do not flip back and forth between near-equals.
 */
export class TopN<T> {
  readonly items: (T | null)[];
  readonly scores: number[];
  size = 0;

  constructor(readonly capacity: number) {
    this.items = new Array<T | null>(capacity).fill(null);
    this.scores = new Array<number>(capacity).fill(0);
  }

  clear(): void {
    this.size = 0;
    this.items.fill(null);
  }

  /** Offer a candidate; returns true when it made the list. */
  offer(item: T, score: number): boolean {
    if (!(score > 0)) return false;
    if (this.size === this.capacity && score <= this.scores[this.size - 1]) return false;
    let i = this.size < this.capacity ? this.size++ : this.capacity - 1;
    while (i > 0 && this.scores[i - 1] < score) {
      this.scores[i] = this.scores[i - 1];
      this.items[i] = this.items[i - 1];
      i--;
    }
    this.scores[i] = score;
    this.items[i] = item;
    return true;
  }
}
