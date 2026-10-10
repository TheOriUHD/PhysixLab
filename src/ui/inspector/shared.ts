/**
 * State and helpers shared by the per-entity-type inspector builders (body / soft / joint).
 *
 * A builder receives the context, creates its DOM and registers two kinds of callbacks on it:
 * `updaters` refresh field values from the document (run on every change, so typing and scrubbing
 * never lose focus), `live` refreshes readouts from the running simulation (~11 Hz).
 */
import type { App } from '../../app/app';
import type { Entity } from '../../model/types';
import { isJoint } from '../../model/types';
import { h } from '../dom';
import { icon } from '../icons';

export type Updater = () => void;

export class InspectorContext {
  updaters: Updater[] = [];
  live: Updater[] = [];

  constructor(readonly app: App) {}

  /** Forget the callbacks of the previous build. */
  reset(): void {
    this.updaters = [];
    this.live = [];
  }

  selection(): Entity[] {
    return this.app.store.selection.map((id) => this.app.store.get(id)).filter((e): e is Entity => !!e);
  }

  /** Name field + lock / hide / duplicate / delete buttons at the top of every inspector. */
  header(sel: Entity[]): HTMLElement {
    const { store, editor } = this.app;
    const first = sel[0];
    const nameInput = h('input', {
      class: 'plain',
      type: 'text',
      'aria-label': 'Name', // -- UI-B --
      title: 'Name of the selected object',
      value: sel.length > 1 ? `${sel.length} objects` : first.name,
      spellcheck: false,
      disabled: sel.length > 1,
    });
    nameInput.style.fontWeight = '600';
    nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') nameInput.blur();
    });
    nameInput.addEventListener('change', () =>
      store.update(first.id, { name: nameInput.value.trim() || first.name }, 'Rename'),
    );
    this.updaters.push(() => {
      const e = this.selection()[0];
      if (e && sel.length === 1 && document.activeElement !== nameInput) nameInput.value = e.name;
    });
    const ids = sel.map((e) => e.id);
    const act = (ic: string, title: string, fn: () => void) => {
      const b = h('button', { class: 'icon-btn', type: 'button', title }, icon(ic));
      b.addEventListener('click', fn);
      return b;
    };
    // everything but joints can be locked (bodies, soft bodies, groups, lights, paths)
    const bodies = sel.filter((e) => !isJoint(e));
    const lock = act(
      bodies.length && bodies.every((b) => b.locked) ? 'lock' : 'unlock',
      'Lock (L): locked bodies cannot be moved in the editor',
      () => editor.toggleFlag(ids, 'locked'),
    );
    lock.style.display = bodies.length ? '' : 'none';
    const hide = act(sel.every((e) => e.hidden) ? 'eyeOff' : 'eye', 'Hide (H)', () => editor.toggleFlag(ids, 'hidden'));
    this.updaters.push(() => {
      lock.replaceChildren(
        icon(
          bodies.length && sel.map((e) => store.get(e.id)).every((e) => !!e && !isJoint(e) && e.locked)
            ? 'lock'
            : 'unlock',
        ),
      );
      hide.replaceChildren(icon(sel.map((e) => store.get(e.id)).every((e) => e?.hidden) ? 'eyeOff' : 'eye'));
    });
    return h(
      'div',
      {
        style: {
          display: 'flex',
          gap: '4px',
          padding: '10px 12px',
          alignItems: 'center',
          borderBottom: '1px solid var(--border)',
        },
      },
      nameInput,
      lock,
      hide,
      act('copy', 'Duplicate (Ctrl+D)', () => editor.duplicateSelection()),
      act('trash', 'Delete (Del)', () => editor.deleteSelection()),
    );
  }

  /** Apply a patch to every selected entity of type T inside one undo step. */
  edit<T extends Entity>(ids: string[], label: string, fn: (e: T) => Partial<T>): void {
    const { store } = this.app;
    const patches: [string, Partial<Entity>][] = [];
    for (const id of ids) {
      const e = store.get(id) as T | undefined;
      // The assertion is needed: `Partial<T>` for a generic `T` is not assignable to `Partial<Entity>`.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      if (e) patches.push([id, fn(e) as Partial<Entity>]);
    }
    store.updateMany(patches, label);
  }

  /** onStart / onEnd callbacks that make a whole scrub or drag one undo step. */
  grouped(label: string): { onStart: () => void; onEnd: () => void } {
    return { onStart: () => this.app.store.begin(label), onEnd: () => this.app.store.end() };
  }
}
