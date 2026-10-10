/** Errors and load reports shared by the document loader, the migration chain and the asset store. */

export type SceneErrorCode =
  'invalid-json' | 'not-a-scene' | 'invalid-version' | 'too-new' | 'missing-migration' | 'limit' | 'asset';

/**
 * A document could not be loaded (or an asset could not be added). The message is written for the end
 * user — it says what is wrong and, where possible, what to do — so the UI can show it verbatim.
 */
export class SceneFormatError extends Error {
  constructor(
    readonly code: SceneErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SceneFormatError';
  }
}

/**
 * Collects the non-fatal problems found while loading a document (an unknown shape replaced by a box, an
 * asset that failed validation, a dangling parent link, …). Pass one to `sanitizeDocument` / `parseDocument`
 * to show them to the user; omit it and the problems are repaired silently.
 */
export interface LoadReport {
  warnings: string[];
}

export function newReport(): LoadReport {
  return { warnings: [] };
}

/** Records a warning once (identical messages are collapsed so a 1000-body scene does not flood the report). */
export function warn(report: LoadReport | undefined, message: string): void {
  if (!report || report.warnings.includes(message)) return;
  report.warnings.push(message);
}
