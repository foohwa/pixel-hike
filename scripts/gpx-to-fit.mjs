// Dev helper: convert a GPX into a FIT activity to exercise the FIT import path.
// Adds a synthetic temperature track and session totals (TEST DATA ONLY).
// usage: node scripts/gpx-to-fit.mjs in.gpx out.fit [sport]
import { Encoder, Profile } from '@garmin/fitsdk';
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output, sport = 'hiking'] = process.argv;
const xml = readFileSync(input, 'utf8');
const re = /<trkpt lat="([-\d.]+)" lon="([-\d.]+)">(?:<ele>([-\d.]+)<\/ele>)?<time>([^<]+)<\/time>(?:.*?<gpxtpx:hr>(\d+))?/g;
const pts = [...xml.matchAll(re)].map((m) => ({ lat: +m[1], lon: +m[2], ele: m[3] ? +m[3] : undefined, time: new Date(m[4]), hr: m[5] ? +m[5] : undefined }));
const semi = (deg) => Math.round(deg * (2 ** 31 / 180));
const e = new Encoder();
const start = pts[0].time, end = pts[pts.length - 1].time;
e.onMesg(Profile.MesgNum.FILE_ID, { manufacturer: 'development', product: 1, timeCreated: start, type: 'activity' });
for (const p of pts) {
  const hour = p.time.getUTCHours() + 8; // fake daily temperature curve, local UTC+8
  const temperature = Math.round(26 + 4 * Math.sin(((hour - 9) / 24) * 2 * Math.PI) - (p.ele ?? 0) / 300);
  e.onMesg(Profile.MesgNum.RECORD, {
    timestamp: p.time, positionLat: semi(p.lat), positionLong: semi(p.lon),
    enhancedAltitude: p.ele, heartRate: p.hr, temperature,
  });
}
const secs = (end - start) / 1000;
e.onMesg(Profile.MesgNum.SESSION, {
  timestamp: end, startTime: start, totalElapsedTime: secs, totalTimerTime: secs,
  totalDistance: 71650, totalAscent: 3999, totalDescent: 3998, totalCalories: 7777,
  avgHeartRate: 143, maxHeartRate: 174, sport, subSport: 'generic', firstLapIndex: 0, numLaps: 1,
});
e.onMesg(Profile.MesgNum.ACTIVITY, { timestamp: end, numSessions: 1, type: 'manual', totalTimerTime: secs });
writeFileSync(output, e.close());
console.log(`wrote ${output} (${pts.length} records)`);
