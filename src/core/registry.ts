/**
 * A tiny typed registry: definitions keyed by `id`, listed in a stable order, with change events.
 *
 * Every extension point of the app that is not a closed union (commands, tools, panels, inspector sections,
 * menus, templates, prefabs, maps …) is one of these. Registering returns the function that unregisters again,
 * so a test, a hot-loaded package or a temporary UI can clean up after itself:
 *
 *   const off = registry.register({ id: 'x', … });
 *   off();                       // or registry.unregister('x')
 *
 * Duplicate ids throw (two packages must not silently shadow each other), malformed definitions throw a
 * descriptive error from the optional `validate` hook — these are programming errors, never user input.
 */

export interface RegistryOptions<T> {
  /** Name used in error messages: "command", "panel", "map" … */
  kind: string;
  /** Throw a descriptive Error when `def` is malformed. */
  validate?: (def: T) => void;
  /** Sort key for `list()`: ascending, ties keep registration order. Without it the list is in registration order. */
  order?: (def: T) => number;
}

export interface RegistryChange {
  type: 'register' | 'unregister';
  id: string;
}

/** Ids start with a lowercase letter; words are joined by `.`, `-` or `_` ("edit.undo", "view.snapGrid", "empty-arena"). */
export const REGISTRY_ID = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/;

export class Registry<T extends { id: string }> {
  readonly kind: string;
  private readonly opts: RegistryOptions<T>;
  private readonly defs = new Map<string, T>();
  private readonly seq = new Map<string, number>();
  private readonly listeners = new Set<(c: RegistryChange) => void>();
  private nextSeq = 0;
  private sorted: readonly T[] | null = null;
  private rev = 0;

  constructor(opts: RegistryOptions<T>) {
    this.opts = opts;
    this.kind = opts.kind;
  }

  /** Add a definition. Returns the function that removes it again (idempotent). */
  register(def: T): () => void {
    if (typeof def.id !== 'string' || !REGISTRY_ID.test(def.id))
      throw new Error(
        `Invalid ${this.kind} id "${String(def.id)}" (start with a lowercase letter; join words with "." "-" or "_", e.g. "edit.undo")`,
      );
    if (this.defs.has(def.id)) throw new Error(`The ${this.kind} "${def.id}" is already registered`);
    this.opts.validate?.(def);
    this.defs.set(def.id, def);
    this.seq.set(def.id, this.nextSeq++);
    this.changed({ type: 'register', id: def.id });
    return () => {
      // Only remove what this call registered (the id may have been unregistered and taken by someone else).
      if (this.defs.get(def.id) === def) this.unregister(def.id);
    };
  }

  /** Remove a definition; false when there was none. */
  unregister(id: string): boolean {
    if (!this.defs.delete(id)) return false;
    this.seq.delete(id);
    this.changed({ type: 'unregister', id });
    return true;
  }

  get(id: string): T | undefined {
    return this.defs.get(id);
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  get size(): number {
    return this.defs.size;
  }

  /** Increases with every change — a cheap cache key for anything derived from the list. */
  get revision(): number {
    return this.rev;
  }

  /** All definitions, in `order` (then registration) order. The array is cached; do not mutate it. */
  list(): readonly T[] {
    if (!this.sorted) {
      const all = [...this.defs.values()];
      const order = this.opts.order;
      if (order) {
        all.sort((a, b) => order(a) - order(b) || (this.seq.get(a.id) ?? 0) - (this.seq.get(b.id) ?? 0));
      }
      this.sorted = all;
    }
    return this.sorted;
  }

  /** Listen for registrations and removals. Returns the unsubscribe function. */
  onChange(fn: (c: RegistryChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(c: RegistryChange): void {
    this.sorted = null;
    this.rev++;
    for (const fn of [...this.listeners]) fn(c);
  }
}
