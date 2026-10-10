/**
 * A minimal ZIP writer (stored entries, no compression) — enough to hand a `.obj` and its `.mtl` to the user as one
 * download. Pure TypeScript.
 */

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const names = entries.map((e) => enc.encode(e.name));
  let size = 22;
  entries.forEach((e, i) => (size += 30 + names[i].length + e.data.length + 46 + names[i].length));
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  const offsets: number[] = [];
  const crcs = entries.map((e) => crc32(e.data));
  entries.forEach((e, i) => {
    offsets.push(o);
    dv.setUint32(o, 0x04034b50, true);
    dv.setUint16(o + 4, 20, true); // version needed
    dv.setUint16(o + 6, 0x0800, true); // UTF-8 names
    dv.setUint16(o + 8, 0, true); // stored
    dv.setUint16(o + 10, 0, true); // time
    dv.setUint16(o + 12, 0x21, true); // date 1980-01-01
    dv.setUint32(o + 14, crcs[i], true);
    dv.setUint32(o + 18, e.data.length, true);
    dv.setUint32(o + 22, e.data.length, true);
    dv.setUint16(o + 26, names[i].length, true);
    dv.setUint16(o + 28, 0, true);
    out.set(names[i], o + 30);
    out.set(e.data, o + 30 + names[i].length);
    o += 30 + names[i].length + e.data.length;
  });
  const dirStart = o;
  entries.forEach((e, i) => {
    dv.setUint32(o, 0x02014b50, true);
    dv.setUint16(o + 4, 20, true);
    dv.setUint16(o + 6, 20, true);
    dv.setUint16(o + 8, 0x0800, true);
    dv.setUint16(o + 10, 0, true);
    dv.setUint16(o + 12, 0, true);
    dv.setUint16(o + 14, 0x21, true);
    dv.setUint32(o + 16, crcs[i], true);
    dv.setUint32(o + 20, e.data.length, true);
    dv.setUint32(o + 24, e.data.length, true);
    dv.setUint16(o + 28, names[i].length, true);
    dv.setUint32(o + 42, offsets[i], true);
    out.set(names[i], o + 46);
    o += 46 + names[i].length;
  });
  dv.setUint32(o, 0x06054b50, true);
  dv.setUint16(o + 8, entries.length, true);
  dv.setUint16(o + 10, entries.length, true);
  dv.setUint32(o + 12, o - dirStart, true);
  dv.setUint32(o + 16, dirStart, true);
  return out;
}
