/**
 * UI-A (UI-20/21): the outliner panel — hierarchy tree with drag & drop, multi-select, inline rename, visibility /
 * lock / solo toggles, colour tags and tag chips, real shape thumbnails, search with filters, sort modes, context
 * menu, selection sets. The row list is virtualised (fixed row height), the pure logic lives in `treeModel.ts`.
 */
import type { App } from '../../app/app';
import { shapeDef } from '../../model/shapeRegistry';
import { JOINT_TYPE_LABELS, LIGHT_LABELS, SOFT_LABELS } from '../../model/factory';
import { PathCurve } from '../../model/path';
import { TAG_COLORS, TAG_COLOR_KEYS } from '../../model/outlinerMeta';
import type { Entity } from '../../model/types';
import { isBody, isGroup, isJoint, isLight, isPath, isPosed, isSoft } from '../../model/types';
import { clear, h } from '../dom';
import { emptyState } from '../emptyState'; // -- UI-B: empty states --
import { icon } from '../icons';
import { openMenu, type MenuItem } from '../menu';
import { promptText } from '../modal';
import {
  SORT_LABELS,
  buildRows,
  emptyFilter,
  filterActive,
  idsWithTag,
  matches,
  parseQuery,
  planDrop,
  rangeIds,
  dropZone,
  soloPatches,
  tagCounts,
  tagsOf,
  typeKeys,
  uniqueSetName,
  withTag,
  componentsOf,
  materialOf,
  type DropZone,
  type EntityRow,
  type Filter,
  type Row,
  type SortMode,
} from './treeModel';
import { ThumbnailCache } from './thumbnails';
import { VirtualList } from './virtualList';

export const ROW_HEIGHT = 28;
const MIME = 'text/x-physixlab-entities';

const JOINT_ICON = {
  fixed: 'weld',
  hinge: 'hinge',
  slider: 'slider',
  ball: 'ball',
  spring: 'spring',
  rope: 'rope',
  // -- JT-A --
  conetwist: 'conetwist',
  sixdof: 'sixdof',
  pulley: 'pulley',
  rack: 'rack',
  gear: 'gear',
  belt: 'belt',
  universal: 'universal',
  screw: 'screw',
  winch: 'winch',
  softweld: 'softweld',
} as const;
const LIGHT_ICON = { point: 'light', spot: 'lightSpot', directional: 'lightSun', area: 'lightArea' } as const;

/** Icon key of any entity. */
function iconOf(e: Entity): string {
  if (isBody(e)) return shapeDef(e.shape.type).icon;
  if (isSoft(e)) return e.type;
  if (isGroup(e)) return 'group';
  if (isLight(e)) return LIGHT_ICON[e.lightType];
  if (isPath(e)) return 'path';
  return JOINT_ICON[e.type];
}

/** Swatch colour of an entity (groups and joints have none). */
function swatchOf(e: Entity): string | null {
  if (isBody(e)) return e.material.color;
  if (isSoft(e) || isLight(e) || isPath(e)) return e.color;
  return null;
}

function titleOf(e: Entity, members: number): string {
  if (isBody(e)) return `${e.name} — ${e.bodyType}`;
  if (isSoft(e)) return `${e.name} — soft ${SOFT_LABELS[e.type].toLowerCase()}`;
  if (isGroup(e)) return `${e.name} — group of ${members} ${members === 1 ? 'item' : 'items'}`;
  if (isLight(e)) {
    const unit = e.lightType === 'directional' ? 'lx' : e.lightType === 'area' ? 'nits' : 'cd';
    return `${e.name} — ${LIGHT_LABELS[e.lightType].toLowerCase()}, ${e.intensity} ${unit}${e.enabled ? '' : ' (off)'}`;
  }
  if (isPath(e)) {
    const len = new PathCurve({ points: e.points, closed: e.closed, tension: e.tension }).length;
    return `${e.name} — path, ${e.points.length} points, ${len.toFixed(1)} m${e.closed ? ', closed' : ''}`;
  }
  return `${e.name} — ${JOINT_TYPE_LABELS[e.type]}`;
}

/** Keys of an update that never change what the outliner shows. */
const POSE_KEYS = new Set(['position', 'rotation', 'velocity', 'angularVelocity']);

export class Outliner {
  readonly el = h('div', { class: 'panel-body o-panel' });
  private readonly list: VirtualList;
  private readonly thumbs = new ThumbnailCache();
  private rows: Row[] = [];
  private index = new Map<string, number>();
  private entities: Entity[] = [];
  private sort: SortMode = 'manual';
  private structured: Filter = emptyFilter();
  private filter: Filter = emptyFilter();
  private anchor: string | null = null;
  private dirty = true;
  private queued = false;
  private dragging = false;
  private refreshQueued = false;
  /** Groups folded away in this outliner (view state, not part of the document). */
  private readonly folded = new Set<string>();

