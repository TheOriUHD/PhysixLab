// -- UI-B: lets the clipboard layer claim a Ctrl+V for a scene on the clipboard before the editor pastes entities --
let claimedAt = -1;

/** Called by the window `paste` listener when it takes the paste over (a scene is on the clipboard). */
export function claimPaste(): void {
  claimedAt = performance.now();
}

/** Was the paste that started at `t` claimed (the `edit.paste` command waits one task for the browser's paste event)? */
export function pasteClaimedSince(t: number): boolean {
  return claimedAt >= t;
}
