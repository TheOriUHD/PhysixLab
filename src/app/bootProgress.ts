/**
 * Milestones for the start-up splash in index.html (its inline loader owns the bar; see the comment there).
 * Each one is reported when the thing it names has really happened:
 *   boot    the app's code is running                 engine  the physics worker finished starting (wasm compiled)
 *   ui      the editor interface is built             scene   the initial scene is loaded
 *   frame   the first frame has been drawn (this ends the splash)
 * Everything is a no-op when the page has no splash (tests, embeds that removed it).
 */
export type BootStep = 'boot' | 'engine' | 'ui' | 'scene' | 'frame';

interface BootApi {
  step(id: BootStep): void;
  hide(): void;
}

const api = (): BootApi | undefined => (window as unknown as { __boot?: BootApi }).__boot;

export function bootStep(id: BootStep): void {
  api()?.step(id);
}

/** Remove the splash now (boot failed, unsupported browser, embed). */
export function bootHide(): void {
  api()?.hide();
}