  private readonly input: HTMLInputElement;
  private readonly sortSel: HTMLSelectElement;
  private readonly filterRow: HTMLElement;
  private readonly filterBtn: HTMLButtonElement;
  private readonly setsBar: HTMLElement;
  private readonly tagBar: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly selects: Record<'type' | 'material' | 'tag' | 'state' | 'component', HTMLSelectElement>;

  constructor(private app: App) {
    this.input = h('input', {
      type: 'text',
      placeholder: 'Filter…  e.g. wheel  type:box  tag:red  is:locked',
      spellcheck: false,
      title: 'Search by name. Filters: type:box material:steel tag:name is:locked|hidden has:component',
      'aria-label': 'Filter objects',
    });
    this.input.addEventListener('input', () => this.applyFilter());
    this.input.addEventListener('keydown', (e) => e.stopPropagation());
    this.sortSel = h(
      'select',
      { class: 'o-sort', title: 'Sort the outliner (drag to reorder works in scene order)', 'aria-label': 'Sort' },
      (Object.keys(SORT_LABELS) as SortMode[]).map((k) => h('option', { value: k }, SORT_LABELS[k])),
    );
    this.sortSel.addEventListener('change', () => {
      this.sort = this.sortSel.value as SortMode;
      this.rebuild();
    });
    this.filterBtn = h(
      'button',
      { class: 'o-filter-btn', type: 'button', title: 'Filters: type, material, tag, locked / hidden, components' },
      icon('search'),
      'Filters',
    );
    this.filterBtn.addEventListener('click', () => {
      this.filterRow.classList.toggle('open');
      this.filterBtn.classList.toggle('on', this.filterRow.classList.contains('open'));
    });
    const mk = (label: string) => h('select', { 'aria-label': label, title: label });
    this.selects = {
      type: mk('Type'),
      material: mk('Material'),
      tag: mk('Tag'),
      state: mk('State'),
      component: mk('Component'),
    };
    for (const s of Object.values(this.selects)) s.addEventListener('change', () => this.applyFilter());
    this.filterRow = h('div', { class: 'o-filters' }, Object.values(this.selects));
    this.setsBar = h('div', { class: 'o-sets' });
    this.tagBar = h('div', { class: 'o-tags' });
    this.footer = h('div', { class: 'o-footer' });
    this.empty = h('div', { class: 'o-empty' });
    this.list = new VirtualList({ rowHeight: ROW_HEIGHT, render: (i, el) => this.renderRow(i, el) });
    this.list.el.classList.add('outliner');
    this.list.el.tabIndex = 0;
    this.list.el.setAttribute('role', 'tree');
    this.list.el.setAttribute('aria-label', 'Scene outliner');
    this.wireList();
    this.el.append(
      h('div', { class: 'search o-toolbar' }, this.input, this.sortSel, this.filterBtn),
      this.filterRow,
      this.setsBar,
      this.tagBar,
      this.list.el,
      this.empty,
      this.footer,
    );
    // The whole panel is the "take it out of its group" drop zone.
    this.el.addEventListener('dragover', (ev) => {
      if (ev.dataTransfer?.types.includes(MIME)) {
        ev.preventDefault();
        this.autoScroll(ev);
      }
    });
    this.el.addEventListener('drop', (ev) => {
      const raw = ev.dataTransfer?.getData(MIME);
      this.clearMarks();
      if (raw) app.editor.setParent(JSON.parse(raw) as string[], null);
    });
    const markDirty = () => {
      this.dirty = true;
      if (this.el.offsetParent) this.queueRebuild();
    };
    app.store.on('change', (c) => {
      if (c.type === 'update' && [...c.keys].every((k) => POSE_KEYS.has(k))) return;
      if (c.type === 'assets') return;
      markDirty();
    });
    app.store.on('selection', () => this.onSelection());
    app.store.on('meta', markDirty);
    this.rebuild();
  }

  activate(): void {
    if (this.dirty) this.rebuild();
    else this.list.refresh();
  }

  /** Re-render now (kept for callers of the old API). */
  render(): void {
    this.rebuild();
  }

  // ── data → rows ───────────────────────────────────────────────────────────────────────────────────

