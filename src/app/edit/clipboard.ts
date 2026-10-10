/**
 * Copy / paste between scenes, tabs and apps. A copy is a versioned JSON envelope (`model/edit/clipboard.ts`) kept in
 * three places: memory (survives scene loads in this tab even when storage is unavailable), localStorage
 * (`physicslab:clipboard:v1`: survives reloads and is shared by every tab of the origin) and — best effort, when the
 * browser allows it — the system clipboard as text, so it can be pasted into another browser, window or text editor.
 *
 * Paste prefers what the user can see: text from the system clipboard when it is one of our envelopes (the DOM
 * `paste` event hands it over without any permission), otherwise localStorage, otherwise memory.
 */
import type { Vec3 } from '../../core/math';
import { SceneFormatError } from '../../model/errors';
import {
  buildClipboard,
  looksLikeClipboard,
  MAX_CLIPBOARD_CHARS,
  parseClipboard,
  planPaste,
  remapPlanAssets,
  serializeClipboard,
  type ClipboardEnvelope,
  type PasteOptions,
} from '../../model/edit/clipboard';
import { topLevel } from '../../model/groups';
import type { SceneStore } from '../../model/store';
import type { Entity } from '../../model/types';
import type { Quat } from '../../core/math';

export const CLIPBOARD_KEY = 'physicslab:clipboard:v1';

/** What the clipboard needs of the app: the document and (optionally) live poses. */
export interface ClipboardHost {
  store: SceneStore;
  sim?: { poseOf(id: string): { position: Vec3; rotation: Quat } | null };
}

export type NoticeKind = 'info' | 'success' | 'warn' | 'error';
let notifier: ((message: string, kind: NoticeKind) => void) | null = null;
/** The app routes clipboard messages (repairs, refusals) to its toast. */
export function setClipboardNotifier(fn: ((message: string, kind: NoticeKind) => void) | null): void {
  notifier = fn;
}
const notify = (message: string, kind: NoticeKind = 'info'): void => notifier?.(message, kind);

let anchor: (() => Vec3 | null) | null = null;
/** Where a plain paste lands (the pointer's ground point); the extension sets it. Null result = beside the original. */
export function setPasteAnchor(fn: (() => Vec3 | null) | null): void {
  anchor = fn;
}
export const pasteAnchor = (): Vec3 | null => anchor?.() ?? null;

/** The last copy made or read in this tab. */
let memory: ClipboardEnvelope | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface CopyResult {
  count: number;
  /** Written to localStorage (false: too large or storage unavailable; still pasteable in this tab). */
  persisted: boolean;
  text: string;
}

/** Copy the selection (or `ids`). Returns null when nothing copyable is selected. */
export function copyToClipboard(host: ClipboardHost, ids: readonly string[] = host.store.selection): CopyResult | null {
  const { store } = host;
  const valid = ids.filter((id) => store.has(id));
  const env = buildClipboard(store.all(), store.toDocument().assets, valid, store.name);
  if (!env) return null;
  memory = env;
  const text = serializeClipboard(env);
  let persisted = false;
  const st = storage();
  if (st && text.length <= MAX_CLIPBOARD_CHARS) {
    try {
      st.setItem(CLIPBOARD_KEY, text);
      persisted = true;
    } catch {
      // quota exceeded or storage blocked: the in-memory copy still works in this tab
      try {
        st.removeItem(CLIPBOARD_KEY);
      } catch {
        /* nothing more to do */
      }
    }
  } else if (st) {
    // an older, smaller copy must not be pasted instead of this one in another tab
    try {
      st.removeItem(CLIPBOARD_KEY);
    } catch {
      /* ignore */
    }
  }
  writeSystemClipboard(text);
  const count = topLevel((id) => store.get(id), valid).length;
  return { count, persisted, text };
}

