/**
 * DT-23 — shows what the other peers have selected: a coloured outline with the peer's name around each of their
 * selected objects, drawn in a DOM layer over the viewport (no three.js resources). A small status chip
 * ("Live · 2 peers") opens the Collaborate dialog. The layer only runs (requestAnimationFrame) while a session is
 * active and at least one remote peer has something selected.
 */
import { Vector3 } from 'three';
import type { App } from '../app/app';
import { runCommand } from '../app/registry';
import { shapeBoundingRadius } from '../model/shapeRegistry';
import { h } from './dom';
import type { CollabController } from './collabController';

interface Box {
  seen: number;
  el: HTMLElement;
  label: HTMLElement;
}

export class CollabCursors {
  private readonly layer = h('div', { class: 'collab-layer', 'aria-hidden': 'true' });
  private readonly chip = h('button', { class: 'collab-chip', type: 'button', title: 'Open the Collaborate dialog' });
  private readonly boxes = new Map<string, Box>();
  private raf = 0;
  private frameNo = 0;
  private shown = false;
  private readonly v = new Vector3();

  constructor(
    private readonly app: App,
    private readonly ctl: CollabController,
  ) {
    this.chip.addEventListener('click', () => runCommand('collab.open', app, 'button'));
    ctl.on('change', () => this.refresh());
  }

  show(): void {
    if (this.shown) return;
    this.shown = true;
    const host = this.app.viewport.dom.parentElement;
    host?.append(this.layer, this.chip);
    this.refresh();
  }

  hide(): void {
    this.shown = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.layer.remove();
    this.chip.remove();
    this.boxes.clear();
    this.layer.replaceChildren();
  }

  private refresh(): void {
    const s = this.ctl.session;
    if (!this.shown || !s) return;
    const n = s.peers.length;
    this.chip.textContent = `${s.role === 'host' ? 'Hosting' : 'Guest'} · ${s.status === 'live' ? `${n} peer${n === 1 ? '' : 's'}` : s.status}`;
    this.chip.dataset.status = s.status;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    this.raf = 0;
    const s = this.ctl.session;
    if (!this.shown || !s) return;
    const { camera, dom } = this.app.viewport;
    const w = dom.clientWidth;
    const hgt = dom.clientHeight;
    const frameNo = ++this.frameNo;
    let used = 0;
    for (const p of s.peers) {
      for (const id of p.selection) {
        const ent = this.app.store.get(id);
        const pose = this.app.sim.poseOf(id);
        const pos = pose?.position ?? (ent && 'position' in ent ? ent.position : null);
        if (!ent || !pos) continue;
        this.v.set(pos[0], pos[1], pos[2]).project(camera);
        if (this.v.z > 1) continue; // behind the camera
        const x = (this.v.x * 0.5 + 0.5) * w;
        const y = (-this.v.y * 0.5 + 0.5) * hgt;
        const radius = ent.kind === 'body' ? shapeBoundingRadius(ent.shape) : 0.4;
        const dist = Math.max(0.1, camera.position.distanceTo(this.v.set(pos[0], pos[1], pos[2])));
        const px = Math.max(
          18,
          Math.min(300, ((radius * 2.2) / (2 * dist * Math.tan((camera.fov * Math.PI) / 360))) * hgt),
        );
        const key = `${p.site}/${id}`;
        used++;
        let b = this.boxes.get(key);
        if (!b) {
          const label = h('span', { class: 'collab-label' });
          const el = h('div', { class: 'collab-outline' }, label);
          this.layer.appendChild(el);
          b = { el, label, seen: frameNo };
          this.boxes.set(key, b);
        }
        b.seen = frameNo;
        b.label.textContent = p.name;
        b.el.dataset.peer = p.site;
        b.el.dataset.entity = id;
        b.el.style.setProperty('--peer', p.color);
        b.el.style.width = b.el.style.height = `${px}px`;
        b.el.style.transform = `translate(${x - px / 2}px, ${y - px / 2}px)`;
      }
    }
    for (const [key, b] of this.boxes)
      if (b.seen !== frameNo) {
        b.el.remove();
        this.boxes.delete(key);
      }
    // Keep animating only while someone else has a selection (the camera may move under it).
    if (used) this.raf = requestAnimationFrame(() => this.frame());
  }
}
