/**
 * DT-23 — wires a collaboration `Session` (src/collab) to the running app: the simulation adapter, transports,
 * toasts, and the remote-selection overlay. One controller per App (`getCollab`). The dialog (collabDialog.ts)
 * only talks to the controller.
 */
import type { App } from '../app/app';
import { Emitter } from '../core/events';
import { Session, type SimBridge, type SimMode } from '../collab/session';
import { BroadcastLink, WebRtcLink, isRoomCode, newRoomCode, type Link } from '../collab/transport';
import { CollabCursors } from './collabCursors';

interface ControllerEvents extends Record<string, unknown> {
  change: undefined;
}

/** The simulation controller as a `SimBridge`. */
export function simBridge(app: App): SimBridge {
  const sim = app.sim;
  return {
    mode: () => sim.mode,
    onMode: (cb) => sim.on('mode', cb),
    set(m: SimMode) {
      if (m === sim.mode) return;
      if (m === 'edit') sim.reset();
      else if (m === 'running') sim.play();
      else if (sim.mode === 'running') sim.pause();
      else {
        sim.play(); // paused from edit: build the world, then hold it
        sim.pause();
      }
    },
  };
}

export class CollabController extends Emitter<ControllerEvents> {
  session: Session | null = null;
  room: string | null = null;
  /** The pending WebRTC guest link (answer created, waiting for the host to connect). */
  private pendingGuestLink: Link | null = null;
  private cursors: CollabCursors;
  name = 'Me';

  constructor(readonly app: App) {
    super();
    this.cursors = new CollabCursors(app, this);
  }

  get active(): boolean {
    return !!this.session && this.session.status !== 'closed' && this.session.status !== 'idle';
  }

  private make(role: 'host' | 'guest'): Session {
    this.leave();
    const s = new Session({
      store: this.app.store,
      sim: simBridge(this.app),
      name: this.name.trim() || (role === 'host' ? 'Host' : 'Guest'),
    });
    s.on('notice', (t) => this.app.toast(t, 'warn'));
    s.on('peers', () => this.emit('change', undefined));
    s.on('status', (st) => {
      if (st === 'live')
        this.app.toast(role === 'host' ? 'Collaboration session started.' : 'Joined the session.', 'info');
      if (st === 'closed') this.cursors.hide();
      else this.cursors.show();
      this.emit('change', undefined);
    });
    this.session = s;
    return s;
  }

  /** Host a session; same-device tabs can join with the returned room code right away. */
  startHost(): string {
    const s = this.make('host');
    this.room = newRoomCode();
    s.startHost();
    s.addLink(new BroadcastLink(this.room));
    this.emit('change', undefined);
    return this.room;
  }

  /** Host: create a WebRTC invitation (offer). `accept` takes the guest's answer. */
  async invite(): Promise<{ offer: string; accept: (answer: string) => Promise<void> }> {
    const s = this.session;
    if (!s || s.role !== 'host') throw new Error('Start hosting first.');
    const { link, offer } = await WebRtcLink.createOffer();
    s.addLink(link);
    return { offer, accept: (answer) => link.acceptAnswer(answer) };
  }

  /** Guest: join a room of this browser (another tab). */
  joinRoom(room: string): void {
    const code = room.trim();
    if (!isRoomCode(code)) throw new Error('A room code is 4-32 letters or digits.');
    const s = this.make('guest');
    this.room = code;
    s.join(new BroadcastLink(code));
    this.emit('change', undefined);
  }

  /** Guest over WebRTC: returns the answer to send to the host; the session starts when the link opens. */
  async answerOffer(offer: string): Promise<string> {
    this.leave();
    const { link, answer } = await WebRtcLink.acceptOffer(offer);
    this.pendingGuestLink = link;
    link.on('open', () => {
      if (this.pendingGuestLink !== link) return;
      this.pendingGuestLink = null;
      const s = this.make('guest');
      s.join(link);
      this.emit('change', undefined);
    });
    return answer;
  }

  leave(): void {
    this.pendingGuestLink?.close();
    this.pendingGuestLink = null;
    const s = this.session;
    this.session = null;
    this.room = null;
    s?.leave();
    this.cursors.hide();
    this.emit('change', undefined);
  }
}

const controllers = new WeakMap<App, CollabController>();

export function getCollab(app: App): CollabController {
  let c = controllers.get(app);
  if (!c) {
    c = new CollabController(app);
    controllers.set(app, c);
    // A debugging / e2e handle, like `window.physicslab`.
    (window as unknown as { physicslabCollab: CollabController }).physicslabCollab = c;
  }
  return c;
}
