/** VZ-42: sanitiser for a body's visual skin. Unknown skin ids survive (the renderer ignores what it does not know). */
import { LIMITS } from '../limits';
import type { SkinSpec } from '../types';
import { obj } from './primitives';

const MAX_PARAMS = 16;

export function sanitizeSkin(raw: unknown): SkinSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = obj(raw);
  if (typeof r.id !== 'string') return undefined;
  const id = r.id.trim().slice(0, LIMITS.maxIdLength);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return undefined;
  const out: SkinSpec = { id };
  if (r.params && typeof r.params === 'object' && !Array.isArray(r.params)) {
    const params: Record<string, number | string | boolean> = {};
    let n = 0;
    for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) {
      if (n >= MAX_PARAMS || !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(k)) continue;
      if (typeof v === 'number' && Number.isFinite(v)) params[k] = Math.max(-1e6, Math.min(1e6, v));
      else if (typeof v === 'string') params[k] = v.slice(0, 64);
      else if (typeof v === 'boolean') params[k] = v;
      else continue;
      n++;
    }
    if (n > 0) out.params = params;
  }
  return out;
}
