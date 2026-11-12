import { cacheGet, cacheSet } from './cache';
import { C } from './palette';
import { clamp } from './track';

/**
 * The weather on the day, hour by hour, from Open-Meteo (free, no key): rain, cloud cover, thunder
 * and temperature for the area. Only a rough location (rounded to 0.1°, ≈ 10 km) and the dates are
 * sent; the result is kept in this browser so a track opened again needs no network.
 */
export interface WeatherSeries {
  /** Epoch ms of the first hour. */
  t0: number;
  precip: number[]; // mm in that hour
  cloud: number[]; // %
  code: number[]; // WMO weather code
  temp: number[]; // °C at the model's ground height
  /** The model's ground height (m), for adjusting the temperature to the trail's height. */
  elevation: number;
}

export type WeatherMode = 'real' | 'clear' | 'drizzle' | 'rain' | 'storm';

export interface WeatherNow {
  /** 0 dry … 1 downpour. */
  rain: number;
  /** 0 clear … 1 overcast. */
  cloud: number;
  thunder: boolean;
  /** Air temperature at the model's ground height, or null. */
  temp: number | null;
}

const DRY: WeatherNow = { rain: 0, cloud: 0, thunder: false, temp: null };
const FIXED: Record<Exclude<WeatherMode, 'real'>, WeatherNow> = {
  clear: DRY,
  drizzle: { rain: 0.25, cloud: 0.75, thunder: false, temp: null },
  rain: { rain: 0.65, cloud: 0.95, thunder: false, temp: null },
  storm: { rain: 1, cloud: 1, thunder: true, temp: null },
};

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function loadWeather(lat: number, lon: number, startMs: number, endMs: number): Promise<WeatherSeries> {
  const la = lat.toFixed(1), lo = lon.toFixed(1);
  const from = day(startMs - 3600_000), to = day(endMs + 3600_000);
  const key = `weather:v1:${la},${lo}:${from}:${to}`;
  const hit = await cacheGet<WeatherSeries>(key);
  if (hit) return hit;
  const q = `latitude=${la}&longitude=${lo}&start_date=${from}&end_date=${to}&hourly=precipitation,cloud_cover,weather_code,temperature_2m&timezone=GMT`;
  // high-resolution model history first; the plain forecast API for the last few days; ERA5 for old hikes
  const urls = [
    `https://historical-forecast-api.open-meteo.com/v1/forecast?${q}`,
    `https://api.open-meteo.com/v1/forecast?${q}`,
    `https://archive-api.open-meteo.com/v1/archive?${q}`,
  ];
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const h = j.hourly;
      if (!h?.time?.length || !h.precipitation?.some((v: number | null) => v != null)) throw new Error('no data');
      const s: WeatherSeries = {
        t0: Date.parse(`${h.time[0]}:00Z`),
        precip: h.precipitation.map((v: number | null) => v ?? 0),
        cloud: h.cloud_cover.map((v: number | null) => v ?? 0),
        code: h.weather_code.map((v: number | null) => v ?? 0),
        temp: h.temperature_2m.map((v: number | null) => v ?? NaN),
        elevation: Number(j.elevation) || 0,
      };
      void cacheSet(key, s);
      return s;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('Weather unavailable');
}

/** Weather at an epoch time (hourly values, eased between hours). */
export function weatherAt(series: WeatherSeries | null, mode: WeatherMode, ms: number): WeatherNow {
  if (mode !== 'real') return FIXED[mode];
  if (!series) return DRY;
  const f = (ms - series.t0) / 3600_000;
  const n = series.precip.length;
  if (f < -1 || f > n) return DRY;
  // hourly totals are "the hour ending at"; centre them on the half hour and interpolate
  const x = clamp(f - 0.5, 0, n - 1);
  const i = Math.min(n - 2, Math.floor(x)), u = x - i;
  const lerp = (a: number[]) => a[i] + (a[i + 1] - a[i]) * u;
  const mm = lerp(series.precip);
  const code = series.code[Math.round(clamp(f - 0.5, 0, n - 1))];
  // models smear tropical showers out: even 0.1 mm/h reads as drizzle, ~2 mm/h as a downpour
  const rain = mm < 0.08 ? 0 : clamp(0.18 + Math.sqrt(mm / 2.5) * 0.82, 0, 1);
  const t = lerp(series.temp);
  return {
    rain,
    cloud: clamp(lerp(series.cloud) / 100, 0, 1),
    thunder: code >= 95 && rain > 0,
    temp: Number.isFinite(t) ? t : null,
  };
}

/** Times (epoch ms) when rain / a storm starts within [from, to], for pop-ups. */
export function weatherEvents(series: WeatherSeries | null, mode: WeatherMode, from: number, to: number) {
  const out: { ms: number; text: string }[] = [];
  if (mode !== 'real' || !series) return out;
  let wasRain = weatherAt(series, mode, from).rain > 0, wasStorm = weatherAt(series, mode, from).thunder;
  for (let ms = from + 10 * 60000; ms <= to; ms += 10 * 60000) {
    const w = weatherAt(series, mode, ms);
    if (w.thunder && !wasStorm) out.push({ ms, text: 'THUNDERSTORM!' });
    else if (w.rain > 0 && !wasRain) out.push({ ms, text: w.rain > 0.5 ? 'HEAVY RAIN' : 'RAIN STARTS' });
    wasRain = w.rain > 0;
    wasStorm = w.thunder;
  }
  return out;
}

