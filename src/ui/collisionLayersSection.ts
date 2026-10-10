/**
 * JT-30: the "Collision layers" section of the World tab. Sixteen named layers, a symmetric
 * interaction matrix (a checked cell = the two layers collide) and a per-layer "trigger" switch (its bodies pass through
 * everything but still report overlaps). Edits go through the scene settings: undoable, applied to a running world.
 */
import type { App } from '../app/app';
import {
  LAYER_COUNT,
  defaultLayers,
  isDefaultLayers,
  layerNames,
  layersCollide,
  setLayerPair,
  type CollisionLayers,
} from '../model/collisionLayers';
import { button, row, rowStack, section } from './controls';
import { h } from './dom';

export function buildCollisionLayersSection(app: App): { el: HTMLElement[]; refresh: () => void } {
  const { store } = app;
  const current = (): CollisionLayers => store.settings.layers ?? defaultLayers();
  const commit = (next: CollisionLayers, label: string) =>
    store.updateSettings({ layers: isDefaultLayers(next) ? undefined : next }, label);

  // ---- names + trigger switches ------------------------------------------------------------------
  const nameInputs: HTMLInputElement[] = [];
  const triggers: HTMLInputElement[] = [];
  const list = h('div', { class: 'layer-list' });
  for (let i = 0; i < LAYER_COUNT; i++) {
    const input = h('input', {
      class: 'plain layer-name',
      type: 'text',
      maxLength: 32,
      spellcheck: false,
      title: `Name of layer ${i}`,
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
    });
    input.addEventListener('change', () => {
      const names = [...current().names];
      names[i] = input.value.trim() || layerNames(undefined)[i];
      commit({ ...current(), names }, 'Rename collision layer');
    });
    const trig = h('input', {
      type: 'checkbox',
      class: 'layer-trigger',
      title: 'Trigger layer: its bodies pass through everything but still report overlaps (sensor events)',
    });
    trig.addEventListener('change', () => {
      const l = current();
      commit({ ...l, trigger: trig.checked ? l.trigger | (1 << i) : l.trigger & ~(1 << i) }, 'Toggle trigger layer');
    });
    nameInputs.push(input);
    triggers.push(trig);
    list.appendChild(h('div', { class: 'layer-row' }, h('span', { class: 'layer-idx' }, String(i)), input, trig));
  }

  // ---- matrix (lower triangle) ------------------------------------------------------------------
  const cells = new Map<string, HTMLInputElement>();
  const rowLabels: HTMLElement[] = [];
  const table = h('table', { class: 'layer-matrix' });
  const head = h('tr', null, h('th'));
  for (let b = 0; b < LAYER_COUNT; b++) head.appendChild(h('th', { title: `Layer ${b}` }, String(b)));
  table.appendChild(head);
  for (let a = 0; a < LAYER_COUNT; a++) {
    const tr = h('tr');
    const label = h('th', { class: 'layer-matrix-name' });
    rowLabels.push(label);
    tr.appendChild(label);
    for (let b = 0; b < LAYER_COUNT; b++) {
      if (b > a) {
        tr.appendChild(h('td', { class: 'blank' }));
        continue;
      }
      const cb = h('input', { type: 'checkbox', class: 'layer-cell' });
      cb.dataset.a = String(a);
      cb.dataset.b = String(b);
      cb.addEventListener('change', () =>
        commit(setLayerPair(current(), a, b, cb.checked), `${cb.checked ? 'Enable' : 'Disable'} layer collision`),
      );
      cells.set(`${a},${b}`, cb);
      tr.appendChild(h('td', null, cb));
    }
    table.appendChild(tr);
  }

  const reset = button('Reset layers', () => commit(defaultLayers(), 'Reset collision layers'), {
    cls: 'small',
    title: 'Back to 16 default layers that all collide with each other',
  });

  const layersEl = section(
    'Collision layers',
    [
      h(
        'p',
        { class: 'hint-text' },
        'Every body sits on one layer and lists the layers it accepts (body inspector). A pair collides only when both bodies accept each other and the matrix below allows it. Trigger layers pass through everything but report overlaps.',
      ),
      h('div', { class: 'layer-head' }, h('span', null, '#'), h('span', null, 'Name'), h('span', null, 'Trigger')),
      list,
      rowStack('Matrix', h('div', { class: 'layer-matrix-wrap' }, table), 'Checked = the two layers collide'),
      row('', reset),
    ],
    { id: 'world-layers', open: false },
  );
  const refresh = () => {
    const l = current();
    for (let i = 0; i < LAYER_COUNT; i++) {
      if (document.activeElement !== nameInputs[i]) nameInputs[i].value = l.names[i];
      triggers[i].checked = ((l.trigger >> i) & 1) === 1;
      rowLabels[i].textContent = l.names[i].slice(0, 8);
      rowLabels[i].title = l.names[i];
    }
    for (const [key, cb] of cells) {
      const [a, b] = key.split(',').map(Number);
      cb.checked = layersCollide(l, a, b);
    }
  };
  return { el: [layersEl], refresh };
}
