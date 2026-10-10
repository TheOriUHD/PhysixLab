/**
 * Soft-body cost and stability advice (SF-8, SF-9): particle counts per recipe, a budget readout, an adaptive
 * resolution suggestion, and the stability warnings the inspector shows with one-click fixes. Pure functions of the
 * document; the numbers were calibrated against the engine (see tests/softBudget.test.ts).
 */
import { softDensity, softSpacing, softYoungModulus } from './softMaterial';
import type { SoftEntity } from './types';

/** Particles the engine handles comfortably / at a stretch on a typical machine (≈ 120 Hz physics). */
export const SOFT_BUDGET = { comfortable: 1200, heavy: 3000 } as const;

/** Particle count of a recipe: exact for the generated lattices, an estimate (volume / cell³) for volumetric meshes. */
export function softParticleCount(
  def: Pick<SoftEntity, 'type' | 'size' | 'resolution' | 'cell' | 'pneumatic'>,
): number {
  const n = def.resolution;
  switch (def.type) {
    case 'jelly':
      return n ** 3;
    case 'cloth':
      return n * n;
    case 'cable':
      return n;
    case 'balloon':
      return 10 * 4 ** n + 2;
    case 'tyre': {
      if (def.pneumatic) return Math.max(8, n) * 10;
      // Airless: a voxel lattice of the torus, cell tied to the tube radius (not to the resolution).
      const radial = def.size[2] / 2,
        axial = def.size[1] / 2;
      const cell = Math.max(0.03, Math.min(radial, axial) * 0.9);
      const major = Math.max(radial + 0.02, def.size[0] / 2 - radial);
      return Math.round((5.4 * 2 * Math.PI ** 2 * major * radial * axial) / cell ** 3);
    }
    case 'mesh': {
      // The lattice voxelises the shape one cell beyond its surface on each side (a bounding-box estimate).
      const nx = (def.size[0] + def.cell) / def.cell + 1,
        ny = (def.size[1] + def.cell) / def.cell + 1,
        nz = (def.size[2] + def.cell) / def.cell + 1;
      return Math.round(0.8 * nx * ny * nz);
    }
  }
}

export type BudgetTier = 'light' | 'ok' | 'heavy' | 'excessive';

export interface SoftBudgetReadout {
  particles: number;
  tier: BudgetTier;
  /** Fraction of the comfortable budget in use (can exceed 1). */
  load: number;
  /** One-line advice, empty when everything is fine. */
  advice: string;
}

/** Budget readout for a scene: `live` particles reported by the engine win over the document estimate. */
export function softBudget(defs: readonly SoftEntity[], live?: number): SoftBudgetReadout {
  const particles = live && live > 0 ? live : defs.reduce((a, d) => a + softParticleCount(d), 0);
  const load = particles / SOFT_BUDGET.comfortable;
  const tier: BudgetTier =
    particles <= SOFT_BUDGET.comfortable * 0.5
      ? 'light'
      : particles <= SOFT_BUDGET.comfortable
        ? 'ok'
        : particles <= SOFT_BUDGET.heavy
          ? 'heavy'
          : 'excessive';
  const advice =
    tier === 'excessive'
      ? 'Far over budget — expect the simulation to slow down. Lower the resolution or use economy mode.'
      : tier === 'heavy'
        ? 'Over the comfortable budget — lower the resolution of the largest body, or turn on economy mode.'
        : '';
  return { particles, tier, load, advice };
}

/** Resolution-related patch that brings one body to about `target` particles, or null when it cannot get there. */
export function suggestResolution(def: SoftEntity, target: number): Partial<SoftEntity> | null {
  const cur = softParticleCount(def);
  if (cur <= target) return null;
  const min = { jelly: 3, balloon: 1, cloth: 6, cable: 6, tyre: 12, mesh: 3 }[def.type];
  switch (def.type) {
    case 'jelly':
    case 'cloth':
    case 'cable':
    case 'tyre':
    case 'balloon': {
      for (let r = def.resolution - 1; r >= min; r--) {
        if (softParticleCount({ ...def, resolution: r }) <= target || r === min)
          return r < def.resolution ? { resolution: r } : null;
      }
      return null;
    }
    case 'mesh': {
      let cell = def.cell;
      while (cell < 1 && softParticleCount({ ...def, cell }) > target)
        cell = Math.round((cell * 1.15 + 0.005) * 1000) / 1000;
      return cell > def.cell ? { cell: Math.min(1, cell) } : null;
    }
  }
}

