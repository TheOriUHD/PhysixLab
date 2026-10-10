/**
 * The effects clock: how much time the particles should advance this frame.
 *
 * Effects live in simulation time, so they freeze when the simulation is paused, run in slow motion with the time
 * scale, and slow down with a simulation that cannot keep up. While there is no simulation (edit mode) they run in
 * real time, so a preview or a leftover puff finishes. A paused simulation that is single-stepped advances them by the
 * simulated time of the step.
 */
export interface ClockInput {
  /** A simulated world exists (running or paused). */
  active: boolean;
  running: boolean;
  timeScale: number;
  /** `SimStats.realtimeFactor`: how much of the requested speed the simulation achieved. */
  realtimeFactor?: number;
  /** `SimStats.simTime`. */
  simTime?: number;
}

/** The longest step reported, so a long stall does not make particles jump to the end of their lives. */
export const MAX_FX_STEP = 0.25;

export class FxClock {
  private lastSim = -1;

  /** Effects time to advance for `realDt` seconds of wall-clock time. */
  step(realDt: number, i: ClockInput): number {
    let out: number;
    if (!i.active) out = realDt;
    else if (i.running) out = realDt * Math.max(0, i.timeScale) * Math.min(1, Math.max(0.02, i.realtimeFactor ?? 1));
    else {
      const t = i.simTime ?? 0;
      out = this.lastSim >= 0 && t > this.lastSim ? t - this.lastSim : 0;
    }
    this.lastSim = i.active ? (i.simTime ?? 0) : -1;
    return Math.min(MAX_FX_STEP, Math.max(0, out));
  }

  reset(): void {
    this.lastSim = -1;
  }
}
