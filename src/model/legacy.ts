/**
 * The app was called "PhysicsLab" before it became PhysixLab. Files and saved settings written under the old
 * name keep working: documents are accepted with either format marker (and re-written with the new one), and
 * browser storage is copied across once on the first boot (see `app/storage/legacyStorage.ts`).
 */
export const LEGACY_NAME = 'physicslab';

/** `physixlab-scene` → `physicslab-scene`: the pre-rename spelling of a format marker. */
export const legacyFormat = (format: string): string => format.replace(/^physixlab-/, `${LEGACY_NAME}-`);

/** True when `value` is the format marker `current` or its pre-rename spelling. */
export const isFormat = (value: unknown, current: string): boolean =>
  value === current || value === legacyFormat(current);
