/*
 * DT-31 / DT-32 sandbox: the script that runs INSIDE the sandbox worker (loaded as text via `?raw`, then started from
 * a blob: URL inside a sandboxed, CSP-locked iframe — see sandbox.ts). It is a classic script, not a module.
 *
 * Defence in depth (the iframe CSP `default-src 'none'` is what stops dynamic import() and anything we forget here):
 *  1. every network / storage / worker / messaging API is removed from the global object AND its prototype chain;
 *  2. user code runs in strict mode inside a function whose scope contains only what the host chose to provide;
 *  3. the only channel to the outside is a MessagePort the host handed over; a call is answered by the host's
 *     allow-list of handlers, nothing else.
 */
(function () {
  'use strict';
  const g = self;

  // ── 1. lock the global scope down ──────────────────────────────────────────────────────────────
  const BLOCKED = [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'WebTransport',
    'EventSource',
    'importScripts',
    'Worker',
    'SharedWorker',
    'ServiceWorker',
    'ServiceWorkerContainer',
    'ServiceWorkerRegistration',
    'indexedDB',
    'IDBFactory',
    'IDBDatabase',
    'IDBRequest',
    'caches',
    'CacheStorage',
    'Cache',
    'localStorage',
    'sessionStorage',
    'BroadcastChannel',
    'RTCPeerConnection',
    'RTCDataChannel',
    'navigator',
    'WorkerNavigator',
    'Request',
    'Response',
    'Headers',
    'FileReaderSync',
    'requestFileSystem',
    'webkitRequestFileSystem',
    'webkitRequestFileSystemSync',
    'openDatabase',
    'Notification',
    'PushManager',
    'XMLHttpRequestUpload',
    'XMLHttpRequestEventTarget',
    'CookieStore',
    'cookieStore',
    'WebAssembly',
    'SharedArrayBuffer',
    'Atomics',
    'close',
    'postMessage',
    'location',
  ];
  function neutralise(obj, name) {
    if (!Object.prototype.hasOwnProperty.call(obj, name)) return;
    try {
      delete obj[name];
    } catch {
      /* non-configurable: fall through to redefine */
    }
    if (Object.prototype.hasOwnProperty.call(obj, name)) {
      try {
        Object.defineProperty(obj, name, {
          get() {
            throw new Error(name + ' is not available in the sandbox');
          },
          configurable: false,
        });
      } catch {
        /* nothing more we can do for this property */
      }
    }
  }
  // Keep what the runtime itself needs before it disappears.
  const realSetTimeout = g.setTimeout.bind(g);
  const realClearTimeout = g.clearTimeout.bind(g);
  const realStringify = JSON.stringify;
  for (let o = g; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const n of BLOCKED) neutralise(o, n);
  // Event handlers on the global (onmessage …) cannot be used to receive anything but our own port traffic.
  g.onmessage = null;

  // ── 2. the RPC channel ─────────────────────────────────────────────────────────────────────────
  let port = null;
  let nextId = 1;
  const pending = new Map(); // call id -> {resolve, reject}
  const callbacks = new Map(); // callback id -> function (kept by user code through `cb()`)
  let nextCb = 1;
  let scope = null; // provided by the mode prelude
  const logs = [];

  function send(msg) {
    port.postMessage(msg);
  }
  function call(method, args) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ t: 'call', id, m: method, a: args });
    });
  }
  function cb(fn) {
    const id = nextCb++;
    callbacks.set(id, fn);
    return { __cb: id };
  }
  function log(level, parts) {
    const text = parts
      .map((p) => {
        try {
          return typeof p === 'string' ? p : realStringify(p);
        } catch {
          return String(p);
        }
      })
      .join(' ');
    logs.push([level, text.length > 2000 ? text.slice(0, 2000) + '…' : text]);
    send({ t: 'log', level, text: text.length > 2000 ? text.slice(0, 2000) + '…' : text });
  }
  const consoleShim = Object.freeze({
    log: (...a) => log('log', a),
    info: (...a) => log('log', a),
    warn: (...a) => log('warn', a),
    error: (...a) => log('error', a),
  });

  function errorText(e) {
    if (e && typeof e === 'object')
      return { message: String(e.message || e), stack: typeof e.stack === 'string' ? e.stack : '' };
    return { message: String(e), stack: '' };
  }

  // Everything a mode prelude can use. It receives (api) and returns { scope: {name: value}, finish(): result }.
  const api = { call, cb, log, console: consoleShim, setTimeout: realSetTimeout, clearTimeout: realClearTimeout };

  g.addEventListener('unhandledrejection', (ev) => {
    log('error', [
      'Unhandled promise rejection: ' + (ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason)),
    ]);
  });

  // ── 3. messages from the host ──────────────────────────────────────────────────────────────────
  async function onMessage(ev) {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'run': {
        try {
          // `prelude` is trusted text from the host; it defines the mode's scope. `code` is the untrusted user code.
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const mode = new Function('api', '"use strict";' + m.prelude)(api);
          scope = mode.scope;
          const names = Object.keys(scope);
          const fn = new AsyncFunction(...names, '"use strict";\n' + m.code);
          await fn(...names.map((n) => scope[n]));
          const result = mode.finish ? await mode.finish() : undefined;
          send({ t: 'done', id: m.id, ok: true, value: result });
        } catch (e) {
          send({ t: 'done', id: m.id, ok: false, error: errorText(e) });
        }
        break;
      }
      case 'invoke': {
        try {
          const fn = callbacks.get(m.cb);
          if (!fn) throw new Error('unknown callback');
          const value = await fn(...(m.a || []));
          send({ t: 'ret', id: m.id, ok: true, value: value === undefined ? null : value });
        } catch (e) {
          send({ t: 'ret', id: m.id, ok: false, error: errorText(e) });
        }
        break;
      }
      case 'ret': {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(m.error));
        break;
      }
      case 'forget': {
        for (const id of m.cbs || []) callbacks.delete(id);
        break;
      }
    }
  }

  // The very first message hands over the port; afterwards the global message handler is gone.
  g.addEventListener('message', function first(ev) {
    const m = ev.data;
    if (!m || m.t !== 'port' || !m.port) return;
    g.removeEventListener('message', first);
    port = m.port;
    port.onmessage = onMessage;
    send({ t: 'ready' });
  });
})();
