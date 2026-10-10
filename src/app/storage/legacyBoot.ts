// Imported first by main.ts so that saved data is under the new keys before any module reads it.
import { migrateLegacyStorage } from './legacyStorage';

try {
  if (typeof localStorage !== 'undefined') migrateLegacyStorage(localStorage);
} catch {
  /* storage unavailable (private mode, blocked): nothing to migrate */
}
