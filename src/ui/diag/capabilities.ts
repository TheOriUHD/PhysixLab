/**
 * Capability checks (UI-43): what the browser must offer for PhysicsLab to run, and plain-language guidance when it
 * does not. `checkCapabilities(env)` is pure (it takes a plain description of the environment, so tests can feed it a
 * fake one); `probeEnvironment()` fills that description from the real browser.
 */

export type CapStatus = 'ok' | 'warn' | 'fail';

/** What the probe found. `null` means "could not be determined". */
export interface CapEnv {
  webgl2: boolean | null;
  webAssembly: boolean;
  worker: boolean;
  moduleWorker: boolean | null;
  localStorage: boolean;
  indexedDB: boolean;
  /** Informational: the app does not need it. */
  offscreenCanvas: boolean;
}

export interface CapItem {
  id: string;
  label: string;
  status: CapStatus;
  /** One short sentence about what was found. */
  summary: string;
  /** What it means for the user and what to try (empty when everything is fine). */
  guidance: string;
}

export interface CapReport {
  items: CapItem[];
  /** Something essential is missing: the app cannot start. */
  fatal: boolean;
  /** Everything essential works, but something optional does not (saving, for example). */
  degraded: boolean;
  /** One plain sentence for the top of a message. */
  headline: string;
}

const item = (id: string, label: string, status: CapStatus, summary: string, guidance = ''): CapItem => ({
  id,
  label,
  status,
  summary,
  guidance,
});

/** Evaluate an environment description. Pure. */
export function checkCapabilities(env: CapEnv): CapReport {
  const items: CapItem[] = [];
  items.push(
    env.webgl2
      ? item('webgl2', 'WebGL 2 (3D graphics)', 'ok', 'Available.')
      : item(
          'webgl2',
          'WebGL 2 (3D graphics)',
          'fail',
          env.webgl2 === null ? 'Could not be checked.' : 'Not available.',
          'PhysicsLab draws its 3D view with WebGL 2. Turn on hardware acceleration in your browser settings, update your browser and graphics driver, or try another browser such as a current Chrome, Edge, Firefox or Safari. Remote desktops and some virtual machines do not offer WebGL.',
        ),
  );
  items.push(
    env.webAssembly
      ? item('wasm', 'WebAssembly (physics engine)', 'ok', 'Available.')
      : item(
          'wasm',
          'WebAssembly (physics engine)',
          'fail',
          'Not available.',
          'The physics engine is compiled to WebAssembly. Update your browser; some locked-down or very old browsers switch it off.',
        ),
  );
  items.push(
    env.worker
      ? item('worker', 'Web Workers (background physics)', 'ok', 'Available.')
      : item(
          'worker',
          'Web Workers (background physics)',
          'fail',
          'Not available.',
          'Physics runs on a background thread so the screen stays smooth. Update your browser, or check that no privacy extension blocks workers.',
        ),
  );
  items.push(
    env.moduleWorker === false
      ? item(
          'moduleWorker',
          'Module workers',
          'fail',
          'Not supported.',
          'The physics worker is loaded as a module. Update to a current browser (Chrome/Edge 80+, Firefox 114+, Safari 15+).',
        )
      : item(
          'moduleWorker',
          'Module workers',
          'ok',
          env.moduleWorker === null ? 'Could not be checked (assumed to work).' : 'Supported.',
        ),
  );
  items.push(
    env.localStorage
      ? item('localStorage', 'Local storage (preferences)', 'ok', 'Available.')
      : item(
          'localStorage',
          'Local storage (preferences)',
          'warn',
          'Blocked or unavailable.',
          'Your settings and layout cannot be remembered. This usually means a private window or blocked site data. Allow site data for this page to keep them.',
        ),
  );
  items.push(
    env.indexedDB
      ? item('indexedDB', 'IndexedDB (autosave and scene library)', 'ok', 'Available.')
      : item(
          'indexedDB',
          'IndexedDB (autosave and scene library)',
          'warn',
          'Blocked or unavailable.',
          'Your scenes are kept in memory only and are lost when you close the tab. Use File → Export scene file to keep your work, or leave the private window.',
        ),
  );
  items.push(
    item(
      'offscreenCanvas',
      'OffscreenCanvas',
      'ok',
      env.offscreenCanvas ? 'Available (not required).' : 'Not available (not required).',
    ),
  );
  const fatal = items.some((i) => i.status === 'fail');
  const degraded = !fatal && items.some((i) => i.status === 'warn');
  const failing = items.filter((i) => i.status === 'fail').map((i) => i.label);
  const headline = fatal
    ? `This browser is missing ${failing.length === 1 ? 'a feature' : 'features'} PhysicsLab needs: ${failing.join(', ')}.`
    : degraded
      ? 'PhysicsLab works here, with limits: some things cannot be saved.'
      : 'Everything PhysicsLab needs is available.';
  return { items, fatal, degraded, headline };
}

/** Fill a `CapEnv` from the real browser (or from the objects given, for tests). */
export function probeEnvironment(
  g: Record<string, unknown> = globalThis,
  makeCanvas: () => { getContext(id: string): unknown } | null = () =>
    typeof document === 'undefined' ? null : document.createElement('canvas'),
): CapEnv {
  const canUse = (key: string): boolean => {
    try {
      const s = g[key] as Storage | undefined;
      if (!s) return false;
      const k = '__physicslab_probe__';
      s.setItem(k, '1');
      s.removeItem(k);
      return true;
    } catch {
      return false;
    }
  };
  let webgl2: boolean | null;
  try {
    const c = makeCanvas();
    const gl = c
      ? (c.getContext('webgl2') as { getExtension?(n: string): { loseContext(): void } | null } | null)
      : null;
    webgl2 = c ? !!gl : null;
    // Do not keep a spare context alive (browsers allow only a handful).
    gl?.getExtension?.('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl2 = false;
  }
  const WorkerCtor = g.Worker as (new (url: string, o?: unknown) => { terminate(): void }) | undefined;
  let moduleWorker: boolean | null;
  if (WorkerCtor) {
    try {
      // The `type` option is read only by browsers that know module workers.
      let read = false;
      const options = {
        get type() {
          read = true;
          return 'module';
        },
      };
      const w = new WorkerCtor('data:text/javascript,', options);
      w.terminate();
      moduleWorker = read;
    } catch {
      moduleWorker = null;
    }
  } else moduleWorker = false;
  return {
    webgl2,
    webAssembly: typeof g.WebAssembly === 'object' && g.WebAssembly !== null,
    worker: !!WorkerCtor,
    moduleWorker,
    localStorage: canUse('localStorage'),
    indexedDB: !!g.indexedDB,
    offscreenCanvas: typeof g.OffscreenCanvas === 'function',
  };
}
