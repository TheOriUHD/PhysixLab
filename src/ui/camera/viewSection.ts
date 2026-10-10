/** Camera panel: projection, orthographic views, lens, near / far, shake, motion. */
import type { App } from '../../app/app';
import type { ViewPreset } from '../../app/camera/rig';
import type { MotionPref } from '../../app/camera/settings';
import { button, row, section, segmented, selectField, sliderField, toggleField } from '../controls';
import { h } from '../dom';
import { registerCameraSection } from './sections';

const PRESETS: [ViewPreset, string][] = [
  ['front', 'Front'],
  ['back', 'Back'],
  ['left', 'Left'],
  ['right', 'Right'],
  ['top', 'Top'],
  ['bottom', 'Bottom'],
  ['iso', 'Iso'],
];

registerCameraSection({
  id: 'view',
  order: 20,
  build(app: App) {
    const rig = app.cameraRig;
    const proj = segmented<'persp' | 'ortho'>({
      options: [
        { value: 'persp', label: 'Perspective' },
        { value: 'ortho', label: 'Orthographic' },
      ],
      value: rig.ortho ? 'ortho' : 'persp',
      onChange: (v) => rig.setOrtho(v === 'ortho'),
    });
    const presets = h('div', { class: 'cam-presets' });
    for (const [id, label] of PRESETS) {
      const b = button(label, () => rig.viewPreset(id), {
        cls: 'small',
        title: `${label} view (switches to orthographic)`,
      });
      b.dataset.preset = id;
      presets.appendChild(b);
    }
    const size = sliderField({
      min: 0.5,
      max: 500,
      log: true,
      unit: 'm',
      digits: 1,
      value: app.camera.orthoSize,
      onChange: (v) => rig.setOrthoSize(v),
    });
    const sizeRow = row('Ortho scale', size.el, 'Height of the view in metres (the mouse wheel zooms too)');
    const fov = sliderField({
      min: 10,
      max: 110,
      step: 1,
      unit: '°',
      digits: 0,
      value: rig.settings.fov,
      onChange: (v) => rig.setFov(v),
    });
    const fovRow = row('Field of view', fov.el, 'Vertical field of view of the perspective lens');
    const auto = toggleField({
      label: 'Automatic near / far planes',
      value: rig.settings.autoNearFar,
      onChange: (v) => rig.update_settings({ autoNearFar: v }),
    });
    const shake = sliderField({
      min: 0,
      max: 2,
      step: 0.05,
      digits: 2,
      value: rig.settings.shake,
      onChange: (v) => rig.update_settings({ shake: v }),
    });
    const motion = selectField<MotionPref>({
      options: [
        { value: 'auto', label: 'Follow the system' },
        { value: 'reduce', label: 'Reduce motion' },
        { value: 'full', label: 'Full motion' },
      ],
      value: rig.settings.motion,
      onChange: (v) => rig.update_settings({ motion: v }),
    });
    const hint = h('p', { class: 'hint-text' });
    const actions = h(
      'div',
      { class: 'cam-actions' },
      button('Frame all', () => app.frameAll(), { cls: 'small', icon: 'frame' }),
      button('Frame selection', () => app.frameSelection(), { cls: 'small', icon: 'frame' }),
    );
    const refresh = () => {
      proj.set(rig.ortho ? 'ortho' : 'persp');
      for (const b of presets.querySelectorAll<HTMLElement>('button'))
        b.classList.toggle('on', rig.ortho && rig.preset === b.dataset.preset);
      sizeRow.style.display = rig.ortho ? '' : 'none';
      fovRow.style.display = rig.ortho ? 'none' : '';
      size.set(app.camera.orthoSize / Math.max(1e-6, app.camera.zoom));
      fov.set(rig.settings.fov);
      auto.set(rig.settings.autoNearFar);
      shake.set(rig.settings.shake);
      motion.set(rig.settings.motion);
      hint.textContent = rig.ortho
        ? 'Orthographic: parallel projection, no perspective shrink. Front / side views draw a grid in the view plane.'
        : '';
    };
    rig.on('change', refresh);
    refresh();
    return {
      el: section(
        'View & lens',
        [
          row('Projection', proj.el),
          presets,
          sizeRow,
          fovRow,
          auto.el,
          row('Camera shake', shake.el, 'Impacts and blasts shake the view; 0 turns it off'),
          row('Motion', motion.el, 'Reduced motion removes shake and cuts transitions instead of gliding'),
          hint,
          actions,
        ],
        { id: 'cam-view' },
      ),
      refresh,
    };
  },
});
