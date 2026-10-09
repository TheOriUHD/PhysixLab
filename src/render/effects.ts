/** Short-lived visual effects (blast shockwaves, placement pings). */
import { AdditiveBlending, Group, Mesh, MeshBasicMaterial, RingGeometry, SphereGeometry, Vector3 } from 'three';

interface Fx {
  mesh: Mesh;
  age: number;
  life: number;
  maxScale: number;
  kind: 'shock' | 'ping';
}

export class Effects {
  private fx: Fx[] = [];
  private sphere = new SphereGeometry(1, 28, 18);
  private ring = new RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);

  constructor(private group: Group) {}

  shockwave(at: Vector3, radius: number): void {
    const mat = new MeshBasicMaterial({
      color: 0xffa347,
      transparent: true,
      opacity: 0.55,
      blending: AdditiveBlending,
      depthWrite: false,
      wireframe: true,
    });
    const mesh = new Mesh(this.sphere, mat);
    mesh.position.copy(at);
    mesh.scale.setScalar(0.1);
    mesh.renderOrder = 995;
    this.group.add(mesh);
    this.fx.push({ mesh, age: 0, life: 0.55, maxScale: radius, kind: 'shock' });
    const flash = new Mesh(
      this.sphere,
      new MeshBasicMaterial({
        color: 0xfff1c9,
        transparent: true,
        opacity: 0.9,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    flash.position.copy(at);
    flash.scale.setScalar(0.2);
    flash.renderOrder = 996;
    this.group.add(flash);
    this.fx.push({ mesh: flash, age: 0, life: 0.22, maxScale: radius * 0.22, kind: 'shock' });
  }

  ping(at: Vector3, color = 0x3ddcff): void {
    const mat = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      side: 2,
    });
    const mesh = new Mesh(this.ring, mat);
    mesh.position.copy(at);
    mesh.position.y += 0.02;
    mesh.scale.setScalar(0.1);
    mesh.renderOrder = 996;
    this.group.add(mesh);
    this.fx.push({ mesh, age: 0, life: 0.5, maxScale: 0.8, kind: 'ping' });
  }

  update(dt: number): boolean {
    if (!this.fx.length) return false;
    for (const f of this.fx) {
      f.age += dt;
      const t = Math.min(1, f.age / f.life);
      const e = 1 - Math.pow(1 - t, 3);
      f.mesh.scale.setScalar(Math.max(0.05, f.maxScale * e));
      (f.mesh.material as MeshBasicMaterial).opacity = (f.kind === 'ping' ? 0.9 : 0.6) * (1 - t);
    }
    this.fx = this.fx.filter((f) => {
      if (f.age >= f.life) {
        this.group.remove(f.mesh);
        (f.mesh.material as MeshBasicMaterial).dispose();
        return false;
      }
      return true;
    });
    return true;
  }
}
