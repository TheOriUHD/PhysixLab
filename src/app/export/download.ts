/**
 * The one place that hands a file to the user. Tests (e2e) set `window.__physixlabCaptureDownloads = true` to have
 * the file kept in `window.__lastDownload` (name, type, size, Blob) instead of being saved.
 */

export interface CapturedDownload {
  name: string;
  type: string;
  size: number;
  blob: Blob;
}

/** The test hooks live on `window`; this is their shape (declared here instead of using `any`). */
interface DownloadHooks {
  __physixlabCaptureDownloads?: boolean;
  __lastDownload?: CapturedDownload;
}

export function downloadBlob(name: string, blob: Blob): void {
  const hooks = window as unknown as DownloadHooks;
  if (hooks.__physixlabCaptureDownloads) {
    hooks.__lastDownload = { name, type: blob.type, size: blob.size, blob };
    return;
  }
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** A safe file stem from a scene name. */
export function fileStem(name: string, fallback = 'scene'): string {
  const s = name
    .trim()
    .replace(/[^\w-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || fallback;
}
