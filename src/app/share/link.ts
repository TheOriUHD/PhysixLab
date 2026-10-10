/**
 * Share links (DT-20): `#s=<payload>` is the compact v2 codec (`compact.ts`), `#scene=<payload>` the v1 link
 * (JSON + deflate) that old links still use. `buildShare` produces v2 and verifies it decodes to the same scene
 * before handing it out, falling back to v1 if it ever would not.
 */
import { SceneFormatError, type LoadReport } from '../../model/errors';
import { LIMITS } from '../../model/limits';
import { parseDocument, sanitizeDocument, serializeDocument } from '../../model/serialize';
import type { SceneDocument } from '../../model/types';
import {
  decodeCompact,
  deflate,
  encodeCompact,
  fromBase64Url,
  inflate,
  canonicalText,
  expectedAfterRoundTrip,
  toBase64Url,
} from './compact';

export interface ShareResult {
  /** Full URL (`base` + `#s=…`). */
  url: string;
  /** Payload length in characters of the link that was produced (the hash value). */
  chars: number;
  /** Payload length the v1 link would have had, for the "N % shorter" display. */
  v1Chars: number;
  format: 'v2' | 'v1';
  /** True when the link is longer than `LIMITS.maxShareLinkChars`: the UI must offer a file download instead. */
  tooLarge: boolean;
}

export async function encodeV1(doc: SceneDocument): Promise<string> {
  const z = await deflate(new TextEncoder().encode(serializeDocument(doc)));
  return toBase64Url(z);
}

export async function encodeV2(doc: SceneDocument): Promise<string> {
  return toBase64Url(await encodeCompact(doc));
}

function sameScene(a: unknown, b: unknown): boolean {
  return canonicalText(a) === canonicalText(b);
}

/** `doc` should already be the serialised-and-sanitised document (what `SceneStore.toDocument` gives). */
export async function buildShare(doc: SceneDocument, base: string): Promise<ShareResult> {
  const v1 = await encodeV1(doc);
  let payload = v1;
  let format: ShareResult['format'] = 'v1';
  try {
    const v2 = await encodeV2(doc);
    // Safety net: the compact link must decode to exactly the quantised scene, otherwise ship the v1 link.
    const back = await decodeCompact(fromBase64Url(v2));
    if (v2.length < v1.length && sameScene(back, expectedAfterRoundTrip(doc))) {
      payload = v2;
      format = 'v2';
    }
  } catch {
    /* keep v1 */
  }
  const url = new URL(base);
  url.hash = `${format === 'v2' ? 's' : 'scene'}=${payload}`;
  const link = url.toString();
  return {
    url: link,
    chars: payload.length,
    v1Chars: v1.length,
    format,
    tooLarge: link.length > LIMITS.maxShareLinkChars,
  };
}

export function tooLargeError(r: ShareResult): SceneFormatError {
  return new SceneFormatError(
    'limit',
    `This scene is too large for a share link (${Math.round(r.url.length / 1000)} kB; the limit is ${Math.round(LIMITS.maxShareLinkChars / 1000)} kB). Export it as a file instead — files have no size limit.`,
  );
}

/** The scene a share-link hash carries (v2 or v1), or null when the hash holds none. Throws `SceneFormatError` when it is damaged. */
export async function parseShareHash(hash: string, report?: LoadReport): Promise<SceneDocument | null> {
  const m = /(?:^|[#&])(s|scene)=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  if (m[2].length > LIMITS.maxShareLinkChars * 2)
    throw new SceneFormatError(
      'limit',
      'This share link is far too long to be a PhysicsLab scene, so it was not opened.',
    );
  const damaged = new SceneFormatError(
    'invalid-json',
    'This share link is damaged or incomplete, so its scene could not be opened.',
  );
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(m[2]);
  } catch {
    throw damaged;
  }
  if (m[1] === 's') {
    let raw: unknown;
    try {
      raw = await decodeCompact(bytes);
    } catch {
      throw damaged;
    }
    return sanitizeDocument(raw, report);
  }
  let text: string;
  try {
    text = new TextDecoder().decode(await inflate(bytes));
  } catch {
    throw damaged;
  }
  return parseDocument(text, report);
}
