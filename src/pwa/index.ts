// -- DT-40: PWA bootstrap — one call from src/main.ts --
import type { App } from '../app/app';
import { wireFileIntake } from './fileIntake';
import { watchInstallPrompt } from './install';
import { registerServiceWorker } from './register';
import { showUpdatePrompt } from './updatePrompt';
import '../styles/pwa.css';

// `beforeinstallprompt` can fire before the app finishes booting: listen from the moment this module loads.
watchInstallPrompt();

/** Register the service worker (production only), the update banner and the file / share intake. */
export function initPwa(app: App): void {
  wireFileIntake(app);
  registerServiceWorker({
    onUpdate: (apply) => showUpdatePrompt(apply),
    onOfflineReady: () => app.toast('PhysixLab is ready to work offline.', 'success'),
  });
}
