/**
 * DT-31 / DT-32: a throw-away JavaScript sandbox for untrusted code (plugins, scene scripts).
 *
 * Layers, outermost first:
 *  1. `<iframe sandbox="allow-scripts">` with a `srcdoc` document: an opaque origin, so no access to the app's DOM,
 *     cookies, localStorage, IndexedDB or any same-origin API; it cannot navigate the top page or open popups.
 *  2. A `Content-Security-Policy` meta tag in that document: `default-src 'none'` — no fetch / XHR / WebSocket /
 *     beacon / images / frames / dynamic `import()` of anything but our own blob: worker. A blob: worker inherits the
 *     policy of the document that created it, so the worker is locked the same way.
 *  3. The user code runs in a dedicated Worker (so a runaway loop only burns that thread and `dispose()` kills it)
 *     whose global scope has the network / storage / messaging APIs removed (workerRuntime.mjs).
 *  4. The only channel out is a MessagePort carrying `{ call, method, args }` that the host answers from an explicit
 *     allow-list of handlers (`handlers`). Calls are counted; exceeding the budget kills the sandbox.
 *
 * The tests in e2e/tests/sandbox.mjs attack every layer from hostile code and assert that nothing leaks.
 */
import runtimeSource from './workerRuntime.mjs?raw';

export type SandboxHandler = (...args: unknown[]) => unknown;

export interface SandboxOptions {
  /** The allow-list: method names the sandboxed code may call. Anything else is rejected. */
  handlers: Record<string, SandboxHandler>;
  /** Console output from the sandbox. */
  onLog?: (level: 'log' | 'warn' | 'error', text: string) => void;
  /** Maximum number of calls from the sandbox over its lifetime (default 100 000). */
  maxCalls?: number;
  /** Maximum number of log lines (default 500). */
  maxLogLines?: number;
  /** How long the sandbox may take to start (default 5 s). */
  startTimeoutMs?: number;
}

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'error' | 'disposed' | 'budget' | 'start',
    readonly stack?: string,
  ) {
    super(message);
  }
}

