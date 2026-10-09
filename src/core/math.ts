/**
 * Minimal, allocation-light vector / quaternion helpers on plain tuples.
 * Used by the document model, the physics worker and the UI (no three.js dependency
 * so that the simulation side can run in a worker or in Node tests).
 */

export type Vec3 = [number, number, number];
/** Quaternion as [x, y, z, w]. */
export type Quat = [number, number, number, number];

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const vlen = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const vlen2 = (a: Vec3): number => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
export const vdist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const vnorm = (a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 => {
  const l = vlen(a);
  return l < 1e-12 ? ([...fallback] as Vec3) : [a[0] / l, a[1] / l, a[2] / l];
};
export const vlerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const vclone = (a: Vec3): Vec3 => [a[0], a[1], a[2]];
export const veq = (a: Vec3, b: Vec3, eps = 1e-9): boolean =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const QIDENT: Quat = [0, 0, 0, 1];
export const qident = (): Quat => [0, 0, 0, 1];
export const qclone = (q: Quat): Quat => [q[0], q[1], q[2], q[3]];

export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export function qnorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l < 1e-12 ? [0, 0, 0, 1] : [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
/** Rotate vector v by quaternion q. */
export function qrot(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
/** Rotate by the inverse of q. */
export const qrotInv = (q: Quat, v: Vec3): Vec3 => qrot(qconj(q), v);

export function qfromAxisAngle(axis: Vec3, angle: number): Quat {
  const a = vnorm(axis);
  const s = Math.sin(angle / 2);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
}

/** Shortest-arc rotation taking unit vector `from` onto unit vector `to`. */
export function qfromUnitVectors(from: Vec3, to: Vec3): Quat {
  const d = vdot(from, to);
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) {
    // 180° turn about any perpendicular axis
    let axis = vcross([1, 0, 0], from);
    if (vlen2(axis) < 1e-6) axis = vcross([0, 1, 0], from);
    axis = vnorm(axis);
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = vcross(from, to);
  return qnorm([c[0], c[1], c[2], 1 + d]);
}

export function qslerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
    return qnorm([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

/** Euler angles (radians, intrinsic XYZ — same convention as three.js default) → quaternion. */
export function qfromEuler(e: Vec3): Quat {
  const c1 = Math.cos(e[0] / 2),
    c2 = Math.cos(e[1] / 2),
    c3 = Math.cos(e[2] / 2);
  const s1 = Math.sin(e[0] / 2),
    s2 = Math.sin(e[1] / 2),
    s3 = Math.sin(e[2] / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** Quaternion → Euler angles (radians, XYZ order). */
export function qtoEuler(q: Quat): Vec3 {
  const [x, y, z, w] = qnorm(q);
  // rotation matrix elements
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - z * w);
  const m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(clamp(m13, -1, 1));
  let ex: number, ez: number;
  if (Math.abs(m13) < 0.9999999) {
    ex = Math.atan2(-m23, m33);
    ez = Math.atan2(-m12, m11);
  } else {
    ex = Math.atan2(m32, m22);
    ez = 0;
  }
  return [ex, ey, ez];
}

/** Angle (radians) of the rotation a⁻¹·b, always in [0, π]. */
export function qangle(a: Quat, b: Quat): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d));
}

/** Twist angle of rotation q about unit axis (signed, in (-π, π]). */
export function qtwist(q: Quat, axis: Vec3): number {
  const p = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
  let a = 2 * Math.atan2(p, q[3]);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function round(x: number, digits = 3): number {
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

/** Snap value to a multiple of `step` (no-op when step <= 0). */
export const snap = (x: number, step: number): number => (step > 0 ? Math.round(x / step) * step : x);
