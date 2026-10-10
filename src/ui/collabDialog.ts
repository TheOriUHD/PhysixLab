/**
 * DT-23 — the Collaborate dialog: host a session, join one (same-device room code, or WebRTC with copy/paste
 * connection codes), see the peers, leave. All behaviour lives in `CollabController` / `Session`.
 */
import type { App } from '../app/app';
import { clear, h } from './dom';
import { openModal } from './modal';
import { getCollab } from './collabController';

async function copyText(text: string, field?: HTMLTextAreaElement | HTMLInputElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    field?.select();
    return false;
  }
}

const note = (text: string, cls = 'collab-note') => h('p', { class: cls }, text);

function codeBox(readonly: boolean, placeholder: string, id: string): HTMLTextAreaElement {
  return h('textarea', {
    class: 'collab-code',
    id,
    rows: 3,
    readOnly: readonly,
    spellcheck: false,
    placeholder,
    'aria-label': placeholder,
  });
}

export function openCollabDialog(app: App): void {
  const ctl = getCollab(app);
  const status = h('div', { class: 'collab-status', 'aria-live': 'polite' });
  const web = h('div', { class: 'collab-web' });
  const nameInput = h('input', {
    type: 'text',
    class: 'plain',
    id: 'collab-name',
    value: ctl.name,
    maxLength: 24,
    spellcheck: false,
    'aria-label': 'Your display name',
  });
  nameInput.addEventListener('input', () => (ctl.name = nameInput.value));
  nameInput.addEventListener('keydown', (e) => e.stopPropagation());

  const body = h(
    'div',
    { class: 'collab-dialog' },
    note(
      'Edit one scene together. One person hosts, the others join. Edits, selections and the simulation are shared directly between the browsers - there is no server.',
    ),
    h('label', { class: 'collab-field' }, h('span', null, 'Your name'), nameInput),
    status,
    web,
  );
  openModal({ title: 'Collaborate', body, width: 'min(640px, calc(100vw - 32px))', onClose: () => off() });

  const renderStatus = () => {
    clear(status);
    const s = ctl.session;
    if (!s || s.status === 'closed' || s.status === 'idle') {
      const room = h('input', {
        type: 'text',
        class: 'plain',
        id: 'collab-room',
        placeholder: 'Room code',
        maxLength: 32,
        spellcheck: false,
        'aria-label': 'Room code of the session to join',
      });
      room.addEventListener('keydown', (e) => e.stopPropagation());
      const host = h('button', { class: 'btn primary', type: 'button', id: 'collab-host' }, 'Host a session');
      host.title = 'Share the current scene; other tabs and (with a connection code) other computers can join';
      host.addEventListener('click', () => {
        ctl.startHost();
      });
      const join = h('button', { class: 'btn', type: 'button', id: 'collab-join' }, 'Join');
      join.addEventListener('click', () => {
        try {
          ctl.joinRoom(room.value);
        } catch (e) {
          app.toast((e as Error).message, 'warn');
        }
      });
      status.append(
        h(
          'div',
          { class: 'collab-cards' },
          h(
            'div',
            { class: 'collab-card' },
            h('h4', null, 'Host'),
            note('Starts a session from the scene you have open now.'),
            host,
          ),
          h(
            'div',
            { class: 'collab-card' },
            h('h4', null, 'Join in this browser'),
            note("Joining replaces your scene with the host's."),
            h('div', { class: 'collab-row' }, room, join),
          ),
        ),
      );
      return;
    }
    const leave = h('button', { class: 'btn danger', type: 'button', id: 'collab-leave' }, 'Leave session');
    leave.addEventListener('click', () => ctl.leave());
    const head = h(
      'div',
      { class: 'collab-row' },
      h('strong', { id: 'collab-state' }, `${s.role === 'host' ? 'Hosting' : 'Guest'} - ${s.status}`),
      ctl.room
        ? h(
            'span',
            { class: 'collab-room', id: 'collab-room-code', title: 'Room code for tabs of this browser' },
            ctl.room,
          )
        : null,
      leave,
    );
    const list = h('ul', { class: 'collab-peers', id: 'collab-peers' });
    list.append(
      h(
        'li',
        null,
        h('i', { class: 'collab-dot', style: { background: 'var(--accent)' } }),
        `${s.name} (you, ${s.role})`,
      ),
      ...s.peers.map((p) =>
        h(
          'li',
          { dataset: { peer: p.site } },
          h('i', { class: 'collab-dot', style: { background: p.color } }),
          `${p.name} (${p.role})`,
          p.selection.length ? h('span', { class: 'collab-sel' }, ` - selecting ${p.selection.length}`) : null,
        ),
      ),
    );
    status.append(
      head,
      list,
      s.role === 'guest'
        ? note('The host controls the simulation (play, pause, reset); you can still edit and select.')
        : note('You control the simulation for everyone. Guests may edit the scene.'),
    );
  };

  const renderWeb = () => {
    clear(web);
    const s = ctl.session;
    const live = !!s && s.status !== 'closed' && s.status !== 'idle';
    const box = h('details', { class: 'collab-details', id: 'collab-webrtc' });
    box.append(h('summary', null, 'Connect another computer (WebRTC, copy and paste)'));
    box.append(
      note(
        'No server is involved, so you swap two connection codes yourself (chat, e-mail). It only works when the computers can reach each other directly (same network, or a reachable address).',
      ),
    );
    if (live && s.role === 'host') {
      const offerBox = codeBox(true, 'Your invitation code (send this to the guest)', 'collab-offer');
      const answerBox = codeBox(false, "Paste the guest's answer code here", 'collab-answer-in');
      let accept: ((a: string) => Promise<void>) | null = null;
      const make = h('button', { class: 'btn', type: 'button', id: 'collab-invite' }, 'Create invitation');
      const copy = h('button', { class: 'btn small', type: 'button' }, 'Copy');
      const connect = h('button', { class: 'btn primary', type: 'button', id: 'collab-connect' }, 'Connect');
      make.addEventListener('click', () => {
        make.disabled = true;
        ctl.invite().then(
          (r) => {
            offerBox.value = r.offer;
            accept = r.accept;
            make.disabled = false;
          },
          (e: unknown) => {
            make.disabled = false;
            app.toast((e as Error).message, 'warn');
          },
        );
      });
      copy.addEventListener(
        'click',
        () =>
          void copyText(offerBox.value, offerBox).then((ok) =>
            app.toast(ok ? 'Invitation copied.' : 'Press Ctrl+C to copy the selected code.', 'info'),
          ),
      );
      connect.addEventListener('click', () => {
        if (!accept) return app.toast('Create an invitation first.', 'warn');
        accept(answerBox.value).then(
          () => app.toast('Connecting...', 'info'),
          (e: unknown) => app.toast((e as Error).message, 'warn'),
        );
      });
      for (const t of [offerBox, answerBox]) t.addEventListener('keydown', (e) => e.stopPropagation());
      box.append(
        h('div', { class: 'collab-step' }, h('b', null, '1. '), make, copy),
        offerBox,
        h('div', { class: 'collab-step' }, h('b', null, '2. '), 'Paste the answer you get back, then ', connect),
        answerBox,
      );
    } else if (!live) {
      const offerIn = codeBox(false, "Paste the host's invitation code here", 'collab-offer-in');
      const answerOut = codeBox(true, 'Your answer code (send this back to the host)', 'collab-answer');
      const make = h('button', { class: 'btn primary', type: 'button', id: 'collab-answer-btn' }, 'Create answer');
      const copy = h('button', { class: 'btn small', type: 'button' }, 'Copy');
      make.addEventListener('click', () => {
        make.disabled = true;
        ctl.answerOffer(offerIn.value).then(
          (a) => {
            answerOut.value = a;
            make.disabled = false;
            app.toast('Send the answer code to the host. This window can stay open.', 'info');
          },
          (e: unknown) => {
            make.disabled = false;
            app.toast((e as Error).message, 'warn');
          },
        );
      });
      copy.addEventListener(
        'click',
        () =>
          void copyText(answerOut.value, answerOut).then((ok) =>
            app.toast(ok ? 'Answer copied.' : 'Press Ctrl+C to copy the selected code.', 'info'),
          ),
      );
      for (const t of [offerIn, answerOut]) t.addEventListener('keydown', (e) => e.stopPropagation());
      box.append(
        h('div', { class: 'collab-step' }, h('b', null, 'Guest: '), "paste the host's invitation, then ", make, copy),
        offerIn,
        answerOut,
      );
    } else {
      box.append(note('Leave the session to connect to a different host.'));
    }
    web.append(box);
  };

  let lastKey = '';
  const render = (): void => {
    const s = ctl.session;
    renderStatus();
    // The code boxes keep what the user typed unless the situation changes.
    const key = s ? `${s.role}/${s.status}` : 'none';
    if (key !== lastKey) {
      const open = web.querySelector<HTMLDetailsElement>('details')?.open ?? false;
      lastKey = key;
      renderWeb();
      web.querySelector<HTMLDetailsElement>('details')?.toggleAttribute('open', open || key === 'host/live');
    }
  };
  const off = ctl.on('change', render);
  render();
}
