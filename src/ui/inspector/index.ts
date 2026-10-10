/**
 * Inspector — properties of the current selection. Rebuilds its DOM when the kind of
 * selection changes and otherwise just refreshes field values (including live readouts from
 * the running simulation), so typing and scrubbing never lose focus.
 *
 * What it shows is decided by the inspector-section registry (`src/app/registry/inspectorSections.ts`): every
 * registered section that applies to the selection builds its part. The built-in sections (`sections.ts`) wrap the
 * per-entity-type panels next to this file: `body.ts`, `soft.ts`, `joint.ts`, `aux.ts`; the shared context (header,
 * edit / undo-grouping helpers, updater lists) is in `shared.ts`.
 */
import type { App } from '../../app/app';
import { inspectorSectionRegistry, sectionsFor } from '../../app/registry/inspectorSections';
import type { Entity } from '../../model/types';
import { isJoint } from '../../model/types';
import { clear, h } from '../dom';
import { emptyState } from '../emptyState'; // -- UI-B: empty states --
import { InspectorContext } from './shared';
// -- UI-A: inspector upgrades (toolbar, filter, resets, label scrubbing) --
import { onUiModeChange } from '../uiMode';
import { enhanceInspector } from './upgrades/enhance';

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
    // A section registered (or removed) later shows up at once.
    inspectorSectionRegistry.onChange(() => this.render());
    // -- UI-A: Simple / Advanced mode rewords the labels --
    onUiModeChange(() => this.render());
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
    for (const section of sectionsFor(sel, this.app)) this.el.append(...section.build(ctx, sel));
    // -- UI-A: toolbar / filter / reset buttons / label scrubbing --
    enhanceInspector(this.app, ctx, this.el, sel);
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
    // -- UI-B: empty state with an illustration --
    return emptyState({
      art: n ? 'select' : 'scene',
      title: n ? 'Nothing selected' : 'An empty lab',
      hint: n
        ? 'Click an object in the scene or the outliner to inspect and edit it. Drag on empty space to box-select.'
        : 'Add a shape from the library on the left (or press 1–8), then press Space to simulate.',
    });
  }
}
