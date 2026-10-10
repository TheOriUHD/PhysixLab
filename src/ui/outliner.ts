import type { App } from '../app/app';
import { shapeDef } from '../model/shapeRegistry';
import { JOINT_TYPE_LABELS, LIGHT_LABELS, SOFT_LABELS } from '../model/factory';
import { PathCurve } from '../model/path';
import type { Entity } from '../model/types';
import { isBody, isGroup, isJoint, isLight, isPath, isSoft, parentOf } from '../model/types';
import { clear, h } from './dom';
import { icon } from './icons';

const JOINT_ICON = {
  fixed: 'weld',
  hinge: 'hinge',
  slider: 'slider',
  ball: 'ball',
  spring: 'spring',
  rope: 'rope',
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

export class Outliner {
  readonly el = h('div', { class: 'panel-body' });
  private list = h('div', { class: 'outliner' });
  private filter = '';
  private anchor: string | null = null;
  private dirty = true;
  /** Groups folded away in this outliner (view state, not part of the document). */
  private readonly folded = new Set<string>();

  constructor(private app: App) {
    const search = h(
      'div',
      { class: 'search' },
      h('input', { type: 'text', placeholder: 'Filter objects…', spellcheck: false }),
    );
    const input = search.firstElementChild as HTMLInputElement;
    input.addEventListener('input', () => {
      this.filter = input.value.toLowerCase();
      this.render();
    });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    this.list.addEventListener('dragover', (ev) => {
      if (ev.dataTransfer?.types.includes('text/x-physicslab-entities')) ev.preventDefault();
    });
    this.list.addEventListener('drop', (ev) => {
      const raw = ev.dataTransfer?.getData('text/x-physicslab-entities');
      if (raw) app.editor.setParent(JSON.parse(raw) as string[], null);
    });
    this.el.append(search, this.list);
    const markDirty = () => {
      this.dirty = true;
      if (this.el.offsetParent) this.render();
    };
    app.store.on('change', markDirty);
    app.store.on('selection', () => {
      this.updateSelection();
    });
    app.store.on('meta', markDirty);
    this.render();
  }

  activate(): void {
    if (this.dirty) this.render();
  }

  private hasGroups(): boolean {
    return this.app.store.groups().length > 0;
  }

  /** Drag rows onto a group to put them in it, onto empty space to take them out of their group. */
  private wireDrag(row: HTMLElement, e: Entity): void {
    const { store, editor } = this.app;
    if (isJoint(e)) return;
    row.addEventListener('dragstart', (ev) => {
      if (!store.selection.includes(e.id)) store.setSelection([e.id]);
      ev.dataTransfer?.setData('text/x-physicslab-entities', JSON.stringify(store.selection));
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    });
    if (!isGroup(e)) return;
    row.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer?.types.includes('text/x-physicslab-entities')) return;
      ev.preventDefault();
      row.classList.add('drop');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (ev) => {
      row.classList.remove('drop');
      const raw = ev.dataTransfer?.getData('text/x-physicslab-entities');
      if (!raw) return;
      ev.preventDefault();
      ev.stopPropagation();
      const ids = (JSON.parse(raw) as string[]).filter((id) => id !== e.id);
      if (!editor.setParent(ids, e.id)) this.app.toast('Nothing to move into that group', 'warn');
    });
  }

  private updateSelection(): void {
    const sel = new Set(this.app.store.selection);
    for (const it of this.list.querySelectorAll<HTMLElement>('.o-item'))
      it.classList.toggle('sel', sel.has(it.dataset.id!));
    const first = this.list.querySelector<HTMLElement>('.o-item.sel');
    first?.scrollIntoView({ block: 'nearest' });
  }

  render(): void {
    this.dirty = false;
    clear(this.list);
    const { store } = this.app;
    const all = store.all().filter((e) => !this.filter || e.name.toLowerCase().includes(this.filter));
    const objects = all.filter((e) => !isJoint(e));
    const joints = all.filter(isJoint);
    if (!all.length) {
      this.list.appendChild(
        h('div', { class: 'empty-state' }, h('p', null, this.filter ? 'No matches.' : 'The scene is empty.')),
      );
      return;
    }
    if (objects.length) {
      this.list.appendChild(
        h('div', { class: 'o-group' }, h('span', null, 'Objects'), h('span', null, String(objects.length))),
      );
      if (this.filter) {
        // A filtered list is flat: members of a group are shown wherever they match.
        for (const o of objects) this.list.appendChild(this.item(o, 0, 0));
      } else {
        const present = new Set(objects.map((o) => o.id));
        const kids = new Map<string, Entity[]>();
        const roots: Entity[] = [];
        for (const o of objects) {
          const p = parentOf(o);
          if (p !== undefined && present.has(p)) kids.set(p, [...(kids.get(p) ?? []), o]);
          else roots.push(o);
        }
        const walk = (e: Entity, depth: number, trail: Set<string>) => {
          const children = trail.has(e.id) ? [] : (kids.get(e.id) ?? []);
          this.list.appendChild(this.item(e, depth, children.length));
          if (isGroup(e) && !this.folded.has(e.id)) {
            const next = new Set(trail).add(e.id);
            for (const c of children) walk(c, depth + 1, next);
          }
        };
        for (const r of roots) walk(r, 0, new Set());
      }
    }
    if (joints.length) {
      this.list.appendChild(
        h('div', { class: 'o-group' }, h('span', null, 'Joints & constraints'), h('span', null, String(joints.length))),
      );
      for (const j of joints) this.list.appendChild(this.item(j, 0, 0));
    }
    this.updateSelection();
  }

  private item(e: Entity, depth: number, members: number): HTMLElement {
    const { store, editor } = this.app;
    const sel = store.selection.includes(e.id);
    const ic = icon(iconOf(e));
    const title = titleOf(e, members);
    const name = h('span', { class: 'o-name', title }, e.name);
    const lockable = !isJoint(e);
    // Groups get a fold arrow; everything else a spacer of the same width so names line up.
    let caret: HTMLElement | null = null;
    if (isGroup(e)) {
      const open = !this.folded.has(e.id);
      caret = h(
        'button',
        {
          class: `o-caret ${open ? 'open' : ''}`,
          type: 'button',
          title: open ? 'Fold the group' : 'Unfold the group',
          'aria-expanded': String(open),
        },
        icon('chevron'),
      );
      caret.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (open) this.folded.add(e.id);
        else this.folded.delete(e.id);
        this.render();
      });
    } else if (depth > 0 || this.hasGroups()) caret = h('span', { class: 'o-caret spacer' });
    const tools = h('span', { class: `o-tools ${e.hidden || (lockable && e.locked) ? 'has' : ''}` });
    if (lockable) {
      const lock = h(
        'button',
        {
          class: `o-tool ${e.locked ? 'active' : ''}`,
          type: 'button',
          title: e.locked ? 'Unlock' : 'Lock in the editor',
        },
        icon(e.locked ? 'lock' : 'unlock'),
      );
      lock.addEventListener('click', (ev) => {
        ev.stopPropagation();
        editor.toggleFlag([e.id], 'locked');
      });
      tools.appendChild(lock);
    }
    const vis = h(
      'button',
      { class: `o-tool ${e.hidden ? 'active' : ''}`, type: 'button', title: e.hidden ? 'Show' : 'Hide' },
      icon(e.hidden ? 'eyeOff' : 'eye'),
    );
    vis.addEventListener('click', (ev) => {
      ev.stopPropagation();
      editor.toggleFlag([e.id], 'hidden');
    });
    tools.appendChild(vis);
    const swatch = swatchOf(e);
    const row = h(
      'div',
      {
        class: `o-item ${sel ? 'sel' : ''} ${e.hidden ? 'hidden-item' : ''} ${isGroup(e) ? 'is-group' : ''}`,
        dataset: { id: e.id, kind: e.kind },
        style: depth ? { paddingLeft: `${10 + depth * 16}px` } : undefined,
        draggable: !isJoint(e),
      },
      caret,
      ic,
      swatch ? h('span', { class: 'o-swatch', style: { background: swatch } }) : null,
      name,
      tools,
    );
    this.wireDrag(row, e);
    row.addEventListener('click', (ev) => {
      if (ev.shiftKey && this.anchor) {
        const ids = [...this.list.querySelectorAll<HTMLElement>('.o-item')].map((x) => x.dataset.id!);
        const a = ids.indexOf(this.anchor),
          b = ids.indexOf(e.id);
        if (a >= 0 && b >= 0) {
          store.setSelection(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
          return;
        }
      }
      if (ev.ctrlKey || ev.metaKey) store.toggleSelection(e.id);
      else store.setSelection([e.id]);
      this.anchor = e.id;
    });
    row.addEventListener('dblclick', () => {
      const input = h('input', { class: 'o-rename', type: 'text', value: e.name, spellcheck: false });
      name.replaceWith(input);
      input.focus();
      input.select();
      const done = (save: boolean) => {
        if (save && input.value.trim()) store.update(e.id, { name: input.value.trim() }, 'Rename');
        else this.render();
      };
      input.addEventListener('keydown', (k) => {
        k.stopPropagation();
        if (k.key === 'Enter') done(true);
        else if (k.key === 'Escape') done(false);
      });
      input.addEventListener('blur', () => done(true));
    });
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (!store.selection.includes(e.id)) store.setSelection([e.id]);
      this.app.frameSelection();
    });
    return row;
  }
}
