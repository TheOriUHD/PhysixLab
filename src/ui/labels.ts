import { Vector3, type PerspectiveCamera } from 'three';
import { h } from './dom';

interface Label { el: HTMLElement; at: Vector3 }

/** HTML labels pinned to world positions (measurements, selection tags). */
export class Labels {
  readonly layer: HTMLElement = h('div', { class: 'label-layer' });
  private labels = new Map<string, Label>();
  private tmp = new Vector3();

  set(key: string, at: Vector3, text: string, cls = ''): void {
    let l = this.labels.get(key);
    if (!l) {
      l = { el: h('div', { class: `v-label ${cls}` }), at: new Vector3() };
      this.layer.appendChild(l.el);
      this.labels.set(key, l);
    }
    l.at.copy(at);
    if (l.el.textContent !== text) l.el.textContent = text;
  }

  remove(key: string): void {
    const l = this.labels.get(key);
    if (!l) return;
    l.el.remove();
    this.labels.delete(key);
  }

  update(camera: PerspectiveCamera, width: number, height: number): void {
    for (const l of this.labels.values()) {
      this.tmp.copy(l.at).project(camera);
      const visible = this.tmp.z < 1 && this.tmp.z > -1;
      l.el.style.display = visible ? '' : 'none';
      if (visible) {
        l.el.style.left = `${((this.tmp.x + 1) / 2) * width}px`;
        l.el.style.top = `${((1 - this.tmp.y) / 2) * height}px`;
      }
    }
  }
}
