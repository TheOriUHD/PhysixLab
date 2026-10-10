/** The powered parts (package CP): engines, motors, actuators, drive train, thrusters, rotors. */
import type { ComponentDef } from '../componentRegistry';
import { brake } from './brake';
import { clutch } from './clutch';
import { differential } from './differential';
import { driveShaft } from './driveShaft';
import { engine } from './engine';
import { gearbox } from './gearbox';
import { hydraulicCylinder } from './hydraulicCylinder';
import { jet } from './jet';
import { linearActuator } from './linearActuator';
import { motor } from './motor';
import { propeller } from './propeller';
import { rotor } from './rotor';
import { servo } from './servo';
import { stepper } from './stepper';
import { thruster } from './thruster';

/** In Add-component menu order (categories appear in first-seen order). */
export const POWERED_COMPONENTS: readonly ComponentDef[] = [
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
  thruster,
  jet,
  propeller,
  rotor,
];
