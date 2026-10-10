/**
 * UI-A: the inspector upgrades that work on the finished inspector DOM, applied by `Inspector.render()` after the
 * sections are built:
 *  - a toolbar under the header: filter box, collapse / expand all, SI / imperial switch, and (for bodies) copy / paste
 *    of properties and property presets;
 *  - scrub-dragging on the row label of every single-number row;
 *  - a reset-to-default button on the body rows listed in `resets.ts`;
 *  - the property filter itself (rows and sections that do not match are hidden, matching sections open).
 * Everything here is driven by what the built-in builders already put in the DOM, so a section registered by another
 * package gets the filter, the label scrubbing and the unit switch for free.
 */
import type { App } from '../../../app/app';
import type { BodyEntity, Entity } from '../../../model/types';
import { isBody } from '../../../model/types';
import { scrubHandles, segmented } from '../../controls';
import { h } from '../../dom';
import { icon } from '../../icons';
import type { InspectorContext } from '../shared';
import { followUnits, rowBase } from './fieldUnits';
import { presetStore, unitPrefs } from './prefsStore';
import type { GroupId, Snapshot } from './props';
import { ALL_GROUPS, PROP_GROUPS, captureProps, groupsOf, snapshotPatch } from './props';
import { BODY_RESETS } from './resets';

/** The filter text survives selection changes (the inspector is rebuilt on each one). */
const filter = { q: '' };
/** Property groups ticked in the paste / preset panel. */
const ticked = new Set<GroupId>(ALL_GROUPS);
/** The last "Copy": properties of one body, kept in memory for pasting onto others. */
const wired = new WeakSet<HTMLElement>();
const paints = new WeakMap<HTMLElement, () => void>();
let clipboard: { name: string; snapshot: Snapshot } | null = null;

export function enhanceInspector(app: App, ctx: InspectorContext, root: HTMLElement, sel: Entity[]): void {
  if (!sel.length) return;
  const header = root.firstElementChild;
  const toolbar = buildToolbar(app, ctx, root, sel);
  if (header) header.after(toolbar);
  else root.prepend(toolbar);
  linkScrubLabels(root);
  const bodies = sel.every(isBody) ? sel.map((e) => e.id) : [];
  if (bodies.length) installResets(app, ctx, root, bodies);
  applyFilter(root, filter.q);
}

// ---- filter ------------------------------------------------------------------------------------------------------

export function applyFilter(root: HTMLElement, query: string): void {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  root.classList.toggle('ui-a-filtering', tokens.length > 0);
  for (const sec of root.querySelectorAll(':scope > .section')) {
    const rows = [...sec.querySelectorAll('.row')];
    if (!tokens.length) {
      sec.classList.remove('ui-a-hide');
      for (const r of rows) r.classList.remove('ui-a-hide');
      continue;
    }
    const title = (sec.querySelector(':scope > .section-head')?.textContent ?? '').toLowerCase();
    const titleHit = tokens.every((t) => title.includes(t));
    let any = false;
    for (const r of rows) {
      const tip = r.querySelector('.row-label')?.getAttribute('title') ?? '';
      const text = `${r.textContent ?? ''} ${tip}`.toLowerCase();
      const hit = titleHit || tokens.every((t) => text.includes(t));
      r.classList.toggle('ui-a-hide', !hit);
      any ||= hit;
    }
    const body = rows.length ? '' : (sec.textContent ?? '').toLowerCase();
    sec.classList.toggle('ui-a-hide', !(titleHit || any || (!rows.length && tokens.every((t) => body.includes(t)))));
  }
}

// ---- scrub on labels ---------------------------------------------------------------------------------------------

function linkScrubLabels(root: HTMLElement): void {
  for (const row of root.querySelectorAll('.row')) {
    const fields = row.querySelectorAll('.num-field');
    if (fields.length !== 1) continue;
    const handle = scrubHandles.get(fields[0] as HTMLElement);
    const label = row.querySelector('.row-label');
    if (!handle || !(label instanceof HTMLElement)) continue;
    label.classList.add('ui-a-scrub');
    label.title = `${label.title ? `${label.title}\n` : ''}Drag to scrub the value (Shift = fine, Ctrl = coarse)`;
    label.addEventListener('pointerdown', (e) => {
      // the reset button inside the label is a button, not a drag handle
      if (e.target instanceof Element && e.target.closest('.ui-a-reset')) return;
      handle(e, label);
    });
  }
}

// ---- reset to default --------------------------------------------------------------------------------------------

