/**
 * Built-in layout presets (UI-1): Build, Simulate, Analyse, Present. They are written with panel ids; a preset
 * silently skips ids that are not registered and `layoutFromPreset` sends every panel it does not mention to its
 * home region, so presets keep working as packages add panels.
 */
import type { PresetSpec } from './layout';

export interface BuiltinPreset {
  id: string;
  label: string;
  description: string;
  spec: PresetSpec;
}

export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
  {
    id: 'build',
    label: 'Build',
    description: 'Library on the left, inspector and outliner on the right',
    spec: {
      regions: {
        left: [['add', 'prefabs', 'maps', 'scenes']],
        right: [['inspector', 'world'], ['outliner']],
        bottom: [['energy', 'selection']],
      },
      show: { left: true, right: true, bottom: false },
    },
  },
  {
    id: 'simulate',
    label: 'Simulate',
    description: 'Live readout and controls beside the viewport, energy below',
    spec: {
      regions: {
        left: [['scenes', 'add', 'prefabs', 'maps']],
        right: [
          ['readout', 'inspector'],
          ['outliner', 'world'],
        ],
        bottom: [['energy', 'selection', 'timeline']],
      },
      show: { left: false, right: true, bottom: true },
    },
  },
  {
    id: 'analyse',
    label: 'Analyse',
    description: 'A tall telemetry dock with the readout and inspector',
    spec: {
      regions: {
        left: [['scenes', 'add', 'prefabs', 'maps']],
        right: [['readout', 'inspector', 'outliner', 'world']],
        bottom: [['energy', 'selection', 'telemetry', 'timeline']],
      },
      show: { left: false, right: true, bottom: true },
      sizes: { bottom: 320 },
    },
  },
  {
    id: 'present',
    label: 'Present',
    description: 'Only the viewport and the world settings',
    spec: {
      regions: {
        left: [['scenes', 'add', 'prefabs', 'maps']],
        right: [['world', 'inspector', 'outliner']],
        bottom: [['energy', 'selection']],
      },
      show: { left: false, right: false, bottom: false },
    },
  },
];