/** One line for the sidebar: when it rained during the hike. */
export function weatherSummary(series: WeatherSeries, from: number, to: number, tzOffsetMin: number) {
  const spans: [number, number, number][] = [];
  let cur: [number, number, number] | null = null;
  for (let ms = from; ms <= to; ms += 15 * 60000) {
    const w = weatherAt(series, 'real', ms);
    const mm = w.rain > 0 ? ((w.rain - 0.18) / 0.82) ** 2 * 2.5 : 0;
    if (w.rain > 0) {
      if (!cur) cur = [ms, ms, mm];
      cur[1] = ms;
      cur[2] = Math.max(cur[2], mm);
    } else if (cur) { spans.push(cur); cur = null; }
  }
  if (cur) spans.push(cur);
  const hm = (ms: number) => {
    const d = new Date(ms + tzOffsetMin * 60000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };
  const storm = (() => { for (let ms = from; ms <= to; ms += 15 * 60000) if (weatherAt(series, 'real', ms).thunder) return true; return false; })();
  if (!spans.length) return 'Dry during the hike';
  const parts = spans.slice(0, 3).map(([a, b, mm]) => `${hm(a)}–${hm(b + 15 * 60000)}${mm > 1.5 ? ' heavy' : mm < 0.3 ? ' drizzle' : ''}`);
  return `${storm ? 'Storms' : 'Rain'} ${parts.join(', ')}${spans.length > 3 ? ' …' : ''}`;
}

// ------------------------------------------------------------------ drawing

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const hash = (n: number) => {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/**
 * Rain streaks falling across the frame (slanted by a little wind), splashes on the ground in the
 * lower part, and lightning: a bolt in the sky and a flash over everything for a couple of frames.
 */
export function drawWeather(ctx: CanvasRenderingContext2D, w: WeatherNow, t: number, W: number, H: number, night: boolean, skyH: number) {
  if (w.rain > 0) {
    const n = Math.round(30 + w.rain * w.rain * 330);
    const len = w.rain > 0.6 ? 6 : w.rain > 0.3 ? 4 : 3;
    const cols = night ? [C.dusk, C.sky] : [C.skyPale, C.greyLight];
    const fall = 300; // px / s
    for (let i = 0; i < n; i++) {
      const x0 = hash(i) * (W + 40) - 20, ph = hash(i + 7919);
      const y = ((ph * (H + 20) + t * fall * (0.85 + hash(i + 31) * 0.3)) % (H + 20)) - 10;
      const x = Math.round(x0 - y * 0.25);
      ctx.fillStyle = cols[i & 1];
      for (let k = 0; k < len; k++) ctx.fillRect(x + Math.floor(k / 4), Math.round(y) + k, 1, 1);
    }
    // splashes: little crowns popping up on the ground
    const m = Math.round(w.rain * 46);
    ctx.fillStyle = night ? C.sky : C.white;
    for (let i = 0; i < m; i++) {
      const life = 0.25, ph = hash(i + 101) * life;
      const cyc = Math.floor((t + ph) / life);
      const age = ((t + ph) % life) / life;
      const x = Math.round(hash(i * 131 + cyc) * W);
      const y = Math.round(skyH + 8 + hash(i * 71 + cyc * 3) * (H - skyH - 30));
      if (age < 0.5) ctx.fillRect(x, y, 1, 1);
      else { ctx.fillRect(x - 1, y - 1, 1, 1); ctx.fillRect(x + 1, y - 1, 1, 1); }
    }
  }
  if (w.thunder) {
    // a strike every few seconds (deterministic in t), visible for ~0.25 s
    const period = 5.5;
    const k = Math.floor(t / period);
    const at = k * period + hash(k + 5) * 3;
    const age = t - at;
    if (age >= 0 && age < 0.28) {
      if (age < 0.12) {
        // flash: a sparse dither of white over everything
        const a = age < 0.05 ? 0.45 : 0.2;
        ctx.fillStyle = C.white;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 < a) ctx.fillRect(x, y, 1, 1);
      }
      // the bolt, jagging down through the sky
      let x = Math.round(W * (0.15 + hash(k + 9) * 0.7)), y = 0;
      const bottom = Math.max(20, skyH);
      ctx.fillStyle = age < 0.16 ? C.white : C.cream;
      let s = 0;
      while (y < bottom) {
        const step = 2 + Math.floor(hash(k * 31 + s) * 4);
        const dx = Math.floor(hash(k * 17 + s) * 5) - 2;
        for (let j = 0; j < step; j++) ctx.fillRect(x + Math.round((dx * j) / step), y + j, 1, 1);
        x += dx; y += step; s++;
      }
    }
  }
}

export const RAIN_ICON = ['..ww...', '.wwww..', 'wwwwww.', '.......', '.S.S.S.', 'S.S.S..', '.......'];
export const STORM_ICON = ['..ww...', '.wwww..', 'wwwwww.', '...y...', '..yy.S.', '.yy.S..', '.y.....'];