function installResets(app: App, ctx: InspectorContext, root: HTMLElement, ids: string[]): void {
  const cur = () => ids.map((id) => app.store.body(id)).filter((b): b is BodyEntity => !!b);
  const byLabel = new Map(BODY_RESETS.map((r) => [r.label, r]));
  const sync: (() => void)[] = [];
  for (const label of root.querySelectorAll('.row-label')) {
    const def = byLabel.get(rowBase(label));
    if (!def) continue;
    const btn = h(
      'button',
      { class: 'ui-a-reset', type: 'button', 'aria-label': `Reset ${def.label} to default` },
      icon('reset'),
    );
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctx.edit<BodyEntity>(ids, `Reset ${def.label}`, (b) => def.patch(b));
    });
    label.classList.add('has-reset');
    label.append(btn);
    sync.push(() => {
      const bodies = cur();
      const modified = bodies.some((b) => !def.isDefault(b));
      btn.style.display = modified ? '' : 'none';
      if (modified)
        btn.title = `Reset to default (${def.describe(bodies.find((b) => !def.isDefault(b)) ?? bodies[0])})`;
    });
  }
  ctx.updaters.push(() => sync.forEach((f) => f()));
  sync.forEach((f) => f());
}

// ---- toolbar -----------------------------------------------------------------------------------------------------

function buildToolbar(app: App, ctx: InspectorContext, root: HTMLElement, sel: Entity[]): HTMLElement {
  const search = h('input', {
    class: 'ui-a-search',
    type: 'text',
    placeholder: 'Filter properties…',
    spellcheck: false,
    value: filter.q,
    'aria-label': 'Filter properties',
  });
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      search.value = '';
      search.dispatchEvent(new Event('input'));
      search.blur();
    }
  });
  search.addEventListener('input', () => {
    filter.q = search.value;
    applyFilter(root, filter.q);
  });
  const clearBtn = h('button', { class: 'icon-btn ui-a-clear', type: 'button', title: 'Clear filter' }, icon('close'));
  clearBtn.addEventListener('click', () => {
    search.value = '';
    search.dispatchEvent(new Event('input'));
  });
  const searchWrap = h('div', { class: 'ui-a-search-wrap' }, icon('search', 'icon ui-a-search-icon'), search, clearBtn);

  const collapse = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Collapse or expand all sections (remembered)',
  });
  const heads = () => [...root.querySelectorAll(':scope > .section > .section-head')] as HTMLElement[];
  const paintCollapse = () => {
    const anyOpen = heads().some((x) => x.parentElement?.classList.contains('open'));
    collapse.replaceChildren(icon(anyOpen ? 'chevronUp' : 'chevronDown'));
    collapse.dataset.state = anyOpen ? 'open' : 'closed';
  };
  collapse.addEventListener('click', () => {
    const open = collapse.dataset.state === 'open';
    for (const x of heads()) if (x.parentElement?.classList.contains('open') === open) x.click();
    paintCollapse();
  });
  queueMicrotask(paintCollapse);
  // one listener per inspector root, repainting the button of the toolbar that is current
  paints.set(root, paintCollapse);
  if (!wired.has(root)) {
    wired.add(root);
    root.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.section-head')) paints.get(root)?.();
    });
  }

  const units = segmented<'si' | 'imperial'>({
    compact: true,
    options: [
      { value: 'si', label: 'SI', title: 'Show lengths, masses, forces … in SI units' },
      {
        value: 'imperial',
        label: 'Imp.',
        title: 'Show them in imperial units (ft, lb, lbf …). Click a unit label to switch a single field.',
      },
    ],
    value: unitPrefs.system,
    onChange: (v) => unitPrefs.setSystem(v),
  });
  followUnits(units.el, () => units.set(unitPrefs.system));

  const bar = h('div', { class: 'ui-a-tools' }, h('div', { class: 'ui-a-tools-row' }, searchWrap, collapse, units.el));

  if (sel.every(isBody)) {
    const ids = sel.map((e) => e.id);
    bar.append(propsRow(app, ctx, ids));
  }
  return bar;
}

// ---- copy / paste / presets --------------------------------------------------------------------------------------

