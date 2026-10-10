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
];
