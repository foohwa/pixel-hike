import { Decoder, Stream } from '@garmin/fitsdk';
import type { ParsedTrack, RawPoint } from './gpx';

const SEMI = 180 / 2 ** 31;

/** Parse a FIT activity file (Suunto, Garmin, Coros…) into the same shape as GPX. */
export function parseFit(buf: ArrayBuffer): ParsedTrack {
  const decoder = new Decoder(Stream.fromArrayBuffer(buf));
  if (!decoder.isFIT()) throw new Error('That file is not a FIT file.');
  const { messages, errors } = decoder.read({ convertDateTimesToDates: true, applyScaleAndOffset: true, mergeHeartRates: true });
  if (errors.length) console.warn('FIT decode warnings', errors);

  const points: RawPoint[] = [];
  for (const r of messages.recordMesgs ?? []) {
    if (r.positionLat == null || r.positionLong == null) continue;
    const ts = r.timestamp as unknown;
    const time = ts instanceof Date ? ts.getTime() : typeof ts === 'number' ? ts * 1000 + 631065600000 : null;
    const ele = (r.enhancedAltitude ?? r.altitude) as number | undefined;
    points.push({
      lat: (r.positionLat as number) * SEMI,
      lon: (r.positionLong as number) * SEMI,
      ele: Number.isFinite(ele) ? (ele as number) : null,
      time,
      hr: r.heartRate ? (r.heartRate as number) : null,
      temp: r.temperature != null ? (r.temperature as number) : null,
    });
  }
  if (points.length === 0) throw new Error('This FIT file has no GPS points.');

  const s = messages.sessionMesgs?.[0];
  const sport = [s?.sport, s?.subSport].filter((v) => v && v !== 'generic').join('_').toLowerCase() || undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    name: sportName(sport),
    points,
    sport,
    session: s
      ? {
          distance: num(s.totalDistance),
          ascent: num(s.totalAscent),
          descent: num(s.totalDescent),
          calories: num(s.totalCalories),
          avgHr: num(s.avgHeartRate),
          maxHr: num(s.maxHeartRate),
          avgTemp: num(s.avgTemperature),
        }
      : undefined,
  };
}

function sportName(sport?: string) {
  if (!sport) return 'My Activity';
  if (sport.includes('trail')) return 'Trail Run';
  if (sport.includes('running')) return 'Run';
  if (sport.includes('hiking')) return 'Hiking';
  if (sport.includes('walking')) return 'Walk';
  return sport.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
