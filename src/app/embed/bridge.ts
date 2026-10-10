/**
 * The viewer's postMessage endpoint (DT-22). Accepts commands only from the window that embeds the viewer
 * (`event.source === window.parent`), optionally only from allow-listed origins, validates every message with
 * `parseMessage`, and answers to the sender's origin. See docs/EMBED.md.
 */
import { Vector3 } from 'three';
import { SceneFormatError } from '../../model/errors';
import { getTemplate } from '../../model/content';
import { sanitizeDocument } from '../../model/serialize';
import type { App } from '../app';
import { Persistence } from '../persistence';
import type { EmbedOptions } from './options';
import {
  envelope,
  extractSharePayload,
  originAllowed,
  parseMessage,
  type EmbedEvent,
  type EmbedState,
  type ParsedCommand,
} from './protocol';

export const EMBED_CAPABILITIES = ['play', 'pause', 'reset', 'step', 'loadScene', 'setCamera', 'getState'];

export class EmbedBridge {
  /** The camera `setCamera({reset:true})` and the bar's camera button return to. */
  private home: { position: [number, number, number]; target: [number, number, number] } | null = null;
  private lastOrigin: string | null = null;
  private disposers: (() => void)[] = [];

  constructor(
    private app: App,
    private opts: EmbedOptions,
    /** The window commands must come from; `window.parent` in the real viewer. */
    private parent: Window = window.parent,
  ) {
    const onMessage = (e: MessageEvent) => void this.onMessage(e);
    window.addEventListener('message', onMessage);
    this.disposers.push(() => window.removeEventListener('message', onMessage));
    this.disposers.push(app.sim.on('mode', () => this.emitState('mode')));
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
  }

  /** Remember the current camera as "home" (call once the opening view is in place). */
  setHome(view: { position: [number, number, number]; target: [number, number, number] } | null): void {
    this.home = view;
  }

  /** Move the camera back to the opening view (or frame the whole scene when there was none). */
  resetCamera(): void {
    const h = this.home;
    if (h) {
      this.app.viewport.flyTo(new Vector3(...h.position), new Vector3(...h.target), 0.45);
    } else this.app.frameAll(false);
  }

  state(): EmbedState {
    const app = this.app;
    const view = app.viewport.getView();
    return {
      mode: app.sim.mode,
      time: app.sim.mode === 'edit' ? 0 : (app.sim.client.stats?.simTime ?? 0),
      sceneName: app.store.name,
      bodies: app.store.bodies().length,
      camera: view,
    };
  }

  /** Tell the parent the viewer is up. With an allow-list it goes only to the allow-listed parent origin. */
  announceReady(): void {
    const ev: EmbedEvent = { event: 'ready', capabilities: EMBED_CAPABILITIES, state: this.state() };
    const target = this.readyTarget();
    if (target) this.post(ev, target);
  }

  /** Where the unsolicited `ready` goes: the (known) parent origin, `*` when no allow-list is set and it is unknown. */
  private readyTarget(): string | null {
    const known = this.parentOrigin();
    if (this.opts.origins.length) return known && originAllowed(known, this.opts.origins) ? known : null;
    return known ?? '*';
  }

  private parentOrigin(): string | null {
    try {
      const ao = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
      if (ao && ao.length) return ao[0];
    } catch {
      /* ignore */
    }
    try {
      if (document.referrer) return new URL(document.referrer).origin;
    } catch {
      /* ignore */
    }
    return null;
  }

  private post(ev: EmbedEvent, targetOrigin: string, id?: string): void {
    try {
      this.parent.postMessage(envelope(ev, id), targetOrigin);
    } catch {
      /* parent gone */
    }
  }

  /** An unsolicited `error` event (the scene in the URL could not be opened …). */
  reportError(code: string, message: string): void {
    const target = this.lastOrigin ?? this.readyTarget();
    if (target) this.post({ event: 'error', code, message }, target);
  }

  /** `state` event to the last sender (or the known parent): used for mode changes. */
  private emitState(reason: string): void {
    const target = this.lastOrigin ?? this.readyTarget();
    if (target) this.post({ event: 'state', state: this.state(), reason }, target);
  }

  private reply(ev: EmbedEvent, origin: string, id?: string): void {
    // An opaque origin ("null") cannot be addressed; "*" is then the only option and the payload holds no secrets.
    this.post(ev, origin === 'null' ? '*' : origin, id);
  }

  private async onMessage(e: MessageEvent): Promise<void> {
    if (e.source !== this.parent || e.source === window) return;
    const parsed = parseMessage(e.data);
    if (parsed.kind === 'ignore') return;
    if (!originAllowed(e.origin, this.opts.origins)) return; // silently: do not even confirm that a viewer is here
    this.lastOrigin = e.origin === 'null' ? '*' : e.origin;
    if (parsed.kind === 'invalid') {
      this.reply({ event: 'error', code: 'bad-message', message: parsed.message }, e.origin, parsed.id);
      return;
    }
    try {
      await this.run(parsed.parsed, e.origin);
    } catch (err) {
      const code = err instanceof SceneFormatError ? 'bad-scene' : 'failed';
      this.reply({ event: 'error', code, message: (err as Error).message }, e.origin, parsed.parsed.id);
    }
  }

  private async run({ id, command }: ParsedCommand, origin: string): Promise<void> {
    const app = this.app;
    switch (command.cmd) {
      case 'hello':
        this.reply({ event: 'ready', capabilities: EMBED_CAPABILITIES, state: this.state() }, origin, id);
        return;
      case 'play':
        app.sim.play();
        break;
      case 'pause':
        app.sim.pause();
        break;
      case 'reset':
        app.sim.reset();
        break;
      case 'step':
        app.sim.step(command.count);
        break;
      case 'loadScene':
        await this.loadScene(command);
        break;
      case 'setCamera':
        if (command.reset) this.resetCamera();
        else {
          const v = app.viewport.getView();
          app.viewport.setView({ position: command.position ?? v.position, target: command.target ?? v.target });
        }
        break;
      case 'getState':
        break;
    }
    this.reply({ event: 'state', state: this.state(), reason: command.cmd }, origin, id);
  }

  private async loadScene(c: { template?: string; share?: string; document?: Record<string, unknown> }): Promise<void> {
    const app = this.app;
    if (c.template !== undefined) {
      const t = getTemplate(c.template);
      if (!t) throw new Error(`Unknown scene template "${c.template}"`);
      app.sim.reset();
      app.loadTemplate(c.template);
      this.setHome(t.view ?? null);
      return;
    }
    let doc;
    if (c.share !== undefined) {
      const payload = extractSharePayload(c.share);
      if (!payload) throw new Error('The share link holds no scene ("#s=…" or "#scene=…" expected)');
      doc = await Persistence.fromHash(`#${payload}`);
    } else {
      doc = sanitizeDocument(c.document);
    }
    if (!doc) throw new Error('No scene found');
    app.sim.reset();
    app.store.load(doc);
    app.frameAll(false);
    this.setHome(null);
  }
}
