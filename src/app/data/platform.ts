/**
 * The data platform's start-up wiring (DT-10 … DT-12): opens storage, starts restore points, the session guard
 * (crash detection) and the worker-crash handler. `main.ts` calls `initDataPlatform(app)` once, after
 * `app.persistence.init()`, and `announceRecovery()` once the first scene is in place.
 */
import { showBanner } from '../../ui/banner';
import type { SceneDocument } from '../../model/types';
import type { App } from '../app';
import { getStorage } from '../storage';
import { detectCrash, SessionGuard, type CrashInfo } from '../storage/recovery';
import { RestorePoints, setRiskyOperationHook } from '../storage/restorePoints';
import { captureThumbnail } from './thumbnail';

export interface DataPlatform {
  restore: RestorePoints;
  crash: CrashInfo;
  /** The newest restore point's scene, for when the autosave is missing after a crash. */
  recoveryDoc(): Promise<SceneDocument | null>;
  /** Shows the "last session ended unexpectedly" banner when there was a crash. */
  announceRecovery(restoredFrom: 'autosave' | 'restore-point' | 'none'): void;
  /** Takes a restore point right now (manual/before kinds), with a viewport thumbnail. */
  snapshot(label: string, kind: 'manual' | 'before'): Promise<void>;
}

let current: DataPlatform | null = null;
export const dataPlatform = (): DataPlatform | null => current;

export async function initDataPlatform(app: App): Promise<DataPlatform> {
  const storage = await getStorage();
  const restore = new RestorePoints(storage);
  await restore.init();

  const crash = ((): CrashInfo => {
    try {
      return detectCrash(localStorage);
    } catch {
      return { crashed: false, lastAlive: null };
    }
  })();
  try {
    const guard = new SessionGuard(localStorage);
    guard.start();
    window.addEventListener('pagehide', () => guard.markClean());
    window.addEventListener('beforeunload', () => guard.markClean());
  } catch {
    /* no localStorage: crash detection is off */
  }

  const snapshot = async (label: string, kind: 'manual' | 'before') => {
    const thumb = await captureThumbnail(app.viewport).catch(() => undefined);
    await restore.create(app.store.toDocument(), label, kind, thumb);
  };
  setRiskyOperationHook((label) => {
    // Synchronous capture of the document now; the thumbnail is skipped here because the scene is about to change.
    void restore.create(app.store.toDocument(), label, 'before');
  });
  restore.startAuto(
    () => app.store.toDocument(),
    () => app.store.revision,
    () => captureThumbnail(app.viewport),
  );

  // A dead or hung physics worker: restart it, return to the authored layout (the document is untouched).
  app.sim.client.on('crash', (message) => {
    console.error('[physics worker crashed]', message);
    app.sim.client.restart();
    app.sim.reset();
    showBanner(
      'worker-crash',
      'The physics engine stopped unexpectedly and was restarted. Your scene is safe — press Play to run it again.',
      [{ label: 'OK', run: () => undefined, primary: true }],
      'warn',
    );
  });

  // DT-13: reconnect the remembered sync folder in the background (dynamic import keeps first load small)
  void storage.get('meta', 'folder-handle').then((h) => {
    if (h) void import('./folderSyncService').then((m) => m.ensureFolderSync(app).restore());
  });

  current = {
    restore,
    crash,
    async recoveryDoc() {
      const newest = (await restore.list())[0];
      return newest ? restore.load(newest.id) : null;
    },
    announceRecovery(restoredFrom) {
      if (!crash.crashed) return;
      const when = crash.lastAlive ? ` (last active ${new Date(crash.lastAlive).toLocaleTimeString()})` : '';
      const what =
        restoredFrom === 'autosave'
          ? 'Your last autosave was restored.'
          : restoredFrom === 'restore-point'
            ? 'The autosave was missing, so the newest restore point was opened.'
            : 'No saved scene was found.';
      showBanner(
        'crash-recovery',
        `PhysicsLab did not close properly last time${when}. ${what}`,
        [
          {
            label: 'Browse restore points',
            run: () => void import('../../ui/data/restorePointsDialog').then((m) => m.showRestorePoints(app)),
            primary: true,
          },
          { label: 'Dismiss', run: () => undefined },
        ],
        'warn',
      );
    },
    snapshot,
  };
  return current;
}
