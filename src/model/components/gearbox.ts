/**
 * Gearbox — N forward ratios, reverse and neutral between two shafts of the drive train. The output turns at the input
 * speed ÷ ratio and carries ratio × the input torque. Shift with keys (up / down / neutral / reverse) or let it shift
 * itself by engine speed. Runtime: `src/physics/components/gearbox.ts`.
 */
import type { ComponentDef } from '../componentRegistry';
import { keyField, shaftField } from './powerHelpers';

/** The gear ratios of a ratio list as typed ("3.6, 2.2 1.4"): positive numbers, at most `MAX_GEARS`. */
export const MAX_GEARS = 10;
export function parseRatios(text: string): number[] {
  const out: number[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    if (!part) continue;
    const v = Number(part);
    if (Number.isFinite(v) && v > 0) out.push(Math.min(40, Math.max(0.05, v)));
    if (out.length >= MAX_GEARS) break;
  }
  return out;
}

export const gearbox: ComponentDef = {
  type: 'gearbox',
  label: 'Gearbox',
  icon: 'gearbox',
  category: 'Drivetrain',
  blurb: 'N forward ratios, reverse and neutral: output torque = ratio × input, output speed = input ÷ ratio.',
  appliesTo: 'body',
  fields: [
    shaftField('in', 'Input shaft', 'clutch', 'The engine / clutch side'),
    shaftField('out', 'Output shaft', 'driveshaft', 'The differential / wheel side'),
    {
      kind: 'text',
      key: 'ratios',
      label: 'Gear ratios',
      default: '3.6, 2.2, 1.5, 1.1, 0.85',
      maxLength: 80,
      placeholder: '3.6, 2.2, 1.5, 1.0',
      hint: 'Forward gears 1, 2, 3 … separated by commas: input turns per output turn',
    },
    { kind: 'number', key: 'reverse', label: 'Reverse ratio', default: 3.2, min: 0.05, max: 40, step: 0.1 },
    {
      kind: 'number',
      key: 'gear',
      label: 'Starting gear',
      default: 1,
      min: -1,
      max: 10,
      step: 1,
      hint: '−1 = reverse, 0 = neutral, 1 … = forward',
    },
    {
      kind: 'enum',
      key: 'mode',
      label: 'Shifting',
      default: 'manual',
      options: [
        { value: 'manual', label: 'Manual (keys)' },
        { value: 'auto', label: 'Automatic' },
      ],
    },
    keyField('upKey', 'Shift up key', 'KeyE'),
    keyField('downKey', 'Shift down key', 'KeyQ'),
    keyField('neutralKey', 'Neutral key', '', 'Jumps to neutral'),
    keyField('reverseKey', 'Reverse key', '', 'Jumps to reverse'),
    {
      kind: 'number',
      key: 'shiftTime',
      label: 'Shift time',
      default: 0.15,
      min: 0,
      max: 3,
      step: 0.05,
      unit: 's',
      hint: 'Drive is interrupted while the gears change',
    },
    {
      kind: 'number',
      key: 'upRpm',
      label: 'Auto upshift at',
      default: 5800,
      min: 100,
      max: 20000,
      step: 100,
      unit: 'rpm',
    },
    {
      kind: 'number',
      key: 'downRpm',
      label: 'Auto downshift at',
      default: 2400,
      min: 0,
      max: 20000,
      step: 100,
      unit: 'rpm',
    },
    {
      kind: 'number',
      key: 'efficiency',
      label: 'Efficiency',
      default: 0.97,
      min: 0.5,
      max: 1,
      step: 0.01,
      hint: 'Share of the torque that gets through',
    },
    {
      kind: 'number',
      key: 'inertia',
      label: 'Inertia',
      default: 0.02,
      min: 0.0001,
      max: 100,
      step: 0.005,
      unit: 'kg·m²',
      hint: 'Rotating mass of the gears, on the input shaft',
    },
  ],
  state: [
    { label: 'Gear', digits: 0 },
    { label: 'Ratio', digits: 2 },
    { label: 'Input', unit: 'rpm', digits: 0 },
    { label: 'Output', unit: 'rpm', digits: 0 },
    { label: 'Output torque', unit: 'N·m', digits: 0 },
  ],
  sanitise(p) {
    // normalise the ratio list ("3,6" typos, commas, stray words) and keep the start gear inside it
    const list = parseRatios(String(p.ratios));
    const ratios = (list.length ? list : [3.6, 2.2, 1.5, 1.1, 0.85])
      .map((r) => String(Math.round(r * 1000) / 1000))
      .join(', ');
    const n = list.length || 5;
    return { ...p, ratios, gear: Math.min(Math.max(Math.round(p.gear as number), -1), n) };
  },
  check: (owner, p) => {
    if (owner.kind !== 'body') return null;
    if (p.in === p.out) return 'Input and output are the same shaft, so the gearbox does nothing.';
    return parseRatios(String(p.ratios)).length === 0
      ? 'No valid gear ratio. Type numbers such as 3.6, 2.2, 1.5.'
      : null;
  },
};
