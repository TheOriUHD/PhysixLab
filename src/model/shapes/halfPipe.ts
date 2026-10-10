/**
 * Half-pipe: a block with a U-shaped channel along its length — skate parks, gutters, chutes, bowls for balls.
 * Size: x = width, y = height, z = length. The channel is two concave quarter arcs (stretched to the box) with an
 * optional flat bottom, a floor under the lowest point and flat decks on both sides. Built from convex pieces
 * (`profileSolid.ts`), so it works dynamic or static.
 */
import type { ShapeDef } from '../shapeRegistry';
import { profileShape, SEGMENTS_PARAM } from './curvedRamp';
import { pipeTop } from './profileSolid';
import { SHAPE_ICONS } from './shapeIcons';

export const halfPipe: ShapeDef = profileShape({
  id: 'half-pipe',
  label: 'Half-pipe',
  icon: SHAPE_ICONS['half-pipe'],
  blurb: 'U-shaped channel: skate half-pipe, gutter, chute, bowl for rolling things',
  keywords: ['skate', 'gutter', 'trough', 'channel', 'chute', 'valley', 'u'],
  defaultSize: [4, 1.5, 3],
  params: [
    {
      key: 'floor',
      label: 'Floor',
      kind: 'float',
      min: 0.02,
      max: 0.6,
      step: 0.01,
      default: 0.1,
      hint: 'Thickness under the lowest point, as a fraction of the height',
    },
    {
      key: 'flat',
      label: 'Flat bottom',
      kind: 'float',
      min: 0,
      max: 0.8,
      step: 0.01,
      default: 0.25,
      hint: 'Width of the flat part of the channel, as a fraction of the channel',
    },
    {
      key: 'deck',
      label: 'Deck',
      kind: 'float',
      min: 0,
      max: 0.4,
      step: 0.01,
      default: 0.1,
      hint: 'Flat platform on each side, as a fraction of the width',
    },
    SEGMENTS_PARAM(10),
  ],
  axis: 'x',
  top: (p) => pipeTop(Number(p.floor), Number(p.deck), Number(p.flat), Number(p.segments)),
});
