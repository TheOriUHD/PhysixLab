/**
 * The inspector's "Components" section for one body or joint: the attached components as cards (enable switch,
 * reorder, remove, collapse, live readouts, one schema-generated editor per field) and the "Add component" menu with
 * search and categories. Everything is generated from the component registry — a new component type needs no code here.
 */
import {
  componentCategories,
  componentDef,
  componentsFor,
  defaultParams,
  makeComponent,
  ownerKind,
  type ComponentDef,
} from '../../model/componentRegistry';
import type { BodyEntity, ComponentSpec, ComponentValue, JointEntity } from '../../model/types';
import { isBody, isJoint } from '../../model/types';
import { fmt, row, rowStack, section } from '../controls';
import { h } from '../dom';
import { icon } from '../icons';
import { closeMenu } from '../menu';
import { buildFieldEditor } from './componentFields';
import type { InspectorContext } from './shared';

type Owner = BodyEntity | JointEntity;

/** The section for the entity `id`, or null when nothing can be attached to it (no registered component applies). */
export function componentsSection(ctx: InspectorContext, id: string): HTMLElement | null {
  const { app } = ctx;
  const { store } = app;
  const owner = (): Owner | undefined => {
    const e = store.get(id);
    return isBody(e) || isJoint(e) ? e : undefined;
  };
  const first = owner();
  if (!first) return null;
  const kind = ownerKind(first);
  if (!componentsFor(kind).length && !first.components.length) return null;

  const list = h('div', { class: 'comps' });
  const addBtn = h(
    'button',
    { class: 'btn comp-add', type: 'button', title: 'Attach a behaviour: forces, movers, sensors …' },
    icon('plus'),
    h('span', null, 'Add component'),
  );
  addBtn.addEventListener('click', () => openComponentMenu(addBtn, ctx, id));
  const sec = section('Components', [addBtn, list], { id: 'components', badge: String(first.components.length) });
  const badge = sec.querySelector('.badge')!;

  const collapsed = new Set<string>();
  let sig = '<unbuilt>';
  let cardUpdaters: (() => void)[] = [];
  let cardLive: (() => void)[] = [];

  const write = (next: ComponentSpec[], label: string) => store.update(id, { components: next }, label);
  const comps = (): ComponentSpec[] => owner()?.components ?? [];
  const patch = (cid: string, fn: (c: ComponentSpec) => ComponentSpec, label: string) =>
    write(
      comps().map((c) => (c.id === cid ? fn(c) : c)),
      label,
    );

  const card = (spec: ComponentSpec, index: number, total: number): HTMLElement => {
    const def = componentDef(spec.type);
    const label = def?.label ?? spec.type;
    const el = h('div', { class: 'comp', dataset: { id: spec.id, type: spec.type } });
    const caret = h('button', { class: 'comp-caret', type: 'button', title: 'Fold / unfold' }, icon('chevron'));
    const title = h('span', { class: 'comp-title', title: def?.blurb ?? '' }, label);
    const enable = h('input', { type: 'checkbox', class: 'switch-input' });
    const sw = h(
      'label',
      { class: 'switch comp-switch', title: 'Enable / disable this component' },
      enable,
      h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' })),
    );
    enable.addEventListener('change', () =>
      patch(spec.id, (c) => ({ ...c, enabled: enable.checked }), `${enable.checked ? 'Enable' : 'Disable'} ${label}`),
    );
    const mini = (ic: string, tip: string, fn: () => void, disabled = false) => {
      const b = h('button', { class: 'icon-btn small', type: 'button', title: tip, disabled }, icon(ic));
      b.addEventListener('click', fn);
      return b;
    };
    const move = (by: number) => {
      const list2 = [...comps()];
      const i = list2.findIndex((c) => c.id === spec.id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= list2.length) return;
      [list2[i], list2[j]] = [list2[j], list2[i]];
      write(list2, `Reorder ${label}`);
    };
    const head = h(
      'div',
      { class: 'comp-head' },
      caret,
      def ? icon(def.icon) : icon('info'),
      title,
      sw,
      mini('chevronUp', 'Run earlier', () => move(-1), index === 0),
      mini('chevronDown', 'Run later', () => move(1), index === total - 1),
      mini('trash', `Remove ${label}`, () =>
        write(
          comps().filter((c) => c.id !== spec.id),
          `Remove ${label}`,
        ),
      ),
    );
    const body = h('div', { class: 'comp-body' });
    el.append(head, body);
    const toggleFold = () => {
      if (collapsed.has(spec.id)) collapsed.delete(spec.id);
      else collapsed.add(spec.id);
      el.classList.toggle('folded', collapsed.has(spec.id));
    };
    caret.addEventListener('click', toggleFold);
    title.addEventListener('click', toggleFold);
    el.classList.toggle('folded', collapsed.has(spec.id));

    const ups: (() => void)[] = [];
    const lives: (() => void)[] = [];
    const current = (): ComponentSpec => comps().find((c) => c.id === spec.id) ?? spec;

    if (!def) {
      body.append(
        h(
          'p',
          { class: 'comp-warn' },
          `This build has no component “${spec.type}”. It is kept in the scene but does nothing.`,
        ),
      );
    } else {
      const warn = h('div', { class: 'comp-warn' }, icon('info'), h('span'));
      body.append(warn);
      ups.push(() => {
        const o = owner();
        const msg = o ? def.check?.(o, current().params) : null;
        warn.style.display = msg ? '' : 'none';
        warn.lastElementChild!.textContent = msg ?? '';
      });
      for (const f of def.fields) {
        const grouped = ctx.grouped(`Edit ${label} ${f.label.toLowerCase()}`);
        const editor = buildFieldEditor(f, {
          app,
          onChange: (v: ComponentValue) =>
            patch(
              spec.id,
              (c) => ({ ...c, params: { ...c.params, [f.key]: v } }),
              `Edit ${label} ${f.label.toLowerCase()}`,
            ),
          ...grouped,
        });
        // wide controls get the full width under their label, like the vectors of the body inspector
        const r = (f.kind === 'vec3' || f.kind === 'curve' ? rowStack : row)(f.label, editor.el, f.hint);
        r.classList.add('comp-row');
        body.append(r);
        ups.push(() => {
          const c = current();
          editor.set(c.params[f.key] ?? defaultParams(def)[f.key]);
          if (f.showIf) r.style.display = f.showIf(c.params) ? '' : 'none';
        });
      }
      if (def.state?.length) {
        const state = h('div', { class: 'comp-state' });
        body.append(state);
        lives.push(() => {
          const values = app.sim.active ? app.sim.client.stateOf(spec.id) : null;
          state.replaceChildren(
            ...def.state!.map((s, i) =>
              h(
                'span',
                { class: 'comp-gauge' },
                h('span', { class: 'comp-gauge-label' }, s.label),
                h(
                  'b',
                  null,
                  values && i < values.length ? `${fmt(values[i], s.digits ?? 2)}${s.unit ? ` ${s.unit}` : ''}` : '—',
                ),
              ),
            ),
          );
        });
      }
    }
    ups.push(() => {
      const c = current();
      enable.checked = c.enabled;
      el.classList.toggle('disabled', !c.enabled);
    });
    cardUpdaters.push(...ups);
    cardLive.push(...lives);
    return el;
  };

  const rebuild = () => {
    const all = comps();
    const next = all.map((c) => `${c.id}:${c.type}`).join('|');
    if (next !== sig) {
      sig = next;
      cardUpdaters = [];
      cardLive = [];
      list.replaceChildren(
        ...(all.length
          ? all.map((c, i) => card(c, i, all.length))
          : [
              h(
                'p',
                { class: 'comp-empty' },
                'No components yet. Components give a body behaviour — a steady push, a moving platform, a sensor.',
              ),
            ]),
      );
    }
    badge.textContent = String(all.length);
    for (const u of cardUpdaters) u();
    for (const u of cardLive) u();
  };
  ctx.updaters.push(rebuild);
  ctx.live.push(() => cardLive.forEach((u) => u()));
  return sec;
}