export interface SoftWarning {
  id: 'too-soft' | 'too-coarse' | 'too-heavy-load' | 'tyre-soft' | 'budget';
  message: string;
  /** One-click fix: a label for the button and the patch it applies. */
  fix?: { label: string; patch: Partial<SoftEntity> };
}

export interface SoftWarnContext {
  /** Gravity magnitude, m/s². */
  gravity: number;
  /** Total mass (kg) of rigid bodies fastened to this soft body. */
  attachedMass: number;
}

/** Stability warnings for one soft body, each with a fix that resolves it. */
export function softWarnings(def: SoftEntity, ctx: SoftWarnContext): SoftWarning[] {
  const out: SoftWarning[] = [];
  const h = softSpacing(def);
  const E = softYoungModulus(def);
  const rho = softDensity(def);
  const length = Math.max(...def.size);

  // Too soft: self-weight strain of a hanging column ε = ρ·g·L / (2E) (or a bare fall onto the ground).
  const strain = (rho * ctx.gravity * length) / (2 * Math.max(1, E));
  if (def.type !== 'balloon' && def.type !== 'tyre' && strain > 0.25) {
    // Stiffness frequency that brings the strain back to 0.1: f ∝ sqrt(1/ε)
    const f = Math.min(400, Math.ceil(def.stiffness * Math.sqrt(strain / 0.1)));
    out.push({
      id: 'too-soft',
      message: `Too soft: its own weight stretches it by about ${(strain * 100).toFixed(0)} %. It will sag and may fold through thin objects.`,
      fix: { label: `Stiffen to ${f} Hz`, patch: { stiffness: f } },
    });
  }

  // Too few particles: coarse lattices tunnel through thin obstacles and look faceted.
  if (def.type === 'cloth' || def.type === 'cable') {
    if (h > 0.22 && def.resolution < (def.type === 'cloth' ? 40 : 100)) {
      const span = def.type === 'cloth' ? Math.min(def.size[0], def.size[2]) : def.size[0];
      const r = Math.min(def.type === 'cloth' ? 40 : 100, Math.ceil(span / 0.12) + 1);
      out.push({
        id: 'too-coarse',
        message: `Too few particles: ${(h * 100).toFixed(0)} cm between particles. Folds will look jagged and thin objects can slip through.`,
        fix: { label: `Raise resolution to ${r}`, patch: { resolution: r } },
      });
    }
  } else if (def.type === 'jelly' || def.type === 'mesh') {
    if (h > 0.4 && Math.min(...def.size) > 0.6) {
      const patch: Partial<SoftEntity> =
        def.type === 'jelly'
          ? { resolution: Math.min(10, def.resolution + 2) }
          : { cell: Math.max(0.08, def.cell * 0.7) };
      out.push({
        id: 'too-coarse',
        message: `Too few particles: ${(h * 100).toFixed(0)} cm lattice spacing — the body will look blocky and deform unevenly.`,
        fix: { label: 'Refine the lattice', patch },
      });
    }
  }

  // Too heavy: bodies fastened to a body far lighter than they are stretch it badly.
  if (ctx.attachedMass > 0 && ctx.attachedMass / def.mass > 40) {
    const m = Math.ceil(ctx.attachedMass / 20);
    out.push({
      id: 'too-heavy-load',
      message: `The fastened bodies weigh ${(ctx.attachedMass / def.mass).toFixed(0)}× more than this soft body, which makes the solver stretch and jitter.`,
      fix: { label: `Raise its mass to ${m} kg`, patch: { mass: m } },
    });
  }

  // A tyre that cannot hold its shape under load.
  if (def.type === 'tyre' && def.pneumatic && (def.stiffness < 100 || def.volumeFactor < 1.15)) {
    out.push({
      id: 'tyre-soft',
      message: 'This pneumatic tyre is too soft or under-inflated to carry a vehicle: the sidewalls will fold flat.',
      fix: {
        label: 'Inflate to working pressure',
        patch: { stiffness: Math.max(def.stiffness, 150), volumeFactor: Math.max(def.volumeFactor, 1.3) },
      },
    });
  }
  return out;
}
