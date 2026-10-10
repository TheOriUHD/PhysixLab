// -- UI-A: inspector calculators (UI-11) and the live Readout panel (UI-12). The other inspector upgrades (UI-10: units,
// expressions, scrubbing, resets, filter, copy / paste, presets) are applied by src/ui/inspector/upgrades/enhance.ts. --
import { registerInspectorSection, registerPanel } from '../../app/registry';
import { buildCalculators, calculatorsApply } from '../inspector/upgrades/calcUi';
import { readoutPanel } from '../readout';

registerInspectorSection({
  id: 'calculators',
  // after the kind's own panel (100) and "Organise" (200), before "Components" (300)
  order: 250,
  appliesTo: (sel) => calculatorsApply(sel),
  build: buildCalculators,
});

registerPanel(readoutPanel);
