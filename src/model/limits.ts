/**
 * Every sanity limit the document model enforces, in one place.
 *
 * `sanitizeDocument` (the single choke point for files, autosave, share links and the asset API) uses
 * these to reject documents that would freeze the browser or exhaust memory with a friendly error, and
 * to truncate / clamp free-form values. Change a number here and every code path follows.
 */

export const KIB = 1024;
export const MIB = 1024 * KIB;

export const LIMITS = {
  // ── scene size ──────────────────────────────────────────────────────────────────────────────────
  /** Most entities (bodies + joints + soft bodies + …) one scene may hold. */
  maxEntities: 20_000,
  /** Largest scene file / autosave / share-link payload accepted, in characters of JSON text. */
  maxDocumentChars: 160 * MIB,
  /** Longest share link PhysicsLab will hand out, in characters (chat apps and servers truncate beyond this). */
  maxShareLinkChars: 150_000,

  // ── strings ─────────────────────────────────────────────────────────────────────────────────────
  /** Entity / scene display names. */
  maxNameLength: 120,
  /** Entity ids and asset ids. */
  maxIdLength: 64,
  /** Free-form short strings (keys, layer names, presets, colours). */
  maxStringLength: 256,
  /** Tags per body and the length of one tag. */
  maxTags: 32,
  maxTagLength: 48,

  // ── numbers ─────────────────────────────────────────────────────────────────────────────────────
  /** Positions are clamped to ±this many metres (single-precision rendering stops being meaningful beyond it). */
  maxCoordinate: 1_000_000,
  /** Largest bounding-box side of one shape, metres. */
  maxDimension: 100_000,

  // ── compound bodies ─────────────────────────────────────────────────────────────────────────────
  /** Collider parts one body may carry. */
  maxPartsPerBody: 64,

  // ── group / light / path entities (FB-6) ────────────────────────────────────────────────────────
  /** Control points of one path. */
  maxPathPoints: 1024,
  /** Lights one scene may hold (the renderer additionally draws only the first few as real lights). */
  maxLights: 64,
  /** Nesting depth of groups the editor will walk (also guards against cycles in hand-made files). */
  maxGroupDepth: 64,

  // ── components (FB-7) ───────────────────────────────────────────────────────────────────────────
  /** Components one body or joint may carry. */
  maxComponentsPerEntity: 32,
  /** Points of a `curve` field and entries of a vec / list field. */
  maxCurvePoints: 128,

  // ── asset store ─────────────────────────────────────────────────────────────────────────────────
  /** Assets one scene may hold. */
  maxAssets: 256,
  /** Decoded payload of a single asset, bytes. */
  maxAssetBytes: 16 * MIB,
  /** Decoded payload of all assets together, bytes. */
  maxTotalAssetBytes: 64 * MIB,
  /** Vertices of one mesh asset. */
  maxMeshVertices: 1_000_000,
  /** Samples per axis of a heightmap asset. */
  maxHeightmapSide: 4096,
} as const;

/** "12.4 MB" style size for error messages. */
export function formatBytes(n: number): string {
  if (n >= MIB) return `${(n / MIB).toFixed(n >= 10 * MIB ? 0 : 1)} MB`;
  if (n >= KIB) return `${(n / KIB).toFixed(n >= 10 * KIB ? 0 : 1)} KB`;
  return `${Math.round(n)} bytes`;
}

/** "20,000" style count for error messages. */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
