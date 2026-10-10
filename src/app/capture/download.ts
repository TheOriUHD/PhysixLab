// -- DT-2: save a Blob as a file download (with a test hook) --
/**
 * Offer `blob` to the user as a download. When `window.__downloadHook` is true (set by the e2e tests) nothing is
 * downloaded; the file is stored in `window.__lastDownload` so a test can inspect the bytes.
 */
export interface LastDownload {
  name: string;
  type: string;
  size: number;
  blob: Blob;
}

declare global {
  interface Window {
    __downloadHook?: boolean;
    __lastDownload?: LastDownload;
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  if (window.__downloadHook) {
    window.__lastDownload = { name: filename, type: blob.type, size: blob.size, blob };
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
