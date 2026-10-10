/** Gravity presets offered by the World tab and by the command palette ("Gravity: Moon"). */
export interface GravityPreset {
  id: string;
  label: string;
  /** Magnitude of the acceleration, m/s², pointing down (−Y). */
  g: number;
}

export const GRAVITY_PRESETS: readonly GravityPreset[] = [
  { id: 'earth', label: 'Earth — 9.81 m/s²', g: 9.81 },
  { id: 'moon', label: 'Moon — 1.62 m/s²', g: 1.62 },
  { id: 'mars', label: 'Mars — 3.71 m/s²', g: 3.71 },
  { id: 'jupiter', label: 'Jupiter — 24.79 m/s²', g: 24.79 },
  { id: 'zero', label: 'Zero gravity', g: 0 },
];
