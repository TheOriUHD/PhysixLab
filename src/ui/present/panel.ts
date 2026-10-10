/** The Presentation panel (UI-41): every control of photo / presentation mode in one tab. */
import type { App } from '../../app/app';
import type { PanelDef } from '../../app/registry/panels';
import { button, row, section, segmented, selectField, sliderField, toggleField } from '../controls';
import { h } from '../dom';
import {
  effectiveScale,
  CAMERA_PRESETS,
  CAPTION_POSITIONS,
  DOF_PRESETS,
  LENS_PRESETS,
  fovForMm,
  matchDofPreset,
} from './model';
import type { CaptionPos, CaptureScale } from './model';
import { ENV_PRESETS, ENV_PRESET_BY_ID } from '../../render/envPresets';
import { getPresenter } from './presenter';

export function buildPresentPanel(app: App): { el: HTMLElement; onShow: () => void } {
  const p = getPresenter(app);
  const el = h('div', { class: 'panel-body qol-present' });
  const info = h('div', { class: 'hint-text qol-capture-info' });

  // ── Mode ──
  const enter = button('Present', () => p.enter(), {
    icon: 'frame',
    cls: 'primary wide',
    title: 'Hide the whole interface (F10). Esc brings it back.',
  });
  enter.dataset.qol = 'enter';
  const modeBody = h(
    'div',
    null,
    enter,
    h(
      'p',
      { class: 'hint-text', style: { margin: '8px 0 0' } },
      'Hides every panel and toolbar. Press ',
      h('kbd', null, 'Esc'),
      ' (or click the hint) to come back.',
    ),
    row(
      'Hide joints',
      toggleField({ value: p.options.hideJoints, onChange: (v) => p.set({ hideJoints: v }) }).el,
      'Hide joint markers (anchors, axes, ropes, springs) while presenting and in saved images',
    ),
    row(
      'Notifications',
      toggleField({ value: p.options.showToasts, onChange: (v) => p.set({ showToasts: v }) }).el,
      'Keep toasts visible while presenting',
    ),
  );

  // ── Camera ──
  const cams = h(
    'div',
    { class: 'qol-grid' },
    CAMERA_PRESETS.map((c) => {
      const b = button(c.label, () => p.cameraPreset(c.id), {
        cls: 'small',
        title: `${c.label} view of the selection (or the whole scene)`,
      });
      b.dataset.camera = c.id;
      return b;
    }),
  );
  const turnBtn = button('', () => (p.turning ? p.setTurntable(false) : p.setTurntable(true)), {
    icon: 'rotate',
    cls: 'small',
  });
  const syncTurn = () => {
    turnBtn.querySelector('span')?.remove();
    turnBtn.appendChild(h('span', null, p.turning ? 'Stop turntable' : 'Turntable'));
    turnBtn.classList.toggle('primary', p.turning);
  };
  const orbit = button('Orbit selection', () => p.orbitSelection(), {
    icon: 'follow',
    cls: 'small',
    title: 'Fly to the selection (or the scene) and turn around it',
  });
  const speed = sliderField({
    min: 1,
    max: 90,
    step: 1,
    value: Math.abs(p.options.turntableSpeed),
    unit: '°/s',
    digits: 0,
    onChange: (v) => p.set({ turntableSpeed: p.options.turntableSpeed < 0 ? -v : v }),
  });
  const reverse = toggleField({
    value: p.options.turntableSpeed < 0,
    onChange: (v) =>
      p.set({ turntableSpeed: v ? -Math.abs(p.options.turntableSpeed) : Math.abs(p.options.turntableSpeed) }),
  });
  const cameraBody = h(
    'div',
    null,
    cams,
    h('div', { class: 'qol-grid two', style: { marginTop: '8px' } }, orbit, turnBtn),
    row('Speed', speed.el),
    row('Reverse', reverse.el),
    row(
      'Turn on entering',
      toggleField({ value: p.options.turntableOnEnter, onChange: (v) => p.set({ turntableOnEnter: v }) }).el,
      'Start the turntable when presentation mode starts and stop it when it ends',
    ),
  );

  // ── Lens ──
  const fov = sliderField({
    min: 10,
    max: 90,
    step: 1,
    value: p.options.fov,
    unit: '°',
    digits: 0,
    onChange: (v) => p.set({ fov: v }),
  });
  const lens = h(
    'div',
    { class: 'qol-grid two' },
    LENS_PRESETS.map((l) => {
      const b = button(l.label, () => p.setLens(l.mm), {
        cls: 'small',
        title: `${l.mm} mm lens: ${fovForMm(l.mm).toFixed(1)}° field of view`,
      });
      b.dataset.lens = l.id;
      return b;
    }),
  );
  const dofSelect = selectField<string>({
    options: DOF_PRESETS.map((d) => ({ value: d.id, label: d.label })),
    value: matchDofPreset(app.prefs.value.graphics.dof) ?? 'tier',
    onChange: (v) => p.setDof(v as (typeof DOF_PRESETS)[number]['id']),
  });
  dofSelect.el.querySelector('select')?.setAttribute('data-qol', 'dof-select');
  const dofHint = h('p', { class: 'hint-text', style: { margin: '6px 0 0' } });
  const lensBody = h(
    'div',
    null,
    lens,
    row('Field of view', fov.el, 'Vertical field of view of the camera'),
    row('Depth of field', dofSelect.el, 'Blur away from the point the camera looks at (the real depth-of-field pass)'),
    dofHint,
  );
  const syncDof = () => {
    const id = matchDofPreset(app.prefs.value.graphics.dof);
    if (id) dofSelect.set(id);
    else dofSelect.set('tier', true);
    dofHint.textContent =
      (DOF_PRESETS.find((d) => d.id === id)?.blurb ?? 'Custom settings from the Graphics section') +
      '. Focus follows the point the camera orbits.';
  };
  app.prefs.on('change', (keys) => {
    if (keys.includes('graphics')) syncDof();
  });

  // ── Lighting ── (the scene's environment presets: sky, sun and image-based light)
  const light = selectField<string>({
    options: ENV_PRESETS.map((l) => ({ value: l.id, label: l.label })),
    value: app.store.settings.environment.sky,
    onChange: (v) => p.setEnvironment(v),
  });
  light.el.querySelector('select')?.setAttribute('data-qol', 'light-select');
  const lightHint = h('p', { class: 'hint-text', style: { margin: '6px 0 0' } });
  const lightBody = h('div', null, row('Environment', light.el), lightHint);
  const syncLight = () => {
    const sky = app.store.settings.environment.sky;
    if (ENV_PRESET_BY_ID.has(sky)) light.set(sky);
    else light.set('studio', true);
    lightHint.textContent =
      'Part of the scene, saved with it (Undo works). Sun, fog, tone mapping and more: World tab.';
  };
  app.store.on('change', (c) => {
    if (c.type === 'settings') syncLight();
  });

  // ── Caption ──
  const title = h('input', { type: 'text', placeholder: 'Title', maxLength: 140, 'aria-label': 'Caption title' });
  const sub = h('input', { type: 'text', placeholder: 'Subtitle', maxLength: 240, 'aria-label': 'Caption subtitle' });
  title.value = p.options.title;
  sub.value = p.options.subtitle;
  for (const [input, key] of [[title, 'title'] as const, [sub, 'subtitle'] as const]) {
    input.addEventListener('input', () => p.set({ [key]: input.value }));
    input.addEventListener('keydown', (e) => e.stopPropagation());
  }
  const pos = selectField<CaptionPos>({
    options: CAPTION_POSITIONS.map((c) => ({ value: c.id, label: c.label })),
    value: p.options.captionPos,
    onChange: (v) => p.set({ captionPos: v }),
  });
  const size = sliderField({
    min: 14,
    max: 120,
    step: 1,
    value: p.options.captionSize,
    unit: 'px',
    digits: 0,
    onChange: (v) => p.set({ captionSize: v }),
  });
  const hold = sliderField({
    min: 0,
    max: 60,
    step: 1,
    value: p.options.captionHold,
    unit: 's',
    digits: 0,
    onChange: (v) => p.set({ captionHold: v }),
  });
  const captionBody = h(
    'div',
    null,
    row('Show caption', toggleField({ value: p.options.captionOn, onChange: (v) => p.set({ captionOn: v }) }).el),
    h('div', { class: 'qol-inputs' }, title, sub),
    row('Position', pos.el),
    row('Size', size.el),
    row('Visible for', hold.el, '0 s keeps it on screen; otherwise it fades in, stays that long, then fades out'),
    row(
      'In captures',
      toggleField({ value: p.options.captionInCapture, onChange: (v) => p.set({ captionInCapture: v }) }).el,
      'Draw the caption into saved images',
    ),
  );

  // ── Capture ──
  const scale = segmented<'1' | '2' | '4'>({
    options: [
      { value: '1', label: '1×' },
      { value: '2', label: '2×' },
      { value: '4', label: '4×' },
    ],
    value: String(p.options.captureScale) as '1' | '2' | '4',
    onChange: (v) => {
      p.set({ captureScale: Number(v) as CaptureScale });
      updateInfo();
    },
  });
  const best = toggleField({
    value: p.options.captureBest,
    onChange: (v) => p.set({ captureBest: v }),
    title: 'Render the capture with ambient occlusion and large shadow maps even if the editor runs at a lower tier',
  });
  const updateInfo = () => {
    const vp = app.viewport;
    const { width, height } = vp.cssSize;
    const e = effectiveScale(width, height, p.options.captureScale, vp.maxCaptureEdge);
    info.textContent = `${e.width} × ${e.height} px${e.reduced ? ` (reduced from ${p.options.captureScale}× to fit your GPU)` : ''}${
      p.lastCapture
        ? ` · last: ${p.lastCapture.width} × ${p.lastCapture.height}, ${(p.lastCapture.blob.size / 1024).toFixed(0)} kB`
        : ''
    }`;
  };
  const shoot = button(
    'Save PNG',
    () => void p.captureAndDownload().catch((e: Error) => app.toast(e.message, 'error')),
    {
      icon: 'camera',
      cls: 'primary wide',
      title: 'Save the viewport as a PNG without the interface',
    },
  );
  shoot.dataset.qol = 'capture';
  const captureBody = h(
    'div',
    null,
    row('Resolution', scale.el, 'Multiples of the viewport size'),
    row('Best quality', best.el),
    shoot,
    info,
  );

  const syncAll = () => {
    syncTurn();
    syncDof();
    syncLight();
    updateInfo();
  };
  p.onChange(syncAll);
  window.addEventListener('resize', updateInfo);

  el.append(
    section('Presentation mode', modeBody, { id: 'qol-present-mode' }),
    section('Camera', cameraBody, { id: 'qol-present-camera' }),
    section('Lens and focus', lensBody, { id: 'qol-present-lens' }),
    section('Lighting', lightBody, { id: 'qol-present-light' }),
    section('Caption', captionBody, { id: 'qol-present-caption' }),
    section('Capture', captureBody, { id: 'qol-present-capture' }),
  );
  syncAll();
  return { el, onShow: syncAll };
}

export const presentPanel: PanelDef = {
  id: 'present',
  label: 'Present',
  icon: 'camera',
  region: 'right',
  order: 95,
  title: 'Presentation and photo mode: hide the interface, camera and light presets, captions, hi-res capture',
  build: (app) => buildPresentPanel(app),
};