  private queueRebuild(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.dirty && this.el.offsetParent) this.rebuild();
    });
  }

  private applyFilter(): void {
    const s = this.selects;
    const f = emptyFilter();
    f.type = s.type.value;
    f.material = s.material.value;
    f.tag = s.tag.value;
    f.component = s.component.value;
    f.locked = s.state.value === 'locked' ? true : s.state.value === 'unlocked' ? false : null;
    f.hidden = s.state.value === 'hidden' ? true : s.state.value === 'visible' ? false : null;
    this.structured = f;
    this.rebuild();
  }

  private rebuild(): void {
    if (this.dragging) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    const { store } = this.app;
    this.entities = store.all();
    this.filter = parseQuery(this.input.value, this.structured);
    this.rows = buildRows(this.entities, { folded: this.folded, filter: this.filter, sort: this.sort });
    this.index = new Map();
    this.rows.forEach((r, i) => this.index.set(r.id, i));
    this.refreshFilterOptions();
    this.renderSets();
    this.renderTagBar();
    const active = filterActive(this.filter);
    const shown = this.rows.filter((r) => r.type === 'entity').length;
    this.footer.textContent = active
      ? `${shown} of ${this.entities.length} match`
      : `${this.entities.length} ${this.entities.length === 1 ? 'item' : 'items'}`;
    this.empty.style.display = shown ? 'none' : '';
    this.list.el.style.display = shown ? '' : 'none';
    if (!shown) {
      clear(this.empty);
      // -- UI-B: empty state with an illustration --
      this.empty.appendChild(
        emptyState({
          art: this.entities.length ? 'search' : 'tree',
          title: this.entities.length ? 'No matches' : 'The scene is empty',
          hint: this.entities.length
            ? 'Clear the filter to see everything.'
            : 'Objects you add appear here as a tree: group them, hide them, lock them.',
          class: 'compact',
        }),
      );
    }
    this.list.setCount(this.rows.length);
  }

  private refreshFilterOptions(): void {
    const kinds = new Set<string>();
    const subs = new Set<string>();
    const mats = new Set<string>();
    const comps = new Set<string>();
    for (const e of this.entities) {
      const [k, sub] = typeKeys(e);
      kinds.add(k);
      if (sub) subs.add(sub);
      const m = materialOf(e);
      if (m) mats.add(m);
      for (const c of componentsOf(e)) comps.add(c.type);
    }
    const fill = (sel: HTMLSelectElement, label: string, values: string[], cur: string) => {
      const keep = values.includes(cur) ? cur : '';
      const sig = values.join('\u0001');
      if (sel.dataset.sig !== sig) {
        sel.dataset.sig = sig;
        clear(sel);
        sel.appendChild(h('option', { value: '' }, label));
        for (const v of values) sel.appendChild(h('option', { value: v }, v));
      }
      sel.value = keep;
    };
    const s = this.selects;
    fill(s.type, 'Any type', [...kinds, ...[...subs].filter((x) => !kinds.has(x)).sort()], this.structured.type);
    fill(s.material, 'Any material', [...mats].sort(), this.structured.material);
    fill(
      s.tag,
      'Any tag',
      [...tagCounts(this.entities).map((t) => t[0]), ...usedColors(this.entities)],
      this.structured.tag,
    );
    fill(s.component, 'Any component', ['any', ...[...comps].sort()], this.structured.component);
    if (!s.state.options.length) {
      for (const [v, l] of [
        ['', 'Any state'],
        ['locked', 'Locked'],
        ['unlocked', 'Unlocked'],
        ['hidden', 'Hidden'],
        ['visible', 'Visible'],
      ])
        s.state.appendChild(h('option', { value: v }, l));
    }
    // A stale selection (its option vanished) drops out of the structured filter too.
    for (const k of ['type', 'material', 'tag', 'component'] as const) if (!s[k].value) this.structured[k] = '';
  }

  // ── rows ──────────────────────────────────────────────────────────────────────────────────────────

  private renderRow(i: number, el: HTMLElement): void {
    const row = this.rows[i];
    if (!row) return;
    if (row.type === 'header') {
      const sig = `H${row.label}${row.count}`;
      if (el.dataset.sig === sig) return;
      el.dataset.sig = sig;
      el.className = 'o-group';
      el.removeAttribute('data-id');
      el.removeAttribute('draggable');
      el.style.paddingLeft = '';
      clear(el);
      el.append(h('span', null, row.label), h('span', null, String(row.count)));
      return;
    }
    const e = row.entity;
    const { store } = this.app;
    const sel = store.selection.includes(e.id);
    if (el.querySelector('.o-rename') && el.dataset.id === e.id) return; // being renamed: leave it alone
    const body = isBody(e) ? e : null;
    const thumb = body ? this.thumbs.request(body, () => this.scheduleRefresh()) : null;
    const tags = tagsOf(e);
    const sig = [
      e.id,
      row.depth,
      e.name,
      sel ? 1 : 0,
      e.hidden ? 1 : 0,
      !isJoint(e) && e.locked ? 1 : 0,
      e.solo ? 1 : 0,
      e.soloHid ? 1 : 0,
      e.colorTag ?? '',
      tags.join(','),
      row.folded ? 1 : 0,
      row.members,
      thumb ? 't' : '',
      swatchOf(e) ?? '',
      iconOf(e),
    ].join('|');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    const lockable = !isJoint(e);
    el.className = `o-item ${sel ? 'sel' : ''} ${e.hidden ? 'hidden-item' : ''} ${isGroup(e) ? 'is-group' : ''} ${e.solo ? 'is-solo' : ''}`;
    el.dataset.id = e.id;
    el.dataset.kind = e.kind;
    el.draggable = !isJoint(e);
    el.style.paddingLeft = row.depth ? `${10 + row.depth * 16}px` : '';
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-selected', String(sel));
    el.setAttribute('aria-level', String(row.depth + 1));
    clear(el);
    // Groups get a fold arrow; everything else a spacer of the same width so names line up.
    if (isGroup(e)) {
      const open = !row.folded;
      el.setAttribute('aria-expanded', String(open));
      el.appendChild(
        h(
          'button',
          {
            class: `o-caret ${open ? 'open' : ''}`,
            type: 'button',
            title: open ? 'Fold the group' : 'Unfold the group',
            'aria-expanded': String(open),
            dataset: { act: 'fold' },
            tabIndex: -1,
          },
          icon('chevron'),
        ),
      );
    } else if (row.depth > 0 || this.entities.some(isGroup)) el.appendChild(h('span', { class: 'o-caret spacer' }));
    if (thumb) el.appendChild(h('img', { class: 'o-thumb', src: thumb, alt: '', draggable: false }));
    else el.appendChild(icon(iconOf(e)));
    const swatch = swatchOf(e);
    if (swatch && !thumb) el.appendChild(h('span', { class: 'o-swatch', style: { background: swatch } }));
    if (e.colorTag && TAG_COLORS[e.colorTag])
      el.appendChild(
        h('span', {
          class: 'o-ctag',
          style: { background: TAG_COLORS[e.colorTag] },
          title: `Colour tag: ${e.colorTag} (click to select all)`,
          dataset: { act: 'ctag', tag: `color:${e.colorTag}` },
        }),
      );
    el.appendChild(h('span', { class: 'o-name', title: titleOf(e, row.members) }, e.name));
    if (tags.length) {
      const chips = h('span', { class: 'o-chips' });
      for (const t of tags.slice(0, 2))
        chips.appendChild(
          h(
            'span',
            {
              class: 'o-chip',
              title: `Tag "${t}" — click to select every object with it`,
              dataset: { act: 'tag', tag: t },
            },
            t,
          ),
        );
      if (tags.length > 2)
        chips.appendChild(h('span', { class: 'o-chip more', title: tags.slice(2).join(', ') }, `+${tags.length - 2}`));
      el.appendChild(chips);
    }
    const tools = h('span', { class: `o-tools ${e.hidden || (lockable && e.locked) || e.solo ? 'has' : ''}` });
    tools.appendChild(
      h(
        'button',
        {
          class: `o-tool o-solo ${e.solo ? 'active' : ''}`,
          type: 'button',
          title: e.solo ? 'Un-solo (show everything again)' : 'Solo: hide everything not related to this',
          dataset: { act: 'solo' },
          tabIndex: -1,
        },
        'S',
      ),
    );
    if (lockable)
      tools.appendChild(
        h(
          'button',
          {
            class: `o-tool ${e.locked ? 'active' : ''}`,
            type: 'button',
            title: e.locked ? 'Unlock' : 'Lock in the editor',
            dataset: { act: 'lock' },
            tabIndex: -1,
          },
          icon(e.locked ? 'lock' : 'unlock'),
        ),
      );
    tools.appendChild(
      h(
        'button',
        {
          class: `o-tool ${e.hidden ? 'active' : ''}`,
          type: 'button',
          title: e.hidden ? 'Show' : 'Hide',
          dataset: { act: 'eye' },
          tabIndex: -1,
        },
        icon(e.hidden ? 'eyeOff' : 'eye'),
      ),
    );
    el.appendChild(tools);
  }

  private scheduleRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      this.list.refresh();
    });
  }

  private onSelection(): void {
    const { store } = this.app;
    // A single object picked elsewhere (viewport): unfold the groups above it so the row exists, then show it.
    if (store.selection.length === 1 && !filterActive(this.filter)) {
      let e = store.get(store.selection[0]);
      let changed = false;
      for (let g = 0; e && 'parent' in e && e.parent && g < 1000; g++) {
        if (this.folded.delete(e.parent)) changed = true;
        e = store.get(e.parent);
      }
      if (changed) this.rebuild();
    }
    this.list.refresh();
    const first = store.selection.map((id) => this.index.get(id)).find((i) => i !== undefined);
    if (first !== undefined) this.list.reveal(first);
  }

  // ── interaction ───────────────────────────────────────────────────────────────────────────────────

  private rowOf(t: EventTarget | null): { el: HTMLElement; row: EntityRow } | null {
    const el = (t as HTMLElement | null)?.closest<HTMLElement>('.o-item');
    const i = el?.dataset.id ? this.index.get(el.dataset.id) : undefined;
    const row = i !== undefined ? this.rows[i] : undefined;
    return el && row?.type === 'entity' ? { el, row } : null;
  }

  private wireList(): void {
    const root = this.list.el;
    root.addEventListener('click', (ev) => {
      const hit = this.rowOf(ev.target);
      if (!hit) return;
      const { row } = hit;
      const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
      const { store, editor } = this.app;
      if (act) {
        ev.stopPropagation();
        switch (act.dataset.act) {
          case 'fold':
            if (this.folded.has(row.id)) this.folded.delete(row.id);
            else this.folded.add(row.id);
            this.rebuild();
            return;
          case 'lock':
            return editor.toggleFlag([row.id], 'locked');
          case 'eye':
            return editor.toggleFlag([row.id], 'hidden');
          case 'solo':
            return this.toggleSolo(store.selection.includes(row.id) ? store.selection : [row.id], row.id);
          case 'tag':
          case 'ctag':
            return this.selectTag(act.dataset.tag!, ev.ctrlKey || ev.metaKey || ev.shiftKey);
          default:
            return;
        }
        return;
      }
      if (ev.shiftKey && this.anchor) {
        const ids = rangeIds(this.rows, this.anchor, row.id);
        if (ids.length) {
          store.setSelection(ev.ctrlKey || ev.metaKey ? [...new Set([...store.selection, ...ids])] : ids);
          return;
        }
      }
      if (ev.ctrlKey || ev.metaKey) store.toggleSelection(row.id);
      else store.setSelection([row.id]);
      this.anchor = row.id;
    });
    root.addEventListener('dblclick', (ev) => {
      const hit = this.rowOf(ev.target);
      if (hit && !(ev.target as HTMLElement).closest('[data-act]')) this.startRename(hit.row.id);
    });
    root.addEventListener('contextmenu', (ev) => {
      const hit = this.rowOf(ev.target);
      if (!hit) return;
      ev.preventDefault();
      const { store } = this.app;
      if (!store.selection.includes(hit.row.id)) {
        store.setSelection([hit.row.id]);
        this.anchor = hit.row.id;
      }
      openMenu(this.contextItems(hit.row.id), { x: ev.clientX, y: ev.clientY });
    });
    root.addEventListener('keydown', (ev) => this.onKey(ev));
    // drag & drop
    root.addEventListener('dragstart', (ev) => {
      const hit = this.rowOf(ev.target);
      if (!hit || isJoint(hit.row.entity)) return;
      // Dragging a selected row drags the whole selection, an unselected one just itself. (The selection is left
      // alone: changing it would switch the side panel to the inspector and hide the very list being dragged over.)
      const { store } = this.app;
      const dragged = store.selection.includes(hit.row.id) ? store.selection : [hit.row.id];
      ev.dataTransfer?.setData(MIME, JSON.stringify(dragged));
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      this.dragging = true;
    });
    root.addEventListener('dragend', () => {
      this.dragging = false;
      this.clearMarks();
      if (this.dirty) this.rebuild();
    });
    root.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer?.types.includes(MIME)) return;
      this.autoScroll(ev);
      const hit = this.rowOf(ev.target);
      this.clearMarks();
      if (!hit) return;
      const zone = this.zoneAt(ev, hit);
      if (!zone) return; // not droppable here: bubbles to the panel (take out of group)
      ev.preventDefault();
      ev.stopPropagation();
      hit.el.classList.add(`drop-${zone}`);
    });
    root.addEventListener('dragleave', (ev) => {
      // Leaving a row for its neighbour is followed by a dragover that re-marks; only leaving the list clears.
      const r = root.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) this.clearMarks();
    });
    root.addEventListener('drop', (ev) => {
      const raw = ev.dataTransfer?.getData(MIME);
      const hit = this.rowOf(ev.target);
      this.clearMarks();
      if (!raw || !hit) return;
      const zone = this.zoneAt(ev, hit);
      if (!zone) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.dragging = false;
      this.drop(JSON.parse(raw) as string[], hit.row.id, zone);
    });
  }

  /** Which part of the hovered row the pointer is in, or null if dropping there is not offered. */
  private zoneAt(ev: DragEvent, hit: { el: HTMLElement; row: EntityRow }): DropZone | null {
    const r = hit.el.getBoundingClientRect();
    const target = hit.row.entity;
    const zone = dropZone((ev.clientY - r.top) / Math.max(1, r.height), isGroup(target));
    if (isJoint(target)) return null;
    // In a sorted or filtered list the position is not editable: only "into this group" remains.
    if (!this.canReorder() && zone !== 'inside') return isGroup(target) ? 'inside' : null;
    return zone;
  }

  private canReorder(): boolean {
    return this.sort === 'manual' && !filterActive(this.filter);
  }

  private clearMarks(): void {
    for (const el of this.list.el.querySelectorAll('.drop-before, .drop-after, .drop-inside'))
      el.classList.remove('drop-before', 'drop-after', 'drop-inside');
  }

  private autoScroll(ev: DragEvent): void {
    const r = this.list.el.getBoundingClientRect();
    if (ev.clientY < r.top + 22) this.list.el.scrollTop -= 14;
    else if (ev.clientY > r.bottom - 22) this.list.el.scrollTop += 14;
  }

  private drop(dragged: string[], targetId: string, zone: DropZone): void {
    const { store, editor } = this.app;
    const plan = planDrop(this.entities, this.rows, dragged, targetId, zone, this.canReorder());
    if (!plan) {
      this.app.toast('Nothing to move there', 'warn');
      return;
    }
    if (plan.order && this.app.sim.active) {
      this.app.toast('Stop the simulation to change the scene order', 'warn');
      return;
    }
    store.transact(plan.parent === null ? 'Move in outliner' : 'Move into group', () => {
      editor.setParent(plan.ids, plan.parent);
      if (plan.order) {
        // Re-seat each moved entity at its place in the new order, ascending so earlier seats stay valid.
        const want = new Map(plan.order.map((id, i) => [id, i]));
        for (const id of [...plan.ids].sort((a, b) => want.get(a)! - want.get(b)!)) store.reorder(id, want.get(id)!);
      }
    });
    // Reveal the destination group.
    if (plan.parent) this.folded.delete(plan.parent);
    this.dirty = true;
    this.rebuild();
  }

  // ── keyboard ──────────────────────────────────────────────────────────────────────────────────────

  private onKey(ev: KeyboardEvent): void {
    if ((ev.target as HTMLElement).tagName === 'INPUT') return;
    const { store } = this.app;
    const focus = this.anchor ?? store.selection[store.selection.length - 1] ?? null;
    const at = focus !== null ? (this.index.get(focus) ?? -1) : -1;
    const step = (dir: number) => {
      let i = at + dir;
      while (i >= 0 && i < this.rows.length && this.rows[i].type !== 'entity') i += dir;
      if (i < 0 || i >= this.rows.length) return;
      const id = this.rows[i].id;
      if (ev.shiftKey) {
        const ids = rangeIds(this.rows, this.anchorFixed ?? focus, id);
        store.setSelection(ids);
        this.anchorFixed ??= focus;
        this.anchor = id;
      } else {
        this.anchorFixed = null;
        store.setSelection([id]);
        this.anchor = id;
      }
      this.list.reveal(i);
    };
    switch (ev.key) {
      case 'ArrowDown':
        step(1);
        break;
      case 'ArrowUp':
        step(-1);
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        const row = at >= 0 ? this.rows[at] : undefined;
        if (row?.type !== 'entity' || !isGroup(row.entity)) return;
        if (ev.key === 'ArrowLeft') this.folded.add(row.id);
        else this.folded.delete(row.id);
        this.rebuild();
        break;
      }
      case 'F2':
        if (focus) this.startRename(focus);
        else return;
        break;
      default:
        return;
    }
    ev.preventDefault();
    ev.stopPropagation();
  }
  private anchorFixed: string | null = null;

  // ── rename ────────────────────────────────────────────────────────────────────────────────────────

  startRename(id: string): void {
    const i = this.index.get(id);
    if (i === undefined) return;
    this.list.reveal(i);
    this.list.refresh();
    const rowEl = this.list.rowAt(i);
    const name = rowEl?.querySelector<HTMLElement>('.o-name');
    const e = this.app.store.get(id);
    if (!rowEl || !name || !e) return;
    const input = h('input', { class: 'o-rename', type: 'text', value: e.name, spellcheck: false });
    name.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const done = (save: boolean) => {
      if (finished) return;
      finished = true;
      const v = input.value.trim();
      // Put the name back first (the row is re-rendered from the store either way), then save.
      input.replaceWith(name);
      rowEl.dataset.sig = '';
      if (save && v && v !== e.name) this.app.store.update(id, { name: v.slice(0, 120) }, 'Rename');
      else this.list.refresh();
      this.list.el.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (k) => {
      k.stopPropagation();
      if (k.key === 'Enter') done(true);
      else if (k.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
    input.addEventListener('click', (c) => c.stopPropagation());
    input.addEventListener('dblclick', (c) => c.stopPropagation());
  }

  // ── solo, tags, sets ──────────────────────────────────────────────────────────────────────────────

  private toggleSolo(ids: string[], clicked: string): void {
    const { store } = this.app;
    const target = ids.includes(clicked) ? ids : [clicked];
    const patches = soloPatches(store.all(), target);
    if (patches.length) store.updateMany(patches, store.get(clicked)?.solo ? 'Clear solo' : 'Solo');
  }

  /** Quick-select: every object carrying `tag` (a free tag, or `color:<key>`); `add` extends the selection. */
  selectTag(tag: string, add = false): void {
    const { store } = this.app;
    const ids = idsWithTag(store.all(), tag);
    if (!ids.length) return;
    store.setSelection(add ? [...new Set([...store.selection, ...ids])] : ids);
    this.app.toast(`Selected ${ids.length} tagged "${tag.replace('color:', '')}"`, 'info');
  }

  private tagSelected(tag: string, on: boolean): void {
    const { store } = this.app;
    const patches: [string, Partial<Entity>][] = [];
    for (const id of store.selection) {
      const e = store.get(id);
      if (e) patches.push([id, { tags: withTag(e.tags, tag, on) }]);
    }
    store.updateMany(patches, on ? 'Add tag' : 'Remove tag');
  }

  private colorSelected(key: string | undefined): void {
    const { store } = this.app;
    store.updateMany(
      store.selection.map((id) => [id, { colorTag: key }] as [string, Partial<Entity>]),
      key ? 'Colour tag' : 'Clear colour tag',
    );
  }

  private renderSets(): void {
    clear(this.setsBar);
    const { store } = this.app;
    const sets = store.settings.selectionSets;
    this.setsBar.style.display = sets.length || store.selection.length ? '' : 'none';
    const save = h(
      'button',
      {
        class: 'o-set-add',
        type: 'button',
        title: 'Save the current selection as a named set',
        disabled: !store.selection.length,
      },
      icon('plus'),
      'Set',
    );
    save.addEventListener('click', () => void this.saveSet());
    this.setsBar.appendChild(save);
    for (const s of sets) {
      const live = s.ids.filter((id) => store.has(id)).length;
      const chip = h(
        'button',
        {
          class: 'o-set',
          type: 'button',
          title: `Select "${s.name}" — ${live} of ${s.ids.length} still in the scene. Ctrl+click adds to the selection; right-click for more.`,
          dataset: { set: s.name },
        },
        h('span', { class: 'o-set-name' }, s.name),
        h('span', { class: 'o-set-n' }, String(live)),
      );
      chip.addEventListener('click', (ev) => this.recallSet(s.name, ev.ctrlKey || ev.metaKey || ev.shiftKey));
      chip.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        openMenu(
          [
            { label: 'Select', action: () => this.recallSet(s.name, false) },
            { label: 'Add to selection', action: () => this.recallSet(s.name, true) },
            {
              label: 'Update from current selection',
              disabled: !store.selection.length,
              action: () => this.updateSet(s.name),
            },
            { label: 'Rename…', action: () => void this.renameSet(s.name) },
            { sep: true },
            { label: 'Delete set', action: () => this.deleteSet(s.name) },
          ],
          { x: ev.clientX, y: ev.clientY },
        );
      });
      this.setsBar.appendChild(chip);
    }
  }

  async saveSet(): Promise<void> {
    const { store } = this.app;
    if (!store.selection.length) return;
    const sets = store.settings.selectionSets;
    const name = await promptText(
      'Save selection set',
      `Name for the ${store.selection.length} selected ${store.selection.length === 1 ? 'item' : 'items'}:`,
      uniqueSetName(
        sets.map((s) => s.name),
        'Set',
      ),
      'Save',
    );
    if (!name) return;
    const final = sets.some((s) => s.name === name)
      ? uniqueSetName(
          sets.map((s) => s.name),
          name,
        )
      : name;
    store.updateSettings(
      { selectionSets: [...sets, { name: final, ids: [...store.selection] }] },
      'Save selection set',
    );
  }

  recallSet(name: string, add: boolean): void {
    const { store } = this.app;
    const s = store.settings.selectionSets.find((x) => x.name === name);
    if (!s) return;
    const ids = s.ids.filter((id) => store.has(id));
    if (!ids.length) {
      this.app.toast(`Nothing from "${name}" is left in the scene`, 'warn');
      return;
    }
    store.setSelection(add ? [...new Set([...store.selection, ...ids])] : ids);
    if (ids.length < s.ids.length)
      this.app.toast(`${s.ids.length - ids.length} object(s) of "${name}" no longer exist`, 'info');
  }

  private updateSet(name: string): void {
    const { store } = this.app;
    store.updateSettings(
      {
        selectionSets: store.settings.selectionSets.map((s) =>
          s.name === name ? { name, ids: [...store.selection] } : s,
        ),
      },
      'Update selection set',
    );
  }

  private async renameSet(name: string): Promise<void> {
    const { store } = this.app;
    const sets = store.settings.selectionSets;
    const next = await promptText('Rename selection set', 'New name:', name, 'Rename');
    if (!next || next === name || sets.some((s) => s.name === next)) return;
    store.updateSettings(
      { selectionSets: sets.map((s) => (s.name === name ? { ...s, name: next } : s)) },
      'Rename selection set',
    );
  }

  private deleteSet(name: string): void {
    const { store } = this.app;
    store.updateSettings(
      { selectionSets: store.settings.selectionSets.filter((s) => s.name !== name) },
      'Delete selection set',
    );
  }

  private renderTagBar(): void {
    clear(this.tagBar);
    const tags = tagCounts(this.entities);
    const colors = new Map<string, number>();
    for (const e of this.entities) if (e.colorTag) colors.set(e.colorTag, (colors.get(e.colorTag) ?? 0) + 1);
    this.tagBar.style.display = tags.length || colors.size ? '' : 'none';
    const add = (label: string, n: number, tag: string, color?: string) => {
      const b = h(
        'button',
        {
          class: 'o-tagchip',
          type: 'button',
          title: `Select all ${n} with ${color ? 'colour' : 'tag'} "${label}" (Ctrl+click adds to the selection)`,
          dataset: { tag },
        },
        color ? h('span', { class: 'o-ctag', style: { background: color } }) : null,
        label,
        h('span', { class: 'o-set-n' }, String(n)),
      );
      b.addEventListener('click', (ev) => this.selectTag(tag, ev.ctrlKey || ev.metaKey || ev.shiftKey));
      this.tagBar.appendChild(b);
    };
    for (const k of TAG_COLOR_KEYS) {
      const n = colors.get(k);
      if (n) add(k, n, `color:${k}`, TAG_COLORS[k]);
    }
    for (const [t, n] of tags.slice(0, 40)) add(t, n, t);
  }

  // ── context menu ──────────────────────────────────────────────────────────────────────────────────

  private contextItems(id: string): MenuItem[] {
    const { store, editor } = this.app;
    const sel = store.selection.map((s) => store.get(s)).filter((e): e is Entity => !!e);
    const first = store.get(id);
    const posed = sel.filter(isPosed);
    const items: MenuItem[] = [
      { label: 'Rename', kbd: 'F2', action: () => this.startRename(id) },
      { label: 'Frame in view', action: () => this.app.frameSelection() },
      { sep: true },
      { label: 'Group selection', kbd: 'Ctrl+G', disabled: !posed.length, action: () => void editor.groupSelection() },
      { label: 'Ungroup', disabled: !sel.some(isGroup), action: () => void editor.ungroup() },
      { label: 'Duplicate', action: () => editor.duplicateSelection() },
      { label: 'Delete', action: () => editor.deleteSelection() },
      { sep: true },
      {
        label: sel.some((e) => e.solo) ? 'Clear solo' : 'Solo',
        action: () =>
          this.toggleSolo(
            sel.map((e) => e.id),
            id,
          ),
      },
      {
        label: sel.every((e) => e.hidden) ? 'Show' : 'Hide',
        action: () =>
          editor.toggleFlag(
            sel.map((e) => e.id),
            'hidden',
          ),
      },
      {
        label: posed.every((e) => e.locked) ? 'Unlock' : 'Lock',
        disabled: !posed.length,
        action: () =>
          editor.toggleFlag(
            posed.map((e) => e.id),
            'locked',
          ),
      },
      { sep: true },
      { heading: 'Tags' },
      {
        label: 'Add tag…',
        action: () => {
          void promptText('Add tag', 'Tag for the selected objects:', '', 'Add').then((t) => {
            if (t) this.tagSelected(t.slice(0, 48), true);
          });
        },
      },
    ];
    const present = [...new Set(sel.flatMap((e) => [...tagsOf(e)]))];
    for (const t of present) items.push({ label: `Remove tag "${t}"`, action: () => this.tagSelected(t, false) });
    for (const k of TAG_COLOR_KEYS)
      items.push({
        label: `Colour: ${k}`,
        checked: sel.length > 0 && sel.every((e) => e.colorTag === k),
        action: () => this.colorSelected(k),
      });
    items.push({
      label: 'Clear colour tag',
      disabled: !sel.some((e) => e.colorTag),
      action: () => this.colorSelected(undefined),
    });
    items.push({ sep: true }, { heading: 'Select' });
    if (first && isGroup(first))
      items.push({
        label: 'Select members',
        action: () => store.setSelection(store.descendants(first.id).map((e) => e.id)),
      });
    if (first)
      items.push({
        label: `Select all of type "${typeKeys(first).at(-1) ?? first.kind}"`,
        action: () => {
          const key = typeKeys(first).at(-1);
          store.setSelection(this.entities.filter((e) => typeKeys(e).at(-1) === key).map((e) => e.id));
        },
      });
    if (first && tagsOf(first).length)
      for (const t of tagsOf(first)) items.push({ label: `Select all tagged "${t}"`, action: () => this.selectTag(t) });
    items.push({ label: 'Save selection as set…', action: () => void this.saveSet() });
    if (first && isGroup(first))
      items.push(
        { sep: true },
        { label: 'Expand all groups', action: () => this.setAllFolded(false) },
        { label: 'Collapse all groups', action: () => this.setAllFolded(true) },
      );
    return items;
  }

  private setAllFolded(fold: boolean): void {
    this.folded.clear();
    if (fold) for (const g of this.app.store.groups()) this.folded.add(g.id);
    this.rebuild();
  }

  /** Test / diagnostics hook: how many row elements exist vs. rows in the model. */
  stats(): { rows: number; mounted: number; thumbs: number; renders: number } {
    return {
      rows: this.rows.length,
      mounted: this.list.mounted,
      thumbs: this.thumbs.size,
      renders: this.thumbs.renders,
    };
  }

  /** Does `e` pass the current filter (used by tests). */
  passes(e: Entity): boolean {
    return matches(e, this.filter);
  }

  dispose(): void {
    this.thumbs.dispose();
    this.list.dispose();
  }
}

function usedColors(entities: readonly Entity[]): string[] {
  const s = new Set<string>();
  for (const e of entities) if (e.colorTag) s.add(e.colorTag);
  return [...s];
}
