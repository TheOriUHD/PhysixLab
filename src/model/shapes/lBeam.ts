/** L-beam (angle section): a vertical and a horizontal leg — shelf brackets, retaining walls, gutters. */
import { makeBeam } from './beamSection';
import { SHAPE_ICONS } from './shapeIcons';

export const lBeam = makeBeam({
  id: 'l-beam',
  label: 'L-beam',
  icon: SHAPE_ICONS['l-beam'],
  blurb: 'Angle section with two legs: brackets, corners, retaining walls',
  defaultSize: [2, 0.5, 0.5],
  flange: { default: 0.16, max: 0.6 },
  web: { default: 0.16, max: 0.6 },
  flangeLabel: 'Base leg',
  webLabel: 'Upright leg',
  // the upright leg stands on the left (−z) end of the base leg
  rects: (W, H, tf, tw) => [
    { cz: 0, cy: -H / 2 + tf / 2, hz: W / 2, hy: tf / 2 },
    { cz: -W / 2 + tw / 2, cy: tf / 2, hz: tw / 2, hy: (H - tf) / 2 },
  ],
  outline: (W, H, tf, tw) => [
    [-W / 2, -H / 2],
    [W / 2, -H / 2],
    [W / 2, -H / 2 + tf],
    [-W / 2 + tw, -H / 2 + tf],
    [-W / 2 + tw, H / 2],
    [-W / 2, H / 2],
  ],
});
