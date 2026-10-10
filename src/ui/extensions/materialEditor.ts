/** VZ-A: registers the material editor as the inspector section for body selections (src/ui/inspector/materialEditor.ts). */
import { registerInspectorSection } from '../../app/registry/inspectorSections';
import { isBody } from '../../model/types';
import { materialSection } from '../inspector/materialEditor';

registerInspectorSection({
  id: 'material',
  order: 110,
  appliesTo: (sel) => sel.every(isBody),
  build: (ctx, sel) => materialSection(ctx, sel.filter(isBody)),
});
