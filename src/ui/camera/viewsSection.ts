/** Camera panel: split screen, picture-in-picture windows and their cameras. */
import type { App } from '../../app/app';
import { defaultPane, newPip } from '../../app/camera/views';
import type { ViewPane } from '../../model/types';
import { button, numberField, row, section, segmented, selectField, sliderField, toggleField } from '../controls';
import { h } from '../dom';
import { registerCameraSection } from './sections';

const MODES: { value: ViewPane['mode']; label: string }[] = [
  { value: 'chase', label: 'Chase' },
  { value: 'topdown', label: 'Top-down' },
  { value: 'mount', label: 'Mounted on the body' },
  { value: 'bookmark', label: 'A saved view' },
];

/** While a slider is dragged the section is not rebuilt under the pointer; one undo step covers the drag. */
const drag = { active: false, rerender: () => {} };
const grab = (app: App, label: string) => ({
  onStart: () => {
    drag.active = true;
    app.store.begin(label);
  },
  onEnd: () => {
    app.store.end();
    drag.active = false;
    drag.rerender();
  },
});

/** The controls of one secondary camera; `change` receives the edited copy. */
function paneEditor(app: App, spec: ViewPane, change: (next: ViewPane, label: string) => void): HTMLElement {
  const bodies = app.store.bodies();
  const mode = selectField<ViewPane['mode']>({
    options: MODES,
    value: spec.mode === 'shot' ? 'chase' : spec.mode,
    onChange: (v) => change({ ...spec, mode: v }, 'Change view camera'),
  });
  const subject = selectField<string>({
    options: [{ value: '', label: 'The selected body' }, ...bodies.map((b) => ({ value: b.id, label: b.name }))],
    value: spec.subject ?? '',
    onChange: (v) => change({ ...spec, subject: v || null }, 'Change view subject'),
  });
  const rows: HTMLElement[] = [row('Camera', mode.el), row('Follows', subject.el)];
  if (spec.mode === 'bookmark') {
    const marks = app.store.cameras.bookmarks;
    const ref = selectField<string>({
      options: marks.length
        ? marks.map((b) => ({ value: b.id, label: b.name }))
        : [{ value: '', label: 'No bookmarks yet' }],
      value: spec.ref || marks[0]?.id || '',
      onChange: (v) => change({ ...spec, ref: v }, 'Change view bookmark'),
    });
    rows.push(row('View', ref.el));
    if (!spec.ref && marks[0]) queueMicrotask(() => change({ ...spec, ref: marks[0].id }, 'Change view bookmark'));
  }
  if (spec.mode === 'mount') {
    const axis = (i: 0 | 1 | 2, hint: string) =>
      numberField({
        value: spec.offset[i],
        step: 0.1,
        digits: 2,
        unit: 'm',
        title: hint,
        onChange: (v) => {
          const offset: [number, number, number] = [spec.offset[0], spec.offset[1], spec.offset[2]];
          offset[i] = v;
          change({ ...spec, offset }, 'Change camera mount');
        },
      }).el;
    rows.push(
      row(
        'Mount',
        h(
          'div',
          { class: 'cam-vec' },
          axis(0, 'Right of the body'),
          axis(1, 'Above the body'),
          axis(2, 'Behind the nose'),
        ),
      ),
      row(
        'Yaw',
        numberField({
          value: spec.yaw,
          step: 5,
          digits: 0,
          unit: '°',
          min: -180,
          max: 180,
          onChange: (v) => change({ ...spec, yaw: v }, 'Change camera mount'),
        }).el,
        'Turn left (+) or right (−)',
      ),
      row(
        'Pitch',
        numberField({
          value: spec.pitch,
          step: 5,
          digits: 0,
          unit: '°',
          min: -89,
          max: 89,
          onChange: (v) => change({ ...spec, pitch: v }, 'Change camera mount'),
        }).el,
        'Look up (+) or down (−)',
      ),
    );
  }
  rows.push(
    row(
      'Lens',
      sliderField({
        min: 20,
        max: 110,
        step: 1,
        digits: 0,
        unit: '°',
        value: spec.fov,
        onChange: (v) => change({ ...spec, fov: v }, 'Change view lens'),
        ...grab(app, 'Change view lens'),
      }).el,
    ),
  );
  return h('div', { class: 'cam-pane-editor' }, rows);
}

