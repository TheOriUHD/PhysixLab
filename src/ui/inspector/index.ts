/**
 * Inspector — properties of the current selection. Rebuilds its DOM when the kind of
 * selection changes and otherwise just refreshes field values (including live readouts from
 * the running simulation), so typing and scrubbing never lose focus.
 *
 * The per-entity-type panels live next to this file: `body.ts`, `soft.ts`, `joint.ts`; the shared
 * context (header, edit / undo-grouping helpers, updater lists) is in `shared.ts`.
 */
import type { App } from '../../app/app';
import type { Entity } from '../../model/types';
import { isBody, isGroup, isJoint, isLight, isPath, isSoft } from '../../model/types';
import { clear, h } from '../dom';
import { icon } from '../icons';
import { groupInspector, lightInspector, membershipRow, pathInspector } from './aux';
import { componentsSection } from './components';
import { section } from '../controls';
import { bodyInspector } from './body';
import { jointInspector } from './joint';
import { InspectorContext } from './shared';
import { softInspector } from './soft';

export class Inspector {
  readonly el: HTMLElement = h('div', { class: 'panel-body' });
  private ctx: InspectorContext;
  private builtFor = '';
  private lastLive = 0;

  constructor(private app: App) {
    const { store } = app;
    this.ctx = new InspectorContext(app);
    store.on('selection', () => this.render());
    store.on('change', (c) => {
      if (c.type === 'reset' || c.type === 'remove') this.render();
      else this.refresh();
    });
    app.sim.on('mode', () => this.render());
    app.on('frame', () => {
      const now = performance.now();
      if (now - this.lastLive > 90 && this.ctx.live.length) {
        this.lastLive = now;
        this.ctx.live.forEach((f) => f());
      }
    });
    app.on('jointEnd', () => this.refresh());
    app.on('pathPoint', () => this.refresh());
    this.render();
  }

  // ------------------------------------------------------------------------------------------

  private key(sel: Entity[]): string {
    const kinds = new Set(sel.map((e) => e.kind + (isJoint(e) ? e.type : '')));
    return `${sel.length > 1 ? 'multi' : (sel[0]?.id ?? 'none')}:${[...kinds].join(',')}:${this.app.sim.mode === 'edit' ? 'e' : 's'}`;
  }

  render(): void {
    const { ctx } = this;
    const sel = ctx.selection();
    this.builtFor = this.key(sel);
    ctx.reset();
    clear(this.el);
    if (!sel.length) {
      this.el.appendChild(this.empty());
      return;
    }
    if (sel.every(isBody)) this.el.append(...bodyInspector(ctx, sel), ...this.organise(sel), ...this.components(sel));
    else if (sel.every(isSoft)) this.el.append(...softInspector(ctx, sel), ...this.organise(sel));
    else if (sel.every(isLight)) this.el.append(...lightInspector(ctx, sel));
    else if (sel.length === 1 && isGroup(sel[0])) this.el.append(...groupInspector(ctx, sel[0]));
    else if (sel.length === 1 && isPath(sel[0])) this.el.append(...pathInspector(ctx, sel[0]));
    else if (sel.length === 1 && isJoint(sel[0]))
      this.el.append(...jointInspector(ctx, sel[0]), ...this.components(sel));
    else this.el.append(...this.summary(sel));
    this.refresh();
    ctx.live.forEach((f) => f());
  }

  refresh(): void {
    const sel = this.ctx.selection();
    if (this.key(sel) !== this.builtFor) {
      this.render();
      return;
    }
    this.ctx.updaters.forEach((u) => u());
  }

  private empty(): HTMLElement {
    const n = this.app.store.size;
    return h(
      'div',
      { class: 'empty-state' },
      icon('select', 'icon big'),
      h('h4', null, n ? 'Nothing selected' : 'An empty lab'),
      h(
        'p',
        null,
        n
          ? 'Click an object in the scene or the outliner to inspect and edit it. Drag on empty space to box-select.'
          : 'Add a shape from the library on the left (or press 1–8), then press Space to simulate.',
      ),
    );
  }

  /** The Components section — for a single body or joint (components are edited one owner at a time). */
  private components(sel: Entity[]): HTMLElement[] {
    const sec = sel.length === 1 ? componentsSection(this.ctx, sel[0].id) : null;
    return sec ? [sec] : [];
  }

  /** The "Group" row for bodies and soft bodies (the other kinds build it into their own panel). */
  private organise(sel: Entity[]): HTMLElement[] {
    const row = membershipRow(
      this.ctx,
      sel.map((e) => e.id),
    );
    return row ? [section('Organise', [row], { id: 'organise' })] : [];
  }

  /** Mixed selections (bodies + joints, several groups …): counts only, no shared properties. */
  private summary(sel: Entity[]): HTMLElement[] {
    const count = (f: (e: Entity) => boolean) => sel.filter(f).length;
    const parts = [
      [count((e) => isBody(e) || isSoft(e)), 'body', 'bodies'],
      [count(isJoint), 'joint', 'joints'],
      [count(isGroup), 'group', 'groups'],
      [count(isLight), 'light', 'lights'],
      [count(isPath), 'path', 'paths'],
    ] as const;
    const text = parts
      .filter(([n]) => n > 0)
      .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
      .join(', ');
    return [
      this.ctx.header(sel),
      h(
        'div',
        { class: 'empty-state' },
        h('h4', null, `${sel.length} objects selected`),
        h(
          'p',
          null,
          `${text}. Select objects of one kind to edit shared properties (bodies, soft bodies or lights), or a single group, path or joint to edit its settings.`,
        ),
      ),
    ];
  }
}
