/**
 * Transient annotations of the measure and joint tools: the rubber-band line in the viewport, the
 * measurement and its label, and the joint-draft state. Pure view state — nothing here is persisted.
 */
import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments, type Vector3 } from 'three';
import type { App } from './app';
import type { JointDraft, Measurement } from './appTypes';

export class MeasureTool {
  /** Active measurement, if any. */
  measure: Measurement | null = null;
  jointDraft: JointDraft | null = null;
  private readonly line: LineSegments;

  constructor(private app: App) {
    const mg = new BufferGeometry();
    mg.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
    this.line = new LineSegments(
      mg,
      new LineBasicMaterial({ color: 0x3ddcff, depthTest: false, transparent: true, toneMapped: false }),
    );
    this.line.visible = false;
    this.line.renderOrder = 997;
    this.line.frustumCulled = false;
    app.viewport.helpers.add(this.line);
  }

  cancelJointDraft(): void {
    this.jointDraft = null;
    this.line.visible = false;
  }

  clear(): void {
    this.measure = null;
    this.line.visible = false;
    this.app.labels.remove('measure');
    this.app.labels.remove('measure-a');
  }

  setLine(a: Vector3, b: Vector3): void {
    const attr = this.line.geometry.getAttribute('position');
    (attr.array as Float32Array).set([a.x, a.y, a.z, b.x, b.y, b.z]);
    attr.needsUpdate = true;
    this.line.visible = true;
  }

  /** Keep the distance label of a finished measurement at its midpoint. */
  updateLabel(): void {
    const m = this.measure;
    if (!m || !m.b) return;
    const d = m.b.clone().sub(m.a);
    const mid = m.a.clone().add(m.b).multiplyScalar(0.5);
    this.app.labels.set(
      'measure',
      mid,
      `${d.length().toFixed(3)} m   Δ ${d.x.toFixed(2)}, ${d.y.toFixed(2)}, ${d.z.toFixed(2)}`,
      'accent',
    );
  }
}
