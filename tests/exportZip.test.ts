import { describe, expect, it } from 'vitest';
import { buildZip, crc32 } from '../src/app/export/zip';

describe('zip (OBJ + MTL bundle)', () => {
  it('writes stored entries whose headers, CRCs and offsets are consistent', () => {
    const a = new TextEncoder().encode('v 0 0 0\n');
    const b = new TextEncoder().encode('newmtl x\n');
    const zip = buildZip([
      { name: 'a.obj', data: a },
      { name: 'a.mtl', data: b },
    ]);
    const dv = new DataView(zip.buffer);
    const eocd = zip.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(2);
    let o = dv.getUint32(eocd + 16, true);
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      expect(dv.getUint32(o, true)).toBe(0x02014b50);
      const crc = dv.getUint32(o + 16, true);
      const size = dv.getUint32(o + 20, true);
      const nameLen = dv.getUint16(o + 28, true);
      const local = dv.getUint32(o + 42, true);
      const name = new TextDecoder().decode(zip.subarray(o + 46, o + 46 + nameLen));
      seen.push(name);
      expect(dv.getUint32(local, true)).toBe(0x04034b50);
      const data = zip.subarray(local + 30 + nameLen, local + 30 + nameLen + size);
      expect(crc32(data)).toBe(crc);
      expect(new TextDecoder().decode(data)).toBe(name.endsWith('obj') ? 'v 0 0 0\n' : 'newmtl x\n');
      o += 46 + nameLen;
    }
    expect(seen).toEqual(['a.obj', 'a.mtl']);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
