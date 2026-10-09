import type { App } from '../app/app';
import { JOINT_TYPE_LABELS } from '../model/factory';
import type { Entity } from '../model/types';
import { isBody } from '../model/types';
import { clear, h } from './dom';
import { icon } from './icons';

const JOINT_ICON = { fixed: 'weld', hinge: 'hinge', slider: 'slider', ball: 'ball', spring: 'spring', rope: 'rope' } as const;

export class Outliner {
  readonly el = h('div', { class: 'panel-body' });
  private list = h('div', { class: 'outliner' });
  private filter = '';
  private anchor: string | null = null;
  private dirty = true;

  constructor(private app: App) {
    const search = h('div', { class: 'search' }, h('input', { type: 'text', placeholder: 'Filter objects…', spellcheck: false }));
    const input = search.firstElementChild as HTMLInputElement;
    input.addEventListener('input', () => { this.filter = input.value.toLowerCase(); this.render(); });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.append(search, this.list);
    const markDirty = () => { this.dirty = true; if (this.el.offsetParent) this.render(); };
    app.store.on('change', markDirty);
    app.store.on('selection', () => { this.updateSelection(); });
    app.store.on('meta', markDirty);
    this.render();
  }

  activate(): void { if (this.dirty) this.render(); }

  private updateSelection(): void {
    const sel = new Set(this.app.store.selection);
    for (const it of this.list.querySelectorAll<HTMLElement>('.o-item')) it.classList.toggle('sel', sel.has(it.dataset.id!));
    const first = this.list.querySelector<HTMLElement>('.o-item.sel');
    first?.scrollIntoView({ block: 'nearest' });
  }

  render(): void {
    this.dirty = false;
    clear(this.list);
    const { store } = this.app;
    const all = store.all().filter((e) => !this.filter || e.name.toLowerCase().includes(this.filter));
    const bodies = all.filter(isBody), joints = all.filter((e) => !isBody(e));
    if (!all.length) {
      this.list.appendChild(h('div', { class: 'empty-state' }, h('p', null, this.filter ? 'No matches.' : 'The scene is empty.')));
      return;
    }
    if (bodies.length) {
      this.list.appendChild(h('div', { class: 'o-group' }, h('span', null, 'Bodies'), h('span', null, String(bodies.length))));
      for (const b of bodies) this.list.appendChild(this.item(b));
    }
    if (joints.length) {
      this.list.appendChild(h('div', { class: 'o-group' }, h('span', null, 'Joints & constraints'), h('span', null, String(joints.length))));
      for (const j of joints) this.list.appendChild(this.item(j));
    }
    this.updateSelection();
  }

  private item(e: Entity): HTMLElement {
    const { store, editor } = this.app;
    const sel = store.selection.includes(e.id);
    const ic = isBody(e) ? icon(e.shape.type) : icon(JOINT_ICON[e.type]);
    const name = h('span', { class: 'o-name', title: isBody(e) ? `${e.name} — ${e.bodyType}` : `${e.name} — ${JOINT_TYPE_LABELS[e.type]}` }, e.name);
    const tools = h('span', { class: `o-tools ${e.hidden || (isBody(e) && e.locked) ? 'has' : ''}` });
    if (isBody(e)) {
      const lock = h('button', { class: `o-tool ${e.locked ? 'active' : ''}`, type: 'button', title: e.locked ? 'Unlock' : 'Lock in the editor' }, icon(e.locked ? 'lock' : 'unlock'));
      lock.addEventListener('click', (ev) => { ev.stopPropagation(); editor.toggleFlag([e.id], 'locked'); });
      tools.appendChild(lock);
    }
    const vis = h('button', { class: `o-tool ${e.hidden ? 'active' : ''}`, type: 'button', title: e.hidden ? 'Show' : 'Hide' }, icon(e.hidden ? 'eyeOff' : 'eye'));
    vis.addEventListener('click', (ev) => { ev.stopPropagation(); editor.toggleFlag([e.id], 'hidden'); });
    tools.appendChild(vis);
    const row = h('div', { class: `o-item ${sel ? 'sel' : ''} ${e.hidden ? 'hidden-item' : ''}`, dataset: { id: e.id } },
      ic, isBody(e) ? h('span', { class: 'o-swatch', style: { background: e.material.color } }) : null, name, tools);
    row.addEventListener('click', (ev) => {
      if (ev.shiftKey && this.anchor) {
        const ids = [...this.list.querySelectorAll<HTMLElement>('.o-item')].map((x) => x.dataset.id!);
        const a = ids.indexOf(this.anchor), b = ids.indexOf(e.id);
        if (a >= 0 && b >= 0) { store.setSelection(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
      }
      if (ev.ctrlKey || ev.metaKey) store.toggleSelection(e.id);
      else store.setSelection([e.id]);
      this.anchor = e.id;
    });
    row.addEventListener('dblclick', () => {
      const input = h('input', { class: 'o-rename', type: 'text', value: e.name, spellcheck: false });
      name.replaceWith(input);
      input.focus(); input.select();
      const done = (save: boolean) => { if (save && input.value.trim()) store.update(e.id, { name: input.value.trim() } as Partial<Entity>, 'Rename'); else this.render(); };
      input.addEventListener('keydown', (k) => { k.stopPropagation(); if (k.key === 'Enter') done(true); else if (k.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true));
    });
    row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); if (!store.selection.includes(e.id)) store.setSelection([e.id]); this.app.frameSelection(); });
    return row;
  }
}
