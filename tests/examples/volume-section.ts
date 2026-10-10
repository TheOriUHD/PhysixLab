// File: src/ui/extensions/volume-section.ts
import { registerInspectorSection } from '../../src/app/registry';
import { shapeVolume } from '../../src/model/shapeRegistry';
import { isBody } from '../../src/model/types';
import { row, section } from '../../src/ui/controls';
import { h } from '../../src/ui/dom';

registerInspectorSection({
  id: 'volume',
  order: 150, // after the body panel (100), before "Organise" (200)
  appliesTo: (selection) => selection.length === 1 && isBody(selection[0]),
  build: (ctx, selection) => {
    const first = selection[0];
    if (!isBody(first)) return [];
    const readout = h('span', { class: 'readout' });
    // Updaters run on every document change, so the value follows edits made elsewhere (undo, the gizmo …).
    ctx.updaters.push(() => {
      const body = ctx.app.store.body(first.id);
      if (body) readout.textContent = `${shapeVolume(body.shape).toFixed(3)} m³`;
    });
    return [section('Volume', [row('Shape volume', readout)], { id: 'volume' })];
  },
});
