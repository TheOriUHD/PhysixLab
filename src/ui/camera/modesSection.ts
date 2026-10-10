/** Camera panel: the mode switcher, the subject, and the settings of the running mode. */
import type { App } from '../../app/app';
import { cameraModes } from '../../app/camera/modes';
import type { ForwardAxis } from '../../app/camera/settings';
import { button, row, section, selectField, sliderField, toggleField } from '../controls';
import { h } from '../dom';
import { icon } from '../icons';
import { registerCameraSection } from './sections';

registerCameraSection({
  id: 'modes',
  order: 10,
  build(app: App) {
    const rig = app.cameraRig;
    const grid = h('div', { class: 'cam-modes', role: 'radiogroup', 'aria-label': 'Camera mode' });
    const blurb = h('p', { class: 'hint-text' });
    const subject = h('div', { class: 'cam-subject' });
    const settings = h('div', { class: 'cam-mode-settings' });

    const renderModes = () => {
      grid.replaceChildren(
        ...cameraModes.list().map((m) => {
          const b = h(
            'button',
            {
              class: `cam-mode${rig.mode === m.id ? ' on' : ''}`,
              type: 'button',
              role: 'radio',
              'aria-checked': rig.mode === m.id ? 'true' : 'false',
              title: m.blurb,
              dataset: { mode: m.id },
            },
            icon(m.icon),
            h('span', null, m.label),
          );
          b.addEventListener('click', () => rig.setMode(m.id));
          return b;
        }),
      );
      blurb.textContent = cameraModes.get(rig.mode)?.blurb ?? '';
    };

    const renderSubject = () => {
      const id = rig.subjectId();
      const name = id ? (app.store.body(id)?.name ?? 'body') : null;
      const pin = button(
        rig.pinned ? 'Unpin' : 'Pin selection',
        () => (app.cameraRig.pinned ? rig.pin(null) : runPin()),
        {
          cls: 'small',
          title: 'Keep following this body when the selection changes',
          icon: 'lock',
        },
      );
      const runPin = () => {
        const sel = app.store.selection.find((s) => app.store.body(s));
        if (sel) rig.pin(sel);
        else app.toast('Select a body to pin as the camera subject', 'warn');
      };
      subject.replaceChildren(
        h(
          'span',
          { class: 'cam-subject-name' },
          name ? `Subject: ${name}${rig.pinned ? ' (pinned)' : ''}` : 'Subject: none — select a body',
        ),
        pin,
      );
    };

    const renderSettings = () => {
      const s = rig.settings;
      const rows: HTMLElement[] = [];
      const slider = (
        label: string,
        key: 'flySpeed' | 'tpDistance' | 'tpHeight' | 'chaseDistance' | 'chaseHeight',
        min: number,
        max: number,
        unit: string,
        hint?: string,
      ) => {
        const f = sliderField({
          min,
          max,
          log: key === 'flySpeed',
          step: key === 'flySpeed' ? undefined : 0.1,
          unit,
          digits: 1,
          value: s[key],
          onChange: (v) => rig.update_settings({ [key]: v }),
        });
        rows.push(row(label, f.el, hint));
      };
      if (rig.mode === 'fly') slider('Speed', 'flySpeed', 0.5, 200, 'm/s', 'Mouse wheel changes it while flying');
      if (rig.mode === 'tp') {
        slider('Distance', 'tpDistance', 1, 60, 'm');
        slider('Height', 'tpHeight', 0, 30, 'm');
      }
      if (rig.mode === 'chase') {
        slider('Distance', 'chaseDistance', 1, 80, 'm');
        slider('Height', 'chaseHeight', 0, 40, 'm');
      }
      if (rig.mode === 'fp' || rig.mode === 'tp' || rig.mode === 'chase') {
        const fwd = selectField<ForwardAxis>({
          options: [
            { value: '+x', label: '+X (default)' },
            { value: '-x', label: '−X' },
            { value: '+z', label: '+Z' },
            { value: '-z', label: '−Z' },
          ],
          value: s.forwardAxis,
          onChange: (v) => rig.update_settings({ forwardAxis: v }),
        });
        rows.push(row('Body forward', fwd.el, 'Which local axis of the body counts as “forward”'));
      }
      settings.replaceChildren(...rows);
    };

    const refresh = () => {
      renderModes();
      renderSubject();
      renderSettings();
    };
    rig.on('change', refresh);
    app.store.on('selection', renderSubject);
    refresh();
    return { el: section('Mode', [grid, blurb, subject, settings], { id: 'cam-modes' }), refresh };
  },
});

// Reduced motion & shake live in the Lens section below.
void toggleField;
