/**
 * Just enough EXIF to place a photo on the track: when it was taken (DateTimeOriginal + its UTC
 * offset when the camera wrote one) and where (GPS). JPEG only; anything else returns {}.
 */
export interface PhotoMeta {
  /** "YYYY-MM-DD HH:MM:SS" local camera time, as written. */
  localTime?: string;
  /** Minutes east of UTC for localTime, when the camera stored it (phones usually do). */
  offsetMin?: number;
  lat?: number;
  lon?: number;
}

export function readExif(buf: ArrayBuffer): PhotoMeta {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return {};
  let p = 2;
  while (p + 4 <= v.byteLength) {
    if (v.getUint8(p) !== 0xff) return {};
    const marker = v.getUint8(p + 1);
    const len = v.getUint16(p + 2);
    if (marker === 0xe1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966 /* Exif */) {
      try {
        return parseTiff(v, p + 10, Math.min(v.byteLength, p + 2 + len));
      } catch {
        return {};
      }
    }
    if (marker === 0xda || marker === 0xd9) return {}; // image data: no EXIF before it
    p += 2 + len;
  }
  return {};
}

function parseTiff(v: DataView, base: number, end: number): PhotoMeta {
  const le = v.getUint16(base) === 0x4949;
  const u16 = (o: number) => v.getUint16(base + o, le);
  const u32 = (o: number) => v.getUint32(base + o, le);
  if (u16(2) !== 42) return {};
  const ascii = (o: number, n: number) => {
    let s = '';
    for (let i = 0; i < n && base + o + i < end; i++) {
      const c = v.getUint8(base + o + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  /** Tag → [type, count, value offset (or inline offset)] for one IFD. */
  const ifd = (o: number) => {
    const tags = new Map<number, { type: number; count: number; at: number }>();
    if (!o || base + o + 2 > end) return tags;
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      if (base + e + 12 > end) break;
      const type = u16(e + 2), count = u32(e + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
      tags.set(u16(e), { type, count, at: size * count > 4 ? u32(e + 8) : e + 8 });
    }
    return tags;
  };
  const str = (t?: { count: number; at: number }) => (t ? ascii(t.at, t.count) : undefined);
  const rat = (at: number) => {
    const d = u32(at + 4);
    return d ? u32(at) / d : 0;
  };
  const dms = (t?: { at: number }) => (t ? rat(t.at) + rat(t.at + 8) / 60 + rat(t.at + 16) / 3600 : undefined);

  const out: PhotoMeta = {};
  const ifd0 = ifd(u32(4));
  const exif = ifd(ifd0.get(0x8769) ? u32(ifd0.get(0x8769)!.at) : 0);
  const dt = str(exif.get(0x9003)) ?? str(exif.get(0x9004)) ?? str(ifd0.get(0x0132));
  const m = dt?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) out.localTime = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  const off = str(exif.get(0x9011)) ?? str(exif.get(0x9010));
  const om = off?.match(/^([+-])(\d{2}):(\d{2})/);
  if (om) out.offsetMin = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3]));

  const gps = ifd(ifd0.get(0x8825) ? u32(ifd0.get(0x8825)!.at) : 0);
  const lat = dms(gps.get(2)), lon = dms(gps.get(4));
  if (lat != null && lon != null && (lat || lon)) {
    out.lat = str(gps.get(1)) === 'S' ? -lat : lat;
    out.lon = str(gps.get(3)) === 'W' ? -lon : lon;
  }
  return out;
}

/** Epoch ms for a camera's local time string, given minutes east of UTC. */
export function localToEpoch(local: string, offsetMin: number): number {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)!;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - offsetMin * 60000;
}
