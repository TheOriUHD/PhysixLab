/** A string key/value store (the subset of `Storage` the QoL stores use), so the logic is testable without a DOM. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `localStorage`, or a store that remembers nothing when the browser blocks storage (private windows …). */
export function browserStorage(): KeyValueStore {
  return {
    getItem(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* storage full or blocked: the feature degrades to "not remembered" */
      }
    },
  };
}

/** An in-memory store (tests, and the fallback when nothing else is available). */
export function memoryStorage(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

/** Parse JSON without throwing. */
export function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
