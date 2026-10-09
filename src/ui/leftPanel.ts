import type { App } from '../app/app';
import { JOINT_TYPE_LABELS } from '../model/factory';
import { PREFABS } from '../model/prefabs';
import { SHAPE_LABELS } from '../model/shapes';
import { TEMPLATES } from '../model/templates';
import { SOFT_LABELS } from '../model/factory';
import type { JointType, ShapeType, SoftType } from '../model/types';
import { button } from './controls';
import { h, clear } from './dom';
import { icon } from './icons';
import { confirmReplace, importDocument } from './topbar';

const SHAPES: ShapeType[] = ['box', 'sphere', 'cylinder', 'capsule', 'cone', 'wedge', 'prism', 'icosahedron'];
const SOFTS: { type: SoftType; blurb: string }[] = [
  { type: 'jelly', blurb: 'Squishy volumetric block' },
  { type: 'balloon', blurb: 'Inflated elastic shell' },
  { type: 'cloth', blurb: 'Drapes and tears. Pin an edge or corners to hang it' },
  { type: 'cable', blurb: 'Flexible rope or cable. Pinned at both ends by default' },
];
const JOINTS: { type: JointType; blurb: string }[] = [
  { type: 'fixed', blurb: 'Locks two bodies together rigidly' },
  { type: 'hinge', blurb: 'Rotation about one axis — doors, wheels, arms. Add limits and a motor.' },
  { type: 'slider', blurb: 'Translation along one axis — pistons, rails, suspension' },
  { type: 'ball', blurb: 'Free rotation about a point — chains, ragdolls' },
  { type: 'spring', blurb: 'Spring-damper between two points' },
  { type: 'rope', blurb: 'Maximum-distance constraint — ropes, tethers' },
];

export function buildLeftPanel(app: App): HTMLElement {
  const { prefs } = app;
  const tabs = h('div', { class: 'tabs' });
  const body = h('div', { class: 'panel-body' });
  const defs = [
    { id: 'add', label: 'Add', icon: 'plus' },
    { id: 'prefabs', label: 'Prefabs', icon: 'layers' },
    { id: 'scenes', label: 'Scenes', icon: 'folder' },
  ] as const;
  const tabEls = defs.map((d) => {
    const t = h('button', { class: 'tab', type: 'button' }, icon(d.icon), d.label);
    t.addEventListener('click', () => prefs.set({ leftTab: d.id }));
    tabs.appendChild(t);
    return t;
  });

  const render = () => {
    const cur = prefs.value.leftTab;
    tabEls.forEach((t, i) => t.classList.toggle('on', defs[i].id === cur));
    clear(body);
    if (cur === 'add') body.appendChild(addTab(app));
    else if (cur === 'prefabs') body.appendChild(prefabTab(app));
    else body.appendChild(scenesTab(app, render));
  };
  prefs.on('change', (k) => {
    if (k.includes('leftTab')) render();
    if ((k.includes('jointType') || k.includes('tool')) && prefs.value.leftTab === 'add') render();
  });
  render();
  return h('aside', { class: 'panel left' }, tabs, body);
}

function addTab(app: App): HTMLElement {
  const { prefs } = app;
  const root = h('div');
  root.appendChild(h('div', { class: 'group-title' }, 'Shapes'));
  const tiles = h('div', { class: 'tiles' });
  SHAPES.forEach((s, i) => {
    const t = h(
      'button',
      {
        class: 'tile',
        type: 'button',
        draggable: true,
        title: `${SHAPE_LABELS[s]} — click to add, or drag into the scene (${i + 1})`,
      },
      icon(s),
      SHAPE_LABELS[s],
    );
    t.addEventListener('click', () => app.addShape(s));
    t.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/x-physicslab-shape', s);
      e.dataTransfer?.setData('text/plain', s);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    });
    tiles.appendChild(t);
  });
  root.appendChild(tiles);

  root.appendChild(h('div', { class: 'group-title' }, 'Soft bodies'));
  const st = h('div', { class: 'tiles' });
  for (const s of SOFTS) {
    const t = h(
      'button',
      { class: 'tile', type: 'button', title: `${s.blurb} — click to add` },
      icon(s.type),
      SOFT_LABELS[s.type],
    );
    t.addEventListener('click', () => app.addSoft(s.type));
    st.appendChild(t);
  }
  root.appendChild(st);

  root.appendChild(h('div', { class: 'group-title' }, 'Connect & constrain'));
  const jt = h('div', { class: 'tiles three' });
  for (const j of JOINTS) {
    const on = prefs.value.tool === 'joint' && prefs.value.jointType === j.type;
    const t = h(
      'button',
      {
        class: `tile ${on ? 'on' : ''}`,
        type: 'button',
        title: `${j.blurb}\nClick, then click two bodies in the scene (J).`,
      },
      icon(
        ({ fixed: 'weld', hinge: 'hinge', slider: 'slider', ball: 'ball', spring: 'spring', rope: 'rope' } as const)[
          j.type
        ],
      ),
      JOINT_TYPE_LABELS[j.type],
    );
    t.addEventListener('click', () => app.startJointTool(j.type));
    jt.appendChild(t);
  }
  root.appendChild(jt);
  root.appendChild(
    h(
      'p',
      { class: 'hint-text', style: { padding: '8px 12px 0' } },
      'Pick a joint, then click the first body, then the second (or empty ground to pin to the world). The joint appears at your first click; select it to add limits, a motor, or spring settings.',
    ),
  );

  root.appendChild(h('div', { class: 'group-title' }, 'Quick tips'));
  root.appendChild(
    h(
      'ul',
      { class: 'hint-text', style: { padding: '0 12px 12px 28px', margin: '0' } },
      h('li', null, 'Press ', h('kbd', null, '1'), '–', h('kbd', null, '8'), ' to add shapes at the view centre.'),
      h('li', null, 'Drag a body to move it; hold ', h('kbd', null, 'Shift'), ' to lift it.'),
      h('li', null, 'Press ', h('kbd', null, 'Space'), ' to simulate — then drag bodies to throw them.'),
      h('li', null, 'Open ', h('b', null, 'Scenes'), ' for ready-made experiments.'),
    ),
  );
  return root;
}

