/** The runtimes of the powered parts (package CP); definitions: `src/model/components/poweredIndex.ts`. */
import { brake } from './brake';
import { clutch } from './clutch';
import { differential } from './differential';
import { driveShaft } from './driveShaft';
import { engine } from './engine';
import { gearbox } from './gearbox';
import { hydraulicCylinder } from './hydraulicCylinder';
import { linearActuator } from './linearActuator';
import { motor } from './motor';
import type { ComponentRuntime } from './registry';
import { servo } from './servo';
import { stepper } from './stepper';

export const POWERED_RUNTIMES: readonly ComponentRuntime<unknown>[] = [
  engine,
  motor,
  servo,
  stepper,
  linearActuator,
  hydraulicCylinder,
  clutch,
  gearbox,
  differential,
  driveShaft,
  brake,
];
