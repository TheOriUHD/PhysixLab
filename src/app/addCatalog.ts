/**
 * What the Add tab and the "Add …" commands offer besides shapes (those come from the shape registry): soft
 * bodies, lights and the joint types, each with the icon and the one-line help both places show.
 */
import { JOINT_TYPE_LABELS, SOFT_LABELS } from '../model/factory';
import type { JointType, LightType, SoftType } from '../model/types';

export interface SoftItem {
  type: SoftType;
  label: string;
  icon: string;
  blurb: string;
}
export interface LightItem {
  type: LightType;
  label: string;
  icon: string;
  blurb: string;
}
export interface JointItem {
  type: JointType;
  label: string;
  icon: string;
  blurb: string;
}

export const SOFT_ITEMS: readonly SoftItem[] = [
  { type: 'jelly', label: SOFT_LABELS.jelly, icon: 'jelly', blurb: 'Squishy volumetric block' },
  { type: 'balloon', label: SOFT_LABELS.balloon, icon: 'balloon', blurb: 'Inflated elastic shell' },
  {
    type: 'cloth',
    label: SOFT_LABELS.cloth,
    icon: 'cloth',
    blurb: 'Drapes and tears. Pin an edge or corners to hang it',
  },
  {
    type: 'cable',
    label: SOFT_LABELS.cable,
    icon: 'cable',
    blurb: 'Flexible rope or cable. Pinned at both ends by default',
  },
];

// ── FB-6: scene objects that are not bodies ──
export const LIGHT_ITEMS: readonly LightItem[] = [
  { type: 'point', label: 'Point', icon: 'light', blurb: 'Shines in every direction' },
  { type: 'spot', label: 'Spot', icon: 'lightSpot', blurb: 'A cone of light — rotate it to aim' },
  { type: 'directional', label: 'Sun', icon: 'lightSun', blurb: 'Parallel rays, like sunlight' },
  { type: 'area', label: 'Area', icon: 'lightArea', blurb: 'A soft rectangular panel' },
];

export const JOINT_ITEMS: readonly JointItem[] = [
  { type: 'fixed', label: JOINT_TYPE_LABELS.fixed, icon: 'weld', blurb: 'Locks two bodies together rigidly' },
  {
    type: 'hinge',
    label: JOINT_TYPE_LABELS.hinge,
    icon: 'hinge',
    blurb: 'Rotation about one axis — doors, wheels, arms. Add limits and a motor.',
  },
  {
    type: 'slider',
    label: JOINT_TYPE_LABELS.slider,
    icon: 'slider',
    blurb: 'Translation along one axis — pistons, rails, suspension',
  },
  {
    type: 'ball',
    label: JOINT_TYPE_LABELS.ball,
    icon: 'ball',
    blurb: 'Free rotation about a point — chains, ragdolls',
  },
  { type: 'spring', label: JOINT_TYPE_LABELS.spring, icon: 'spring', blurb: 'Spring-damper between two points' },
  { type: 'rope', label: JOINT_TYPE_LABELS.rope, icon: 'rope', blurb: 'Maximum-distance constraint — ropes, tethers' },
  // -- JT-A: new joint types --
  {
    type: 'conetwist',
    label: JOINT_TYPE_LABELS.conetwist,
    icon: 'conetwist',
    blurb: 'Ball joint with a swing cone and twist limits — shoulders, hips, ragdolls',
  },
  {
    type: 'sixdof',
    label: JOINT_TYPE_LABELS.sixdof,
    icon: 'sixdof',
    blurb: 'Free, limited or locked on each of the six axes, with springs and motors',
  },
  {
    type: 'universal',
    label: JOINT_TYPE_LABELS.universal,
    icon: 'universal',
    blurb: 'Two crossed hinge axes, no twist — drive shafts, camera gimbals',
  },
  {
    type: 'softweld',
    label: JOINT_TYPE_LABELS.softweld,
    icon: 'softweld',
    blurb: 'A weld that flexes: linear and angular stiffness and damping',
  },
  {
    type: 'pulley',
    label: JOINT_TYPE_LABELS.pulley,
    icon: 'pulley',
    blurb: 'Rope over two fixed points with a ratio — Atwood machines, block and tackle',
  },
  {
    type: 'gear',
    label: JOINT_TYPE_LABELS.gear,
    icon: 'gear',
    blurb: 'Couples two rotating bodies by a ratio, reversing or not — gear trains',
  },
  {
    type: 'rack',
    label: JOINT_TYPE_LABELS.rack,
    icon: 'rack',
    blurb: 'Couples a pinion’s rotation to a rack’s sliding by the pitch radius',
  },
  {
    type: 'belt',
    label: JOINT_TYPE_LABELS.belt,
    icon: 'belt',
    blurb: 'Belt or chain drive between two pulleys, ratio from their radii, optional slip limit',
  },
  {
    type: 'screw',
    label: JOINT_TYPE_LABELS.screw,
    icon: 'screw',
    blurb: 'Rotation about an axis advances along it by the pitch — lead screws, jacks',
  },
  {
    type: 'winch',
    label: JOINT_TYPE_LABELS.winch,
    icon: 'winch',
    blurb: 'Motorised rope length with a load rating — cranes, hoists',
  },
];