function prefabTab(app: App): HTMLElement {
  const root = h('div');
  root.appendChild(h('div', { class: 'group-title' }, 'Insert an assembly'));
  const cards = h('div', { class: 'cards' });
  for (const p of PREFABS) {
    const c = h(
      'button',
      { class: 'card', type: 'button', title: 'Insert at the centre of the view' },
      h('h4', null, icon(p.icon), p.name),
      h('p', null, p.blurb),
    );
    c.addEventListener('click', () => app.insertPrefab(p.id));
    cards.appendChild(c);
  }
  root.appendChild(cards);
  return root;
}

function scenesTab(app: App, rerender: () => void): HTMLElement {
  const root = h('div');
  root.appendChild(h('div', { class: 'group-title' }, 'My scenes'));
  const lib = app.persistence.library();
  const mine = h('div', { class: 'cards', style: { paddingBottom: '2px' } });
  if (!lib.length)
    mine.appendChild(
      h(
        'p',
        { class: 'hint-text', style: { margin: '0' } },
        'Nothing saved yet. Use File → Save to library (Ctrl+S). Your current scene is always autosaved.',
      ),
    );
  for (const e of lib) {
    const open = h(
      'button',
      { class: 'card', type: 'button', style: { flex: '1' } },
      h('h4', null, icon('folder'), e.name),
      h('p', null, `${e.bodies} bodies · ${new Date(e.savedAt).toLocaleString()}`),
    );
    open.addEventListener('click', () => {
      const doc = app.persistence.openFromLibrary(e.id);
      if (doc) confirmReplace(app, () => app.loadDocument(doc, 'frame'));
    });
    const del = h('button', { class: 'icon-btn', type: 'button', title: 'Delete from library' }, icon('trash'));
    del.addEventListener('click', () => {
      app.persistence.deleteFromLibrary(e.id);
      rerender();
    });
    mine.appendChild(h('div', { class: 'card-row' }, open, del));
  }
  root.appendChild(mine);
  const actions = h('div', { style: { display: 'flex', gap: '6px', padding: '4px 12px 8px' } });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files?.[0];
    fileIn.value = '';
    if (f) await importDocument(app, f);
  });
  actions.append(
    button(
      'Save current',
      () => {
        const e = app.persistence.saveToLibrary();
        if (e) {
          app.toast(`Saved “${e.name}”`, 'success');
          rerender();
        }
      },
      { icon: 'save', cls: 'small' },
    ),
    button('Import…', () => fileIn.click(), { icon: 'upload', cls: 'small' }),
    fileIn,
  );
  root.appendChild(actions);

  const order = ['Vehicles', 'Mechanisms', 'Soft bodies', 'Physics labs', 'Structures', 'Playground'];
  const cats = [...new Set(TEMPLATES.map((t) => t.category))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const cat of cats) {
    root.appendChild(h('div', { class: 'group-title' }, cat));
    const cards = h('div', { class: 'cards' });
    for (const t of TEMPLATES.filter((x) => x.category === cat)) {
      const c = h('button', { class: 'card', type: 'button' }, h('h4', null, t.name), h('p', null, t.blurb));
      c.addEventListener('click', () => confirmReplace(app, () => app.loadTemplate(t.id)));
      cards.appendChild(c);
    }
    root.appendChild(cards);
  }
  return root;
}
