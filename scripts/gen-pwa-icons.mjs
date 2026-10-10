#!/usr/bin/env node
/**
 * DT-40: generate the PWA icons deterministically (no image tools, no dependencies): `node scripts/gen-pwa-icons.mjs`.
 * Draws the same mark as the favicon in index.html (a trajectory arc ending in a ball) with an analytic
 * signed-distance rasteriser (4x4 supersampling) and writes real PNGs + an SVG into public/icons/.
 * The output is checked in; re-running must leave the working tree unchanged.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const BG = [0x0b, 0x0e, 0x14]; // --bg of src/styles/app.css
const ARC = [0x5e, 0xea, 0xd4];
const BALL = [0x38, 0xbd, 0xf8];

// The mark lives in a 32x32 box: arc  M7 22 c3-1 5-6 8-11 s6-4 10-1  and a ball at (15, 11) r 3.2.
const bez = (p0, p1, p2, p3, n) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const u = 1 - t;
    const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [0, 1].map((a) => k[0] * p0[a] + k[1] * p1[a] + k[2] * p2[a] + k[3] * p3[a]);
  });
const seg1 = bez([7, 22], [10, 21], [12, 16], [15, 11], 40);
const seg2 = bez([15, 11], [18, 6], [21, 7], [25, 10], 40); // `s`: first control point mirrors (12,16) about (15,11)
const ARC_PTS = [...seg1, ...seg2.slice(1)];
const distSeg = (px, py, a, b) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
};
const distArc = (x, y) => {
  let d = Infinity;
  for (let i = 0; i + 1 < ARC_PTS.length; i++) d = Math.min(d, distSeg(x, y, ARC_PTS[i], ARC_PTS[i + 1]));
  return d;
};

/** Colour of the icon at 32-unit coordinates (x, y), or null outside the shape. `s` scales the mark about the centre. */
function sample(x, y, { rounded, s }) {
  if (rounded) {
    // rounded square, corner radius 8 of 32
    const cx = Math.min(Math.max(x, 8), 24);
    const cy = Math.min(Math.max(y, 8), 24);
    if (Math.hypot(x - cx, y - cy) > 8) return null;
  }
  const mx = (x - 16) / s + 16;
  const my = (y - 16) / s + 16;
  if (Math.hypot(mx - 15, my - 11) <= 3.2) return BALL;
  if (distArc(mx, my) <= 1) return ARC;
  return BG;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, opts) {
  const SS = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < SS; j++)
        for (let i = 0; i < SS; i++) {
          const c = sample(((x + (i + 0.5) / SS) * 32) / size, ((y + (j + 0.5) / SS) * 32) / size, opts);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 1;
          }
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (a) {
        raw[o] = Math.round(r / a);
        raw[o + 1] = Math.round(g / a);
        raw[o + 2] = Math.round(b / a);
      }
      raw[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const files = {
  'icon-192.png': png(192, { rounded: true, s: 1 }),
  'icon-512.png': png(512, { rounded: true, s: 1 }),
  // Maskable: full-bleed background, mark inside the central safe zone (the OS crops to a circle / squircle).
  'icon-maskable-512.png': png(512, { rounded: false, s: 0.72 }),
  // iOS rounds the corners itself and does not like transparency.
  'apple-touch-icon.png': png(180, { rounded: false, s: 0.9 }),
  'icon.svg':
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0b0e14"/>` +
    `<path d="M7 22c3-1 5-6 8-11s6-4 10-1" stroke="#5eead4" stroke-width="2" fill="none" stroke-linecap="round"/>` +
    `<circle cx="15" cy="11" r="3.2" fill="#38bdf8"/></svg>\n`,
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(path.join(out, name), data);
  console.log(`icons/${name}  ${data.length} bytes`);
}