registerCameraSection({
  id: 'views',
  order: 50,
  build(app: App) {
    const root = h('div', { class: 'cam-views-section' });
    const set = (patch: Partial<typeof app.store.cameras>, label: string) =>
      app.store.setCameras({ ...app.store.cameras, ...patch }, label);

    const render = () => {
      if (drag.active) return;
      const cams = app.store.cameras;
      const layout = segmented<'1' | '2' | '3' | '4'>({
        options: [
          { value: '1', label: 'Single', title: 'One view' },
          { value: '2', label: '2', title: 'Two views side by side' },
          { value: '3', label: '3', title: 'One large view and two stacked' },
          { value: '4', label: '4', title: 'Four views' },
        ],
        value: String(cams.split) as '1' | '2' | '3' | '4',
        onChange: (v) => {
          const n = Number(v) as 1 | 2 | 3 | 4;
          // Fill the panes the layout needs so each has a stored camera to edit.
          const panes = Array.from({ length: Math.max(0, n - 1) }, (_, i) => cams.panes[i] ?? defaultPane(i));
          set({ split: n, panes: panes.length > cams.panes.length ? panes : cams.panes }, 'Change split screen');
        },
      });
      const blocks: HTMLElement[] = [
        row('Split screen', layout.el, 'The main view stays interactive; the other panes show their own cameras'),
      ];
      const specs = app.cameraRig.views.paneSpecs();
      specs.forEach((p, i) => {
        blocks.push(
          h(
            'div',
            { class: 'cam-pane-block' },
            h('b', null, `Pane ${i + 2}`),
            paneEditor(app, p, (next, label) => {
              const panes = specs.slice();
              panes[i] = next;
              set({ panes }, label);
            }),
          ),
        );
      });
      const mm = cams.minimap;
      const setMini = (patch: Partial<typeof mm>, label: string) => set({ minimap: { ...mm, ...patch } }, label);
      blocks.push(
        h('div', { class: 'cam-pip-head' }, h('b', null, 'Minimap')),
        toggleField({
          label: 'Show the minimap',
          value: mm.enabled,
          onChange: (v) => setMini({ enabled: v }, 'Toggle minimap'),
        }).el,
        toggleField({
          label: 'Turn with the camera',
          value: mm.rotate,
          onChange: (v) => setMini({ rotate: v }, 'Change minimap'),
        }).el,
        row(
          'Range',
          sliderField({
            min: 5,
            max: 500,
            log: true,
            unit: 'm',
            digits: 0,
            value: mm.range,
            onChange: (v) => setMini({ range: v }, 'Change minimap range'),
            ...grab(app, 'Change minimap range'),
          }).el,
          'Half-width of the map in metres (the wheel over the map zooms too)',
        ),
        row(
          'Corner',
          selectField<typeof mm.corner>({
            options: [
              { value: 'br', label: 'Bottom right' },
              { value: 'bl', label: 'Bottom left' },
              { value: 'tr', label: 'Top right' },
              { value: 'tl', label: 'Top left' },
            ],
            value: mm.corner,
            onChange: (v) => setMini({ corner: v }, 'Change minimap corner'),
          }).el,
        ),
      );
      blocks.push(h('div', { class: 'cam-pip-head' }, h('b', null, 'Picture-in-picture')));
      cams.pips.forEach((p, i) => {
        const del = button(
          'Remove',
          () => set({ pips: cams.pips.filter((x) => x.id !== p.id) }, 'Remove picture-in-picture'),
          { cls: 'small' },
        );
        blocks.push(
          h(
            'div',
            { class: 'cam-pane-block' },
            paneEditor(app, p, (next, label) => {
              const pips = cams.pips.slice();
              pips[i] = next;
              set({ pips }, label);
            }),
            del,
          ),
        );
      });
      const sel = app.store.selection.find((id) => app.store.body(id)) ?? null;
      blocks.push(
        h(
          'div',
          { class: 'cam-actions' },
          button(
            'Dashcam on the selected body',
            () => {
              if (!sel) {
                app.toast('Select the body to mount the camera on', 'warn');
                return;
              }
              set({ pips: [...cams.pips, newPip(sel, 'mount')].slice(0, 4) }, 'Add picture-in-picture');
            },
            { icon: 'plus', cls: 'small', title: 'A window showing what a camera fixed to the selected body sees' },
          ),
          button(
            'Chase window',
            () => set({ pips: [...cams.pips, newPip(sel, 'chase')].slice(0, 4) }, 'Add picture-in-picture'),
            { icon: 'plus', cls: 'small' },
          ),
        ),
        h(
          'p',
          { class: 'hint-text' },
          'Drag a window by its title bar, resize it from the corner. Windows and layout are saved with the scene.',
        ),
      );
      root.replaceChildren(...blocks);
    };
    drag.rerender = render;
    app.store.on('meta', render);
    app.store.on('selection', render);
    render();
    return {
      el: section('Split screen & picture-in-picture', [root], { id: 'cam-views', open: false }),
      refresh: render,
    };
  },
});
