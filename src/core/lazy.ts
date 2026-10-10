/**
 * DT-42: load heavy, rarely used code on demand.
 *
 *   const exporters = lazy(() => import('./exporters'));      // a separate chunk, fetched on first use
 *   registerCommand({ id: 'file.exportGlb', run: async (app) => (await exporters()).exportGlb(app) });
 *
 * The loader runs once and every caller shares the same promise. A failed load (offline, deploy in between) is
 * not cached, so the next call tries again. `lazy.reset()`-style tricks are unnecessary; tests can pass their own loader.
 */
export function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = load().catch((e: unknown) => {
        pending = null;
        throw e;
      });
    }
    return pending;
  };
}
