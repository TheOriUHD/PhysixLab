/** UI-A: sanitisers for the outliner fields (colour tag, extra tags, solo marks) and for named selection sets. */
import { TAG_COLORS } from '../outlinerMeta';
import { LIMITS } from '../limits';
import type { OutlinerMeta, SelectionSet } from '../types';
import { sanitizeTags } from './bodyFields';
import { idStr, nameStr } from './primitives';

/** The optional outliner fields of a raw entity; absent when unset so old documents round-trip unchanged. */
export function outlinerMetaFields(raw: Record<string, unknown>, withTags: boolean): OutlinerMeta {
  const out: OutlinerMeta = {};
  if (typeof raw.colorTag === 'string' && Object.hasOwn(TAG_COLORS, raw.colorTag)) out.colorTag = raw.colorTag;
  if (withTags) {
    const tags = sanitizeTags(raw.tags);
    if (tags.length) out.tags = tags;
  }
  if (raw.solo === true) out.solo = true;
  if (raw.soloHid === true) out.soloHid = true;
  return out;
}

const MAX_SETS = 200;

/** Named selection sets: unique non-empty names, bounded id lists (dangling ids are skipped at recall time). */
export function sanitizeSelectionSets(raw: unknown): SelectionSet[] {
  if (!Array.isArray(raw)) return [];
  const out: SelectionSet[] = [];
  for (const r of (raw as unknown[]).slice(0, MAX_SETS)) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    const name = nameStr(o.name, '').trim();
    if (!name || out.some((s) => s.name === name)) continue;
    const ids = Array.isArray(o.ids)
      ? (o.ids as unknown[])
          .filter((i): i is string => typeof i === 'string' && i.length > 0)
          .slice(0, LIMITS.maxEntities)
          .map((i) => idStr(i, ''))
      : [];
    out.push({ name, ids: [...new Set(ids)] });
  }
  return out;
}
