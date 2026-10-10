/** T-beam (T-section): a flange on top of a stem — bridge decks, shelves, signposts. */
import { makeBeam } from './beamSection';
import { SHAPE_ICONS } from './shapeIcons';

export const tBeam = makeBeam({
  id: 't-beam',
  label: 'T-beam',
  icon: SHAPE_ICONS['t-beam'],
  blurb: 'T-section with a flange over a stem: decks, shelves, posts',
  defaultSize: [2, 0.5, 0.5],
  flange: { default: 0.16, max: 0.45 },
  web: { default: 0.2, max: 0.7 },
  flangeLabel: 'Flange',
  webLabel: 'Stem',
  rects: (W, H, tf, tw) => [
    { cz: 0, cy: H / 2 - tf / 2, hz: W / 2, hy: tf / 2 },
    { cz: 0, cy: -tf / 2, hz: tw / 2, hy: (H - tf) / 2 },
  ],
  outline: (W, H, tf, tw) => [
    [-tw / 2, -H / 2],
    [tw / 2, -H / 2],
    [tw / 2, H / 2 - tf],
    [W / 2, H / 2 - tf],
    [W / 2, H / 2],
    [-W / 2, H / 2],
    [-W / 2, H / 2 - tf],
    [-tw / 2, H / 2 - tf],
  ],
});
