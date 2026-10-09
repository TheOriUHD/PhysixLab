import { h } from './dom';
import { icon } from './icons';

export interface ModalOptions {
  title: string;
  body: HTMLElement | HTMLElement[];
  footer?: HTMLElement[];
  width?: string;
  onClose?: () => void;
}

export function openModal(o: ModalOptions): { close(): void; el: HTMLElement } {
  const close = () => {
    back.remove();
    window.removeEventListener('keydown', onKey, true);
    o.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Close (Esc)' }, icon('close'));
  closeBtn.addEventListener('click', close);
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: o.width ? { width: o.width } : undefined },
    h('div', { class: 'modal-head' }, h('h3', null, o.title), closeBtn),
    h('div', { class: 'modal-body' }, o.body),
    o.footer ? h('div', { class: 'modal-foot' }, o.footer) : null);
  const back = h('div', { class: 'modal-back' }, modal);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  window.addEventListener('keydown', onKey, true);
  return { close, el: modal };
}

/** Prompt for a single line of text. */
export function promptText(title: string, label: string, initial: string, okLabel = 'OK'): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', class: 'plain', value: initial, spellcheck: false });
    let done = false;
    const finish = (v: string | null) => { if (done) return; done = true; m.close(); resolve(v); };
    const ok = h('button', { class: 'btn primary', type: 'button' }, okLabel);
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    ok.addEventListener('click', () => finish(input.value.trim() || null));
    cancel.addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(input.value.trim() || null); });
    const m = openModal({ title, width: '420px', body: [h('p', { class: 'sub', style: { marginBottom: '10px' } }, label), input], footer: [cancel, ok], onClose: () => finish(null) });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

export function confirmDialog(title: string, message: string, okLabel = 'Continue', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; m.close(); resolve(v); };
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button' }, okLabel);
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    ok.addEventListener('click', () => finish(true));
    cancel.addEventListener('click', () => finish(false));
    const m = openModal({ title, width: '420px', body: [h('p', { class: 'sub' }, message)], footer: [cancel, ok], onClose: () => finish(false) });
    setTimeout(() => ok.focus(), 30);
  });
}