const SRCDOC = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; child-src blob:">
</head><body><script>
addEventListener('message', function (e) {
  var d = e.data;
  if (!d || d.t !== 'boot' || !e.ports[0]) return;
  var w = new Worker(URL.createObjectURL(new Blob([d.src], { type: 'text/javascript' })));
  w.postMessage({ t: 'port', port: e.ports[0] }, [e.ports[0]]);
}, { once: true });
parent.postMessage({ t: 'frame-ready' }, '*');
</script></body></html>`;

/** Exposed for the isolation test, which re-creates the container to attack it from inside. */
export const __srcdocForTests = SRCDOC;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: SandboxError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class Sandbox {
  private frame: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private disposed = false;
  private calls = 0;
  private logLines = 0;
  private nextId = 1;
  private readonly runs = new Map<number, Pending>();
  private readonly invokes = new Map<number, Pending>();

  private constructor(private readonly o: SandboxOptions) {}

  /** Start a sandbox. Rejects with a `SandboxError('start')` when the browser cannot provide one. */
  static create(o: SandboxOptions): Promise<Sandbox> {
    const sb = new Sandbox(o);
    return sb.start().then(() => sb);
  }

  get alive(): boolean {
    return !this.disposed;
  }

  private start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
      frame.srcdoc = SRCDOC;
      this.frame = frame;
      const channel = new MessageChannel();
      this.port = channel.port1;
      const fail = (m: string) => {
        window.removeEventListener('message', onFrame);
        this.dispose();
        reject(new SandboxError(m, 'start'));
      };
      const timer = setTimeout(() => fail('The sandbox did not start in time'), this.o.startTimeoutMs ?? 15000);
      const onFrame = (ev: MessageEvent) => {
        if (ev.source !== frame.contentWindow || (ev.data as { t?: string } | null)?.t !== 'frame-ready') return;
        window.removeEventListener('message', onFrame);
        frame.contentWindow?.postMessage({ t: 'boot', src: runtimeSource }, '*', [channel.port2]);
      };
      window.addEventListener('message', onFrame);
      channel.port1.onmessage = (ev: MessageEvent) => {
        const m = ev.data as { t?: string };
        if (m?.t === 'ready') {
          clearTimeout(timer);
          channel.port1.onmessage = (e2: MessageEvent) => this.onMessage(e2.data as Record<string, unknown>);
          resolve();
        }
      };
      document.body.appendChild(frame);
    });
  }

  /**
   * Run `code` in the sandbox. `prelude` is trusted text that builds the scope the code sees (it must `return
   * { scope, finish? }`, see workerRuntime.mjs); the value of `finish()` is the result. Rejects on an error in the code,
   * on timeout (the sandbox is then disposed — a hung worker cannot be recovered) or when disposed.
   */
  run(code: string, prelude: string, timeoutMs = 3000): Promise<unknown> {
    return this.request(this.runs, { t: 'run', code, prelude }, timeoutMs);
  }

  /** Call a callback the sandboxed code registered through `cb()` (`{ __cb: id }`). */
  invoke(cbId: number, args: unknown[] = [], timeoutMs = 2000): Promise<unknown> {
    return this.request(this.invokes, { t: 'invoke', cb: cbId, a: args }, timeoutMs);
  }

  /** Tell the sandbox it may drop callbacks (after a panel was re-rendered, say). */
  forget(cbs: number[]): void {
    if (!this.disposed && cbs.length) this.port?.postMessage({ t: 'forget', cbs });
  }

  private request(table: Map<number, Pending>, msg: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.disposed || !this.port) return Promise.reject(new SandboxError('The sandbox was stopped', 'disposed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!table.has(id)) return;
        // A worker stuck in a loop cannot be interrupted: stop the whole sandbox.
        this.dispose(new SandboxError(`Timed out after ${timeoutMs} ms`, 'timeout'));
      }, timeoutMs);
      table.set(id, { resolve, reject, timer });
      this.port!.postMessage({ ...msg, id });
    });
  }

  private onMessage(m: Record<string, unknown>): void {
    switch (m['t']) {
      case 'call':
        void this.onCall(m['id'] as number, m['m'] as string, m['a'] as unknown[]);
        break;
      case 'log': {
        if (++this.logLines > (this.o.maxLogLines ?? 500)) return;
        const level = m['level'] === 'warn' || m['level'] === 'error' ? m['level'] : 'log';
        this.o.onLog?.(level, String(m['text']).slice(0, 2000));
        break;
      }
      case 'done':
        this.settle(this.runs, m);
        break;
      case 'ret':
        this.settle(this.invokes, m);
        break;
    }
  }

  private settle(table: Map<number, Pending>, m: Record<string, unknown>): void {
    const p = table.get(m['id'] as number);
    if (!p) return;
    table.delete(m['id'] as number);
    if (p.timer) clearTimeout(p.timer);
    if (m['ok']) p.resolve(m['value']);
    else {
      const e = m['error'] as { message?: string; stack?: string } | undefined;
      p.reject(new SandboxError(String(e?.message ?? 'error'), 'error', e?.stack));
    }
  }

  private async onCall(id: number, method: string, args: unknown[]): Promise<void> {
    if (this.disposed) return;
    if (++this.calls > (this.o.maxCalls ?? 100_000)) {
      this.dispose(new SandboxError('The sandbox made too many calls', 'budget'));
      return;
    }
    const reply = (ok: boolean, payload: unknown) => {
      if (!this.disposed) this.port?.postMessage({ t: 'ret', id, ok, [ok ? 'value' : 'error']: payload });
    };
    // Own-property check: `constructor`, `__proto__`, `toString` … must never resolve to something.
    const handler = Object.prototype.hasOwnProperty.call(this.o.handlers, method) ? this.o.handlers[method] : undefined;
    if (typeof handler !== 'function') {
      reply(false, `Unknown or forbidden call "${String(method).slice(0, 60)}"`);
      return;
    }
    try {
      const value = await handler(...(Array.isArray(args) ? args : []));
      reply(true, value === undefined ? null : value);
    } catch (e) {
      reply(false, e instanceof Error ? e.message : String(e));
    }
  }

  /** Kill the worker and remove the iframe. Pending runs / invocations reject with `reason`. */
  dispose(reason: SandboxError = new SandboxError('The sandbox was stopped', 'disposed')): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.port?.close();
    } catch {
      /* already closed */
    }
    this.port = null;
    this.frame?.remove();
    this.frame = null;
    for (const table of [this.runs, this.invokes]) {
      for (const p of table.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(reason);
      }
      table.clear();
    }
  }
}