// ---- the Add component menu ---------------------------------------------------------------------

/** A searchable, categorised popup of the component types that apply to the entity. */
export function openComponentMenu(anchor: HTMLElement, ctx: InspectorContext, id: string): void {
  const { store } = ctx.app;
  const e = store.get(id);
  if (!(isBody(e) || isJoint(e))) return;
  const kind = ownerKind(e);
  closeMenu();
  const search = h('input', {
    class: 'comp-search',
    type: 'text',
    placeholder: 'Search components…',
    spellcheck: false,
    'aria-label': 'Search components',
  });
  const results = h('div', { class: 'comp-results', role: 'listbox' });
  const menu = h(
    'div',
    { class: 'menu comp-menu' },
    h('div', { class: 'comp-search-wrap' }, icon('search'), search),
    results,
  );
  document.body.appendChild(menu);

  const owned = () => {
    const cur = store.get(id);
    return isBody(cur) || isJoint(cur) ? cur.components : [];
  };
  let active = 0;
  let visible: { def: ComponentDef; button: HTMLButtonElement; disabled: boolean }[] = [];

  const close = () => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    menu.remove();
  };
  const pick = (def: ComponentDef) => {
    store.update(id, { components: [...owned(), makeComponent(def.type)] }, `Add ${def.label}`);
    close();
  };
  const highlight = () => {
    visible.forEach((v, i) => v.button.classList.toggle('active', i === active));
    visible[active]?.button.scrollIntoView({ block: 'nearest' });
  };
  const render = () => {
    const q = search.value.trim().toLowerCase();
    results.replaceChildren();
    visible = [];
    for (const cat of componentCategories(kind)) {
      const defs = componentsFor(kind).filter(
        (d) => d.category === cat && (!q || `${d.label} ${d.blurb} ${d.category} ${d.type}`.toLowerCase().includes(q)),
      );
      if (!defs.length) continue;
      results.append(h('div', { class: 'menu-label' }, cat));
      for (const def of defs) {
        const have = !!def.unique && owned().some((c) => c.type === def.type);
        const b = h(
          'button',
          { class: 'menu-item comp-item', type: 'button', disabled: have, role: 'option', dataset: { type: def.type } },
          icon(def.icon),
          h(
            'span',
            { class: 'grow' },
            h('span', { class: 'comp-item-name' }, def.label),
            h('span', { class: 'comp-item-blurb' }, have ? 'Already added' : def.blurb),
          ),
        );
        b.addEventListener('click', () => pick(def));
        results.append(b);
        visible.push({ def, button: b, disabled: have });
      }
    }
    if (!visible.length)
      results.append(
        h(
          'p',
          { class: 'comp-empty' },
          q ? `Nothing matches “${search.value.trim()}”.` : 'No components apply to this object.',
        ),
      );
    active = Math.max(
      0,
      visible.findIndex((v) => !v.disabled),
    );
    highlight();
  };
  const onDown = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node)) close();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      close();
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      ev.stopPropagation();
      if (!visible.length) return;
      const dir = ev.key === 'ArrowDown' ? 1 : -1;
      for (let n = 1; n <= visible.length; n++) {
        const i = (active + dir * n + visible.length * n) % visible.length;
        if (!visible[i].disabled) {
          active = i;
          break;
        }
      }
      highlight();
    } else if (ev.key === 'Enter') {
      const v = visible[active];
      if (v && !v.disabled) {
        ev.preventDefault();
        ev.stopPropagation();
        pick(v.def);
      }
    }
  };
  search.addEventListener('input', render);
  search.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' && ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Enter')
      ev.stopPropagation();
  });
  render();

  const a = anchor.getBoundingClientRect();
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(a.left, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(a.bottom + 4, window.innerHeight - r.height - 8))}px`;
  // Registered synchronously: the pointerdown that opened the menu is already over, and a key pressed right away
  // (a busy page may handle input before a zero-delay timer) must not be missed.
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  search.focus();
}