/** Best effort: the system clipboard may be unavailable or refuse (permissions, insecure context). Never throws. */
export function writeSystemClipboard(text: string): void {
  try {
    const nav = typeof navigator === 'undefined' ? undefined : navigator;
    if (!nav?.clipboard?.writeText || text.length > MAX_CLIPBOARD_CHARS) return;
    void nav.clipboard.writeText(text).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/** The stored envelope text (localStorage), if any. */
export function storedClipboardText(): string | null {
  try {
    return storage()?.getItem(CLIPBOARD_KEY) ?? null;
  } catch {
    return null;
  }
}

export function hasClipboard(): boolean {
  return !!memory || !!storedClipboardText();
}

/** Forget the in-memory copy (tests; also what "a fresh tab" looks like). */
export function resetClipboardMemory(): void {
  memory = null;
}

/** Sanitise clipboard text. Null when it is not ours; refusals (too big / too new) are reported and give null. */
export function readClipboardText(text: string | null | undefined): ClipboardEnvelope | null {
  if (!text || !looksLikeClipboard(text)) return null;
  try {
    const parsed = parseClipboard(text);
    if (!parsed) return null;
    if (parsed.report.warnings.length) notify(`Clipboard repaired: ${parsed.report.warnings.join(' ')}`, 'warn');
    return parsed.envelope;
  } catch (e) {
    notify(e instanceof SceneFormatError ? e.message : 'The clipboard could not be read.', 'error');
    return null;
  }
}

export interface PasteResult {
  /** Top-level pasted ids (now the selection). */
  ids: string[];
  /** Pasted objects including everything inside groups, and joints. */
  total: number;
  /** Joints that were attached to the world because their far end was not copied. */
  connections: number;
}

/** Add an envelope's objects (and assets) to the scene as one undo step and select them. */
export function pasteEnvelope(
  host: ClipboardHost,
  env: ClipboardEnvelope,
  opts: PasteOptions = {},
): PasteResult | null {
  const { store } = host;
  const plan = planPaste(
    env,
    store.all().map((e) => e.name),
    opts,
  );
  if (!plan.entities.length) return null;
  let entities: Entity[] = plan.entities;
  store.transact('Paste', () => {
    const map = new Map<string, string>();
    for (const id of plan.assetIds) {
      const a = env.assets[id];
      if (!a) continue;
      try {
        // The store assigns id / hash / size again; identical content already in the scene is reused.
        const { id: _id, hash: _hash, bytes: _bytes, ...input } = a;
        map.set(id, store.addAsset(input, 'Paste'));
      } catch (e) {
        notify(e instanceof SceneFormatError ? e.message : 'An asset could not be pasted.', 'warn');
      }
    }
    entities = remapPlanAssets(plan, map);
    store.add(entities, 'Paste', false);
  });
  const ids = topLevel(
    (id) => store.get(id),
    entities.filter((e) => e.kind !== 'joint').map((e) => e.id),
  );
  store.setSelection(ids);
  const conn = opts.withConnections ? env.connections.length : 0;
  return { ids, total: entities.length, connections: conn };
}

/** Paste what the last copy left (memory first, then localStorage so a fresh tab or reload finds it). */
export function pasteStored(host: ClipboardHost, opts: PasteOptions = {}): PasteResult | null {
  const stored = readClipboardText(storedClipboardText());
  const env = stored ?? memory;
  if (!env) return null;
  return pasteEnvelope(host, env, opts);
}

/** Paste from text that arrived through the system clipboard; falls back to the stored copy when it is not ours. */
export function pasteText(
  host: ClipboardHost,
  text: string | null | undefined,
  opts: PasteOptions = {},
): PasteResult | null {
  const env = readClipboardText(text);
  if (env) {
    memory = env;
    return pasteEnvelope(host, env, opts);
  }
  return pasteStored(host, opts);
}

/**
 * Ask the browser for the system clipboard (may prompt for permission; `silent` skips the request unless the
 * permission was granted already). Resolves to the text or null — a denial is not an error.
 */
export async function readSystemClipboard(silent: boolean): Promise<string | null> {
  try {
    const nav = typeof navigator === 'undefined' ? undefined : navigator;
    if (!nav?.clipboard?.readText) return null;
    if (silent) {
      const status = await nav.permissions?.query({ name: 'clipboard-read' as PermissionName }).catch(() => null);
      if (!status || status.state !== 'granted') return null;
    }
    return await nav.clipboard.readText();
  } catch {
    return null;
  }
}
