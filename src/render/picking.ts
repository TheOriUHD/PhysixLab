import { Plane, Raycaster, Vector2, Vector3, type Camera, type Object3D } from 'three';

export interface PickHit {
  entityId: string;
  point: Vector3;
  /** World-space surface normal (bodies only). */
  normal: Vector3 | null;
  end?: 'A' | 'B';
  distance: number;
}

/** Pointer → ray helpers shared by selection, placement, grabbing and measuring. */
export class Picker {
  private ray = new Raycaster();
  private ndc = new Vector2();
  private plane = new Plane();

  constructor(
    private dom: HTMLElement,
    private camera: Camera,
  ) {
    this.ray.params.Line = { threshold: 0.1 };
    (this.ray.params as unknown as { Line2: { threshold: number } }).Line2 = { threshold: 10 };
  }

  private setRay(ev: { clientX: number; clientY: number }): void {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
  }

  /** Closest entity under the pointer among the given objects. */
  pick(ev: { clientX: number; clientY: number }, targets: Object3D[]): PickHit | null {
    this.setRay(ev);
    const hits = this.ray.intersectObjects(targets, false);
    for (const h of hits) {
      const id = h.object.userData.entityId as string | undefined;
      if (!id) continue;
      return {
        entityId: id,
        point: h.point.clone(),
        normal: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null,
        end: h.object.userData.end as 'A' | 'B' | undefined,
        distance: h.distance,
      };
    }
    return null;
  }

  /** Point where the pointer ray meets the horizontal plane y = height. */
  groundPoint(ev: { clientX: number; clientY: number }, height = 0): Vector3 | null {
    this.setRay(ev);
    this.plane.set(new Vector3(0, 1, 0), -height);
    const out = new Vector3();
    return this.ray.ray.intersectPlane(this.plane, out) ? out : null;
  }

  /** Point where the pointer ray meets the plane through `point` facing the camera. */
  cameraPlanePoint(ev: { clientX: number; clientY: number }, point: Vector3): Vector3 | null {
    this.setRay(ev);
    const n = this.camera.getWorldDirection(new Vector3()).negate();
    this.plane.setFromNormalAndCoplanarPoint(n, point);
    const out = new Vector3();
    return this.ray.ray.intersectPlane(this.plane, out) ? out : null;
  }

  /** Point on a vertical plane through `point` that contains the camera's horizontal view direction. */
  verticalPoint(ev: { clientX: number; clientY: number }, point: Vector3): Vector3 | null {
    this.setRay(ev);
    const dir = this.camera.getWorldDirection(new Vector3());
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) return null;
    dir.normalize().negate();
    this.plane.setFromNormalAndCoplanarPoint(dir, point);
    const out = new Vector3();
    return this.ray.ray.intersectPlane(this.plane, out) ? out : null;
  }

  rayDirection(ev: { clientX: number; clientY: number }): Vector3 {
    this.setRay(ev);
    return this.ray.ray.direction.clone();
  }

  rayOrigin(ev: { clientX: number; clientY: number }): Vector3 {
    this.setRay(ev);
    return this.ray.ray.origin.clone();
  }
}
