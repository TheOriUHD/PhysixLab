/**
 * A solid of revolution meshed with exact normals: the profile's segments carry their own outward normals, shared
 * between neighbouring segments where the profile turns by less than `smoothDeg` and split where it turns more (a
 * rim between a flat cap and a flat side). Used by the rounded cylinder, whose fillets must shade smoothly into the
 * cap and the side without the "pillow" a crease-angle average would paint across the flat faces.
 */
import type { Vec3 } from '../../core/math';
import type { P2 } from './meshKit';
import type { PolyMesh} from './polyMesh';
import { type UV } from './polyMesh';

const TAU = Math.PI * 2;

/** Outward unit normal of each profile segment for a profile that runs counter-clockwise in the (radius, y) plane. */
export function segmentNormals(profile: readonly P2[]): P2[] {
  const out: P2[] = [];
  for (let j = 0; j + 1 < profile.length; j++) {
    const tr = profile[j + 1][0] - profile[j][0],
      ty = profile[j + 1][1] - profile[j][1];
    const l = Math.hypot(tr, ty) || 1;
    out.push([ty / l, -tr / l]);
  }
  return out;
}

/** Revolve `profile` about Y with `n` azimuth steps (first meridian on +X), appending triangles to `m`. */
export function latheSmooth(m: PolyMesh, profile: readonly P2[], n: number, smoothDeg: number): void {
  const segs = segmentNormals(profile);
  if (!segs.length) return;
  const cosLimit = Math.cos((smoothDeg * Math.PI) / 180);
  // normal at the start / end of each segment
  const startN: P2[] = [],
    endN: P2[] = [];
  for (let j = 0; j < segs.length; j++) {
    const here = segs[j];
    const prev = j > 0 ? segs[j - 1] : null;
    const next = j + 1 < segs.length ? segs[j + 1] : null;
    const blend = (other: P2 | null): P2 => {
      if (!other || here[0] * other[0] + here[1] * other[1] < cosLimit) return here;
      const x = here[0] + other[0],
        y = here[1] + other[1];
      const l = Math.hypot(x, y) || 1;
      return [x / l, y / l];
    };
    startN.push(blend(prev));
    endN.push(blend(next));
  }
  // arc length for the v coordinate
  const cum = [0];
  for (let j = 0; j < segs.length; j++)
    cum.push(cum[j] + Math.hypot(profile[j + 1][0] - profile[j][0], profile[j + 1][1] - profile[j][1]));
  const total = cum[cum.length - 1] || 1;
  const at = (r: number, y: number, a: number): Vec3 => [r * Math.cos(a), y, r * Math.sin(a)];
  const nrm = (n2: P2, a: number): Vec3 => [n2[0] * Math.cos(a), n2[1], n2[0] * Math.sin(a)];
  for (let j = 0; j < segs.length; j++) {
    const [r0, y0] = profile[j],
      [r1, y1] = profile[j + 1];
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * TAU,
        a1 = ((k + 1) / n) * TAU;
      const A = at(r0, y0, a0),
        B = at(r1, y1, a0),
        C = at(r0, y0, a1),
        D = at(r1, y1, a1);
      const nA = nrm(startN[j], a0),
        nB = nrm(endN[j], a0),
        nC = nrm(startN[j], a1),
        nD = nrm(endN[j], a1);
      const uvA: UV = [k / n, cum[j] / total],
        uvB: UV = [k / n, cum[j + 1] / total],
        uvC: UV = [(k + 1) / n, cum[j] / total],
        uvD: UV = [(k + 1) / n, cum[j + 1] / total];
      m.tri(A, B, C, [nA, nB, nC], [uvA, uvB, uvC]);
      m.tri(B, D, C, [nB, nD, nC], [uvB, uvD, uvC]);
    }
  }
}
