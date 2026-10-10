/**
 * Keeps the interface sounds subtle: the same sound is never repeated faster than its minimum interval (a box
 * selection must not machine-gun the select tick), and a stronger sound hides a weaker one that arrives with it
 * (placing an object selects it: only the place sound plays). Pure; the director owns the clock.
 */
export type UiSoundKind = 'select' | 'place' | 'delete' | 'error' | 'success' | 'toggle';

/** Shortest time between two sounds of a kind, seconds. */
const MIN_INTERVAL: Record<UiSoundKind, number> = {
  select: 0.07,
  place: 0.09,
  delete: 0.09,
  error: 0.4,
  success: 0.4,
  toggle: 0.08,
};

/** A sound of the key hides the listed kinds for this many seconds. */
const MASKS: Partial<Record<UiSoundKind, { kinds: UiSoundKind[]; seconds: number }>> = {
  place: { kinds: ['select'], seconds: 0.25 },
  delete: { kinds: ['select'], seconds: 0.25 },
  error: { kinds: ['select', 'delete', 'place'], seconds: 0.3 },
};

export class UiSoundGate {
  private readonly last = new Map<UiSoundKind, number>();
  private readonly maskedUntil = new Map<UiSoundKind, number>();

  /** May `kind` sound at time `now`? Records it when it does. */
  request(kind: UiSoundKind, now: number): boolean {
    if (now < (this.maskedUntil.get(kind) ?? -Infinity)) return false;
    const last = this.last.get(kind);
    if (last !== undefined && now - last < MIN_INTERVAL[kind]) return false;
    this.last.set(kind, now);
    const mask = MASKS[kind];
    if (mask) for (const k of mask.kinds) this.maskedUntil.set(k, now + mask.seconds);
    return true;
  }

  clear(): void {
    this.last.clear();
    this.maskedUntil.clear();
  }
}
