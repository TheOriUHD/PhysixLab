/**
 * The 3D cursor marker: a small three-axis cross with a ring, drawn on top of the scene at `pivotState.cursor`
 * once the cursor has been placed or while the pivot mode is "3D cursor". Created lazily by `initPivot(app)`.
 */
import type { Object3D } from 'three';
import {
  BufferGeometry,
  CircleGeometry,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
} from 'three';
import type { App } from '../app';
import { onPivotState, pivotState } from './pivotState';

const SIZE = 0.35;

class CursorView {
  readonly root = new Group();
  private geometries: BufferGeometry[] = [];
  private materials: LineBasicMaterial[] = [];

  constructor(private app: App) {
    this.root.name = '3d-cursor';
    this.root.renderOrder = 999;
    this.root.visible = false;
    const axes: [number, number, number][] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const colours = [0xff5d5d, 0x5be3a1, 0x5d9bff];
    axes.forEach((a, i) => {
      const g = new BufferGeometry();
      g.setAttribute(
        'position',
        new Float32BufferAttribute(
          [-a[0] * SIZE, -a[1] * SIZE, -a[2] * SIZE, a[0] * SIZE, a[1] * SIZE, a[2] * SIZE],
          3,
        ),
      );
      this.add(new LineSegments(g, this.material(colours[i])), g);
    });
    // A ring in the horizontal plane makes the cursor readable against any background.
    const ringSrc = new CircleGeometry(SIZE * 0.55, 40);
    const ring = new EdgesGeometry(ringSrc, 1);
    ringSrc.dispose();
    ring.rotateX(-Math.PI / 2);
    this.add(new LineSegments(ring, this.material(0xffffff)), ring);
    app.viewport.scene.add(this.root);
    this.sync();
  }

  private material(color: number): LineBasicMaterial {
    const m = new LineBasicMaterial({ color, depthTest: false, transparent: true });
    this.materials.push(m);
    return m;
  }

  private add(o: Object3D, g: BufferGeometry): void {
    o.renderOrder = 999;
    this.geometries.push(g);
    this.root.add(o);
  }

  sync(): void {
    const show = pivotState.cursorPlaced || this.app.prefs.value.pivotMode === 'cursor';
    this.root.visible = show;
    this.root.position.set(...pivotState.cursor);
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}

const views = new WeakMap<App, CursorView>();

/** Create the cursor marker for `app` (once) and keep it in sync with the pivot state and the pivot-mode preference. */
export function initCursorView(app: App): void {
  if (views.has(app)) return;
  const view = new CursorView(app);
  views.set(app, view);
  onPivotState(() => {
    view.sync();
    if (app.prefs.value.pivotMode === 'cursor') app.gizmos.refresh(); // the handle sits on the cursor
  });
  app.prefs.on('change', (keys) => {
    if (keys.includes('pivotMode')) view.sync();
  });
}
