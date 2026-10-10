/**
 * The small options dialog of the File > Export commands (DT-1). This module is loaded on first use together with
 * the exporters (`src/app/export/run.ts`), which it imports lazily itself.
 */
import type { App } from '../app/app';
import { lazy } from '../core/lazy';
import { MAX_IMAGE_EDGE } from '../app/export/capture';
import { numberField, row, selectField, toggleField } from './controls';
import { h } from './dom';
import { openModal } from './modal';

export type ExportKind = 'glb' | 'obj' | 'stl' | 'png';

const runtime = lazy(() => import('../app/export/run'));

const TITLES: Record<ExportKind, string> = {
  glb: 'Export 3D scene (glTF binary, .glb)',
  obj: 'Export OBJ model',
  stl: 'Export STL model',
  png: 'Export image (PNG)',
};

const BLURBS: Record<ExportKind, string> = {
  glb: 'Materials, group hierarchy, compound parts and lights. Soft bodies are not included. Opens in Blender, three.js, Windows 3D Viewer and most viewers.',
  obj: 'Geometry in world space with materials (.mtl). OBJ has no hierarchy. Soft bodies are not included.',
  stl: 'Binary STL for 3D printing and CAD: geometry only, merged into one solid. Soft bodies are not included.',
  png: 'A picture of the scene from the current camera, without the editor overlays.',
};

const PRESETS = [
  { value: 'viewport', label: 'Match the viewport' },
  { value: '1280x720', label: '1280 × 720 (HD)' },
  { value: '1920x1080', label: '1920 × 1080 (Full HD)' },
  { value: '2560x1440', label: '2560 × 1440 (QHD)' },
  { value: '3840x2160', label: '3840 × 2160 (4K)' },
  { value: 'custom', label: 'Custom' },
];

export function openExportDialog(app: App, kind: ExportKind): void {
  const hasSelection = app.store.selection.length > 0;
  const opt = {
    selectionOnly: false,
    ground: kind !== 'stl' && kind !== 'obj',
    animateSeconds: 0,
    withMaterials: true,
    millimetres: true,
    zUp: true,
    width: Math.max(1, app.viewport.container.clientWidth),
    height: Math.max(1, app.viewport.container.clientHeight),
    transparent: false,
    helpers: false,
  };
  const rows: HTMLElement[] = [h('p', { class: 'sub', style: { marginBottom: '10px' } }, BLURBS[kind])];

  if (kind !== 'png') {
    const sel = toggleField({
      value: false,
      onChange: (v) => (opt.selectionOnly = v),
      title: hasSelection ? '' : 'Select something first',
    });
    if (!hasSelection) sel.el.querySelector('input')?.setAttribute('disabled', '');
    rows.push(row('Selection only', sel.el, 'Export just the selected objects instead of the whole scene'));
    rows.push(
      row(
        'Include ground',
        toggleField({ value: opt.ground, onChange: (v) => (opt.ground = v) }).el,
        'The ground slab (only when the whole scene is exported)',
      ),
    );
  }
  if (kind === 'glb') {
    rows.push(
      row(
        'Bake animation (s)',
        numberField({
          value: 0,
          min: 0,
          max: 60,
          step: 1,
          digits: 0,
          unit: 's',
          onChange: (v) => (opt.animateSeconds = v),
        }).el,
        'Records this many seconds of the running simulation (starts it if needed) into the file. 0 = static scene.',
      ),
    );
  }
  if (kind === 'obj') {
    rows.push(
      row(
        'Materials (.mtl)',
        toggleField({ value: true, onChange: (v) => (opt.withMaterials = v) }).el,
        'Download a .zip holding the .obj and its .mtl',
      ),
    );
  }
  if (kind === 'stl') {
    rows.push(
      row(
        'Units',
        selectField<'mm' | 'm'>({
          options: [
            { value: 'mm', label: 'Millimetres (slicers)' },
            { value: 'm', label: 'Metres' },
          ],
          value: 'mm',
          onChange: (v) => (opt.millimetres = v === 'mm'),
        }).el,
      ),
      row(
        'Z axis up',
        toggleField({ value: true, onChange: (v) => (opt.zUp = v) }).el,
        'CAD and slicers expect Z up; the scene is Y up',
      ),
    );
  }
  if (kind === 'png') {
    let syncing = false;
    const w = numberField({
      value: opt.width,
      min: 16,
      max: MAX_IMAGE_EDGE,
      step: 10,
      digits: 0,
      unit: 'px',
      onChange: (v) => {
        opt.width = Math.round(v);
        if (!syncing) preset.set('custom');
      },
    });
    const hgt = numberField({
      value: opt.height,
      min: 16,
      max: MAX_IMAGE_EDGE,
      step: 10,
      digits: 0,
      unit: 'px',
      onChange: (v) => {
        opt.height = Math.round(v);
        if (!syncing) preset.set('custom');
      },
    });
    const preset = selectField<string>({
      options: PRESETS,
      value: 'viewport',
      onChange: (v) => {
        syncing = true;
        if (v === 'viewport') {
          w.set(Math.max(1, app.viewport.container.clientWidth));
          hgt.set(Math.max(1, app.viewport.container.clientHeight));
          opt.width = Math.max(1, app.viewport.container.clientWidth);
          opt.height = Math.max(1, app.viewport.container.clientHeight);
        } else if (v !== 'custom') {
          const [pw, ph] = v.split('x').map(Number);
          w.set(pw);
          hgt.set(ph);
          opt.width = pw;
          opt.height = ph;
        }
        syncing = false;
      },
    });
    rows.push(
      row('Size', preset.el),
      row('Width', w.el),
      row('Height', hgt.el, `Up to ${MAX_IMAGE_EDGE} px per side (4K)`),
      row(
        'Transparent background',
        toggleField({ value: false, onChange: (v) => (opt.transparent = v) }).el,
        'No sky and no ground slab; the ground shadow stays. The PNG has an alpha channel.',
      ),
      row(
        'Editor helpers',
        toggleField({ value: false, onChange: (v) => (opt.helpers = v) }).el,
        'Light and path gizmos, trails and other overlays',
      ),
    );
  }

  const ok = h('button', { class: 'btn primary', type: 'button', dataset: { action: 'export' } }, 'Export');
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  const m = openModal({ title: TITLES[kind], width: '460px', body: rows, footer: [cancel, ok] });
  cancel.addEventListener('click', () => m.close());
  ok.addEventListener('click', () => {
    m.close();
    void (async () => {
      try {
        const run = await runtime();
        if (kind === 'glb') await run.exportGlb(app, opt);
        else if (kind === 'obj') run.exportObj(app, opt);
        else if (kind === 'stl') run.exportStl(app, opt);
        else await run.exportPng(app, opt);
      } catch (e) {
        app.toast(`Export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    })();
  });
  setTimeout(() => ok.focus(), 30);
}
