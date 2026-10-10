// -- DT-40: "Install app" state (beforeinstallprompt) --
/**
 * Chromium fires `beforeinstallprompt` once the page is installable, usually before the UI exists, so the listener is
 * attached when this module is imported and the event is kept until the user asks to install. `canInstall()` is true
 * only while an install is actually possible (not already installed, event received), which is what the command and
 * menu entry in src/ui/extensions/pwa.ts check. Safari and Firefox never fire the event: there the entry stays
 * hidden and docs/DESKTOP.md explains the browser's own "Add to Dock" / "Install" route.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;

export function canInstall(): boolean {
  return deferred !== null;
}

/** Show the browser's install dialog. Resolves with the user's choice, or null when nothing can be installed. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | null> {
  const ev = deferred;
  if (!ev) return null;
  deferred = null; // the event can be used once
  await ev.prompt();
  return (await ev.userChoice).outcome;
}

export function watchInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep the mini-infobar away; the command / menu entry offers the install instead
    deferred = e as BeforeInstallPromptEvent;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
  });
}
