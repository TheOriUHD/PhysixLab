/** JT-32: aerodynamic helpers behind the drag fields (F = ½·ρ·Cd·A·v², i.e. the quadratic coefficient c = ½·ρ·Cd·A). */

/** Quadratic drag coefficient c (N·s²/m²) from air density ρ (kg/m³), drag coefficient Cd and frontal area A (m²). */
export function quadraticDragCoefficient(rho: number, cd: number, area: number): number {
  return 0.5 * rho * cd * area;
}

/** Terminal speed of a falling body: √(2·m·g / (ρ·Cd·A)) = √(m·g / c). 0 coefficient = no terminal speed (Infinity). */
export function terminalSpeed(mass: number, gravity: number, c: number): number {
  return c > 0 ? Math.sqrt((mass * gravity) / c) : Infinity;
}

/** Cross-section area (m²) of a shape's bounding box seen along `axis` ('x' | 'y' | 'z') — a rough default for A. */
export function frontalArea(size: readonly [number, number, number], axis: 'x' | 'y' | 'z' = 'y'): number {
  const [x, y, z] = size;
  return axis === 'x' ? y * z : axis === 'y' ? x * z : x * y;
}
