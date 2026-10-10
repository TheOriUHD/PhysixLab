/**
 * A keyed set of sustained voices that follows a changing list of sources: each frame the director says which keys are
 * sounding (`touch`), and `finish` fades out the ones it did not mention. A voice the engine stole in the meantime is
 * forgotten and, if its source is still loud enough, opened again.
 */
/** What a set needs of a voice handle (the engine's `LoopHandle` has it; tests pass a fake). */
export interface HandleLike {
  dead: boolean;
  priority: number;
  kill(fade: number): void;
}

export class LoopSet<H extends HandleLike> {
  readonly handles = new Map<string, H>();
  private readonly seen = new Set<string>();

  constructor(private readonly open: (priority: number) => H | null = () => null) {}

  get size(): number {
    return this.handles.size;
  }

  /** Start a pass: nothing has been mentioned yet. */
  begin(): void {
    this.seen.clear();
  }

  /** The voice of `key` (opened if need be), kept alive for this pass; null when the engine would not admit it. */
  touch(key: string, priority: number, open: (priority: number) => H | null = this.open): H | null {
    let h = this.handles.get(key);
    if (h?.dead) {
      this.handles.delete(key);
      h = undefined;
    }
    if (!h) {
      const opened = open(priority);
      if (!opened) return null;
      h = opened;
      this.handles.set(key, h);
    }
    h.priority = priority;
    this.seen.add(key);
    return h;
  }

  /** End the pass: fade out every voice that was not touched. */
  finish(fade: number): void {
    for (const [key, h] of this.handles) {
      if (this.seen.has(key) && !h.dead) continue;
      h.kill(fade);
      this.handles.delete(key);
    }
  }

  closeAll(fade: number): void {
    for (const h of this.handles.values()) h.kill(fade);
    this.handles.clear();
    this.seen.clear();
  }
}
