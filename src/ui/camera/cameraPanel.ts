/** The Camera panel (right region): built from the camera-section registry. */
import type { PanelDef } from '../../app/registry/panels';
import { h } from '../dom';
import { cameraSections } from './sections';
import './modesSection';
import './viewSection';
import './bookmarksSection';

export const cameraPanel: PanelDef = {
  id: 'camera',
  label: 'Camera',
  icon: 'camera',
  region: 'right',
  order: 35,
  title: 'Camera modes, orthographic views, lens, bookmarks, cinematic shots, split screen and minimap',
  build: (app) => {
    const el = h('div', { class: 'panel-body cam-panel' });
    const refreshers: (() => void)[] = [];
    const render = () => {
      el.replaceChildren();
      refreshers.length = 0;
      for (const s of cameraSections.list()) {
        const built = s.build(app);
        el.appendChild(built.el);
        if (built.refresh) refreshers.push(built.refresh);
      }
    };
    cameraSections.onChange(render);
    render();
    return { el, onShow: () => refreshers.forEach((r) => r()) };
  },
};
