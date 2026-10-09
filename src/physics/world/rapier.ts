import RAPIER from '@dimforge/rapier3d-compat';

let rapierReady: Promise<void> | null = null;

/** Initialise the Rapier WebAssembly module once; every later call returns the same promise. */
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}
