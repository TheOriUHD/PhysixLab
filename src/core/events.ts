/** Tiny typed event emitter. */
export class Emitter<Events extends Record<string, unknown>> {
  // Handlers for different event keys share one map, so the payload type is erased here; `on`/`emit`
  // re-impose the per-key payload type for every caller.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers = new Map<keyof Events, Set<(payload: any) => void>>();

  on<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) fn(payload);
  }
}
