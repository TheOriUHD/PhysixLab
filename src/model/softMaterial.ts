/**
 * Young's-modulus-style readout for soft bodies (SF-7). The engine's soft material is a *natural frequency* f (Hz) of
 * the edge constraints, not a modulus. For a regular lattice of spacing h and particle mass m_p = ρ·h³, an edge acts
 * like a spring of stiffness k = ω²·(m_p/2) with ω = 2π·f (reduced mass of two particles), and a lattice of such
 * springs has the continuum modulus E = k / h. Hence
 *
 *     E ≈ ρ · (ω · h)² / 2          (Pa)
 *
 * with ρ the mean density and h the particle spacing. It is an honest *effective* modulus of the discretisation —
 * it depends on the resolution, because a coarser lattice at the same frequency is stiffer per metre — and is
 * documented as such in the inspector tooltip and in docs/LIMITATIONS.md.
 */
import type { SoftEntity } from './types';

/** Approximate particle spacing of a recipe, metres. */
export function softSpacing(def: Pick<SoftEntity, 'type' | 'size' | 'resolution' | 'cell'>): number {
  const n = Math.max(2, def.resolution);
  switch (def.type) {
    case 'jelly':
      return Math.min(...def.size.filter((x) => x > 0)) / (n - 1);
    case 'balloon':
      return (Math.PI * def.size[0]) / (2 * (n + 1) * 2); // ≈ arc length between neighbours of the subdivided sphere
    case 'cloth':
      return Math.min(def.size[0], def.size[2]) / (n - 1);
    case 'cable':
      return def.size[0] / (n - 1);
    case 'mesh':
      return def.cell;
    case 'tyre':
      return Math.max(0.02, (Math.PI * def.size[0]) / n);
  }
}

/** Mean density in kg/m³ (cloth and cable use their areal / linear equivalent through a nominal thickness). */
export function softDensity(def: Pick<SoftEntity, 'type' | 'size' | 'mass' | 'resolution' | 'cell'>): number {
  const h = softSpacing(def);
  switch (def.type) {
    case 'jelly':
    case 'mesh':
      return def.mass / Math.max(1e-6, def.size[0] * def.size[1] * def.size[2] * (def.type === 'mesh' ? 0.52 : 1));
    case 'balloon':
      return def.mass / Math.max(1e-6, (Math.PI / 6) * def.size[0] ** 3);
    case 'cloth':
      return def.mass / Math.max(1e-6, def.size[0] * def.size[2] * h); // one particle layer thick
    case 'cable':
      return def.mass / Math.max(1e-6, def.size[0] * h * h);
    case 'tyre':
      return def.mass / Math.max(1e-6, Math.PI * def.size[0] * def.size[1] * def.size[2] * 0.25);
  }
}

/** Effective Young's modulus (Pa) for the current stiffness frequency. */
export function softYoungModulus(def: SoftEntity): number {
  const w = 2 * Math.PI * def.stiffness;
  const h = softSpacing(def);
  return (softDensity(def) * (w * h) ** 2) / 2;
}

/** Stiffness frequency (Hz) that gives the target modulus; the inverse of `softYoungModulus`. */
export function stiffnessForYoungModulus(def: SoftEntity, pascal: number): number {
  const h = softSpacing(def);
  const rho = softDensity(def);
  if (h <= 0 || rho <= 0 || pascal <= 0) return def.stiffness;
  return Math.sqrt((2 * pascal) / rho) / (2 * Math.PI * h);
}

/** "12.3 kPa" style label. */
export function formatPascal(p: number): string {
  if (p >= 1e9) return `${(p / 1e9).toPrecision(3)} GPa`;
  if (p >= 1e6) return `${(p / 1e6).toPrecision(3)} MPa`;
  if (p >= 1e3) return `${(p / 1e3).toPrecision(3)} kPa`;
  return `${p.toPrecision(3)} Pa`;
}