function propsRow(app: App, ctx: InspectorContext, ids: string[]): HTMLElement {
  type Mode = 'paste' | 'presets' | null;
  let mode: Mode = null;
  const panel = h('div', { class: 'ui-a-props', hidden: true });
  const mkBtn = (label: string, ic: string, title: string, fn: () => void) => {
    const b = h('button', { class: 'btn small', type: 'button', title }, icon(ic), h('span', null, label));
    b.addEventListener('click', fn);
    return b;
  };
  const first = () => app.store.body(ids[0]);
  const apply = (snapshot: Snapshot, what: string) => {
    const groups = ALL_GROUPS.filter((g) => ticked.has(g) && snapshot[g]);
    if (!groups.length) {
      app.toast('Tick at least one section to apply', 'warn');
      return;
    }
    ctx.edit<BodyEntity>(ids, what, (b) => snapshotPatch(snapshot, b, groups));
    app.toast(
      `Applied ${groups.length} section${groups.length === 1 ? '' : 's'} to ${ids.length} object${ids.length === 1 ? '' : 's'}`,
      'success',
    );
  };

  const checks = (available: readonly GroupId[]): HTMLElement =>
    h(
      'div',
      { class: 'ui-a-groups' },
      PROP_GROUPS.filter((g) => available.includes(g.id)).map((g) => {
        const box = h('input', { type: 'checkbox' });
        box.checked = ticked.has(g.id);
        box.addEventListener('change', () => (box.checked ? ticked.add(g.id) : ticked.delete(g.id)));
        return h('label', { class: 'ui-a-group', title: g.hint }, box, h('span', null, g.label));
      }),
    );

  const render = () => {
    panel.hidden = mode === null;
    panel.replaceChildren();
    if (mode === 'paste') {
      if (!clipboard) {
        panel.append(
          h(
            'p',
            { class: 'hint-text' },
            'Nothing copied yet. Select a body and press Copy, then select the target objects and paste.',
          ),
        );
        return;
      }
      const snap = clipboard.snapshot;
      panel.append(
        h(
          'p',
          { class: 'hint-text' },
          `Copied from “${clipboard.name}”. Choose the sections to paste onto ${ids.length === 1 ? 'this object' : `these ${ids.length} objects`}.`,
        ),
        checks(groupsOf(snap)),
        mkBtn('Paste', 'copy', 'Apply the ticked sections (one undo step)', () => apply(snap, 'Paste properties')),
      );
    } else if (mode === 'presets') {
      const name = h('input', {
        class: 'ui-a-preset-name',
        type: 'text',
        placeholder: 'Preset name',
        maxLength: 48,
        spellcheck: false,
      });
      name.addEventListener('keydown', (e) => e.stopPropagation());
      const save = mkBtn('Save', 'save', 'Save the ticked sections of the first selected object as a preset', () => {
        const b = first();
        const groups = ALL_GROUPS.filter((g) => ticked.has(g));
        if (!b || !groups.length) {
          app.toast('Tick at least one section to save', 'warn');
          return;
        }
        if (presetStore.save(name.value, captureProps(b, groups))) {
          app.toast(`Preset “${name.value.trim()}” saved`, 'success');
          name.value = '';
        } else app.toast('Give the preset a name', 'warn');
      });
      const list = h('div', { class: 'ui-a-preset-list' });
      const items = presetStore.list();
      if (!items.length)
        list.append(
          h('p', { class: 'hint-text' }, 'No presets yet: tick the sections to keep, name them and press Save.'),
        );
      for (const p of items) {
        const apl = h(
          'button',
          { class: 'ui-a-preset', type: 'button', title: `Apply “${p.name}” to the selection` },
          h('b', null, p.name),
          h(
            'small',
            null,
            groupsOf(p.snapshot)
              .map((g) => PROP_GROUPS.find((x) => x.id === g)?.label ?? g)
              .join(' · '),
          ),
        );
        apl.addEventListener('click', () => apply(p.snapshot, `Preset: ${p.name}`));
        const del = h(
          'button',
          { class: 'icon-btn', type: 'button', title: `Delete preset “${p.name}”` },
          icon('trash'),
        );
        del.addEventListener('click', () => presetStore.remove(p.id));
        list.append(h('div', { class: 'ui-a-preset-row' }, apl, del));
      }
      panel.append(checks(ALL_GROUPS), h('div', { class: 'ui-a-save' }, name, save), list);
    }
  };
  const off = presetStore.onChange(() => {
    if (!panel.isConnected) off();
    else if (mode === 'presets') render();
  });

  const toggle = (m: Exclude<Mode, null>) => {
    mode = mode === m ? null : m;
    render();
  };
  const copy = mkBtn(
    'Copy',
    'copy',
    'Copy the properties of the first selected body (material, damping, locks, motion …)',
    () => {
      const b = first();
      if (!b) return;
      clipboard = { name: b.name, snapshot: captureProps(b) };
      app.toast(`Copied properties of “${b.name}”`, 'success');
      if (mode === 'paste') render();
    },
  );
  const paste = mkBtn('Paste…', 'layers', 'Paste copied properties onto the selection (all or selected sections)', () =>
    toggle('paste'),
  );
  const presets = mkBtn('Presets…', 'save', 'Save and apply property presets', () => toggle('presets'));
  copy.dataset.act = 'copy';
  paste.dataset.act = 'paste';
  presets.dataset.act = 'presets';
  return h('div', { class: 'ui-a-props-wrap' }, h('div', { class: 'ui-a-tools-row' }, copy, paste, presets), panel);
}
