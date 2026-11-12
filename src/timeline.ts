import { clamp, distAtCost, lerp, sampleAt, type Checkpoint, type Track } from './track';

/** Seconds of video spent paused at each kind of checkpoint. */
export const PAUSE_SECONDS: Record<Checkpoint['kind'], number> = {
  start: 0,
  summit: 2.8,
  peak: 1.8,
  view: 2.6, // time to look around (the camera swings towards the view)
  rest: 1.4,
  camp: 3.6, // long enough to time-lapse a night
  cp: 1.2,
  finish: 1.6,
};

export const INTRO_SECONDS = 2.8;
export const OUTRO_SECONDS = 4.4;
/** Start-line / finish-line arch scenes (optional, see gate.ts). */
export const GATE_IN_SECONDS = 4.4;
export const GATE_OUT_SECONDS = 3.8;

/** A stop for one of your photos (see moments.ts): the walker waits while the polaroid shows. */
export interface PhotoStop { id: string; d: number; time: number | null; seconds: number }

type Event =
  | { kind: 'move'; t0: number; t1: number; c0: number; c1: number; minClock: number }
  | { kind: 'pause'; t0: number; t1: number; cp: Checkpoint }
  | { kind: 'photo'; t0: number; t1: number; photo: PhotoStop; clock: number };

export interface TimelineState {
  t: number;
  phase: 'gateStart' | 'intro' | 'move' | 'pause' | 'gateFinish' | 'outro';
  d: number; // metres along the track
  /** Real-world time shown on the clock (fast-forwards through stays at camps/rests). */
  clockMs: number;
  introU: number;
  /** Seconds into the intro swoop (0 during the start-arch scene). */
  introT: number;
  outroU: number;
  /** 0..1 through the start / finish arch scene. */
  gateU: number;
  pauseCp: Checkpoint | null;
  pauseU: number;
  /** Stopped for a photo: which one and how far through (phase is 'pause', pauseCp null). */
  photo: { id: string; u: number } | null;
  lastReached: { cp: Checkpoint; t: number } | null;
}

/** Default video length for a track: long hikes get more time so the walk doesn't feel rushed. */
export function defaultDuration(track: Track) {
  const km = track.stats.distance / 1000;
  return Math.round(clamp(30 + km * 0.75, 30, 90));
}

export class Timeline {
  readonly duration: number;
  readonly intro: number = INTRO_SECONDS;
  readonly outro: number = OUTRO_SECONDS;
  readonly gateIn: number;
  readonly gateOut: number;
  readonly events: Event[] = [];
  readonly reachTimes = new Map<string, number>();
  readonly moveSeconds: number;
  private track: Track;
  private clockSamples: Float64Array | null = null;
  private distSamples: Float64Array | null = null;
  private static readonly SAMPLE_HZ = 20;

  readonly photoTimes = new Map<string, number>();

  constructor(
    track: Track,
    checkpoints: Checkpoint[],
    duration: number,
    opts: { gates?: boolean; photos?: PhotoStop[]; intro?: number; outro?: number } = {},
  ) {
    if (opts.intro != null) this.intro = opts.intro;
    if (opts.outro != null) this.outro = opts.outro;
    this.track = track;
    this.duration = duration;
    this.gateIn = opts.gates ? GATE_IN_SECONDS : 0;
    this.gateOut = opts.gates ? GATE_OUT_SECONDS : 0;

    // checkpoints and photo stops in order along the track (a photo at a checkpoint comes after it)
    type Stop = { cp: Checkpoint; photo?: undefined; d: number; s: number } | { cp?: undefined; photo: PhotoStop; d: number; s: number };
    const stops: Stop[] = [
      ...checkpoints.filter((c) => c.enabled && c.kind !== 'start').map((cp): Stop => ({ cp, d: cp.d, s: PAUSE_SECONDS[cp.kind] })),
      ...(opts.photos ?? []).map((photo): Stop => ({ photo, d: clamp(photo.d, 0, track.stats.distance), s: photo.seconds })),
    ].sort((a, b) => a.d - b.d || (a.cp ? -1 : 1));

    let pauseTotal = stops.reduce((s, c) => s + c.s, 0);
    const available = duration - this.gateIn - this.intro - this.gateOut - this.outro;
    const maxPause = available * 0.35;
    const pauseScale = pauseTotal > maxPause ? maxPause / pauseTotal : 1;
    pauseTotal *= pauseScale;
    const moveTotal = Math.max(1, available - pauseTotal);
    this.moveSeconds = moveTotal;

    let t = this.gateIn + this.intro;
    let c = 0;
    let minClock = track.stats.startTime; // clock never runs backwards after a time-lapsed stay
    for (const stop of stops) {
      const cc = Math.max(c, track.cost[Math.min(track.n - 1, Math.round(stop.d / track.step))]);
      const dt = moveTotal * (cc - c);
      if (dt > 0.001) this.events.push({ kind: 'move', t0: t, t1: t + dt, c0: c, c1: cc, minClock });
      t += Math.max(0, dt);
      c = cc;
      const p = stop.s * pauseScale;
      if (stop.cp) {
        this.events.push({ kind: 'pause', t0: t, t1: t + p, cp: stop.cp });
        this.reachTimes.set(stop.cp.id, t);
        minClock = Math.max(minClock, stop.cp.leaveTime);
      } else {
        const clock = Math.max(minClock, sampleAt(track, track.time, stop.d));
        this.events.push({ kind: 'photo', t0: t, t1: t + p, photo: stop.photo, clock });
        this.photoTimes.set(stop.photo.id, t);
      }
      t += p;
    }
    if (c < 1) {
      const dt = moveTotal * (1 - c);
      this.events.push({ kind: 'move', t0: t, t1: t + dt, c0: c, c1: 1, minClock });
    }
    const start = checkpoints.find((cp) => cp.kind === 'start');
    if (start) this.reachTimes.set(start.id, 0);
  }

  sample(tRaw: number): TimelineState {
    const t = clamp(tRaw, 0, this.duration);
    const tr = this.track;
    const outroStart = this.duration - this.outro;
    const gateOutStart = outroStart - this.gateOut;
    const introT = clamp(t - this.gateIn, 0, this.intro);
    const base: TimelineState = {
      t,
      phase: 'move',
      d: 0,
      clockMs: tr.stats.startTime,
      introU: introT / this.intro,
      introT,
      outroU: clamp((t - outroStart) / this.outro, 0, 1),
      gateU: 0,
      pauseCp: null,
      pauseU: 0,
      photo: null,
      lastReached: null,
    };

    for (const e of this.events) {
      if (e.kind === 'pause' && e.t0 <= t) base.lastReached = { cp: e.cp, t: e.t0 };
    }

    if (t < this.gateIn) return { ...base, phase: 'gateStart', d: 0, gateU: t / this.gateIn };
    if (t < this.gateIn + this.intro) return { ...base, phase: 'intro', d: 0 };
    if (t >= outroStart) return { ...base, phase: 'outro', d: tr.stats.distance, clockMs: tr.stats.endTime };
    if (t >= gateOutStart) {
      return { ...base, phase: 'gateFinish', d: tr.stats.distance, clockMs: tr.stats.endTime, gateU: (t - gateOutStart) / this.gateOut };
    }

    for (const e of this.events) {
      if (t < e.t0 || t >= e.t1) continue;
      const u = (t - e.t0) / (e.t1 - e.t0);
      if (e.kind === 'photo') {
        return { ...base, phase: 'pause', d: clamp(e.photo.d, 0, tr.stats.distance), photo: { id: e.photo.id, u }, clockMs: e.clock };
      }
      if (e.kind === 'pause') {
        // time-lapse through the stay (a night at camp, a long lunch…)
        const s = u * u * (3 - 2 * u);
        return { ...base, phase: 'pause', d: e.cp.d, pauseCp: e.cp, pauseU: u, clockMs: lerp(e.cp.time, e.cp.leaveTime, s) };
      }
      // Ease into and out of every checkpoint.
      const s = u * u * (3 - 2 * u);
      const ue = u + (s - u) * 0.5;
      const d = distAtCost(tr, e.c0 + (e.c1 - e.c0) * ue);
      return { ...base, phase: 'move', d, clockMs: Math.max(sampleAt(tr, tr.time, d), e.minClock) };
    }
    return { ...base, phase: 'move', d: tr.stats.distance, clockMs: tr.stats.endTime };
  }

  /** First video time at which the on-screen clock reaches `ms` (or null if never). */
  videoTimeAtClock(ms: number): number | null {
    if (!this.clockSamples) {
      const n = Math.ceil(this.duration * Timeline.SAMPLE_HZ) + 1;
      this.clockSamples = new Float64Array(n);
      for (let i = 0; i < n; i++) this.clockSamples[i] = this.sample(i / Timeline.SAMPLE_HZ).clockMs;
    }
    const cs = this.clockSamples;
    if (ms < cs[0] || ms > cs[cs.length - 1]) return null;
    for (let i = 1; i < cs.length; i++) {
      if (cs[i] >= ms) {
        const span = cs[i] - cs[i - 1];
        return (i - 1 + (span > 0 ? (ms - cs[i - 1]) / span : 0)) / Timeline.SAMPLE_HZ;
      }
    }
    return null;
  }

  /** First video time at which the walker reaches `d` metres (or null if never). */
  videoTimeAtDistance(d: number): number | null {
    if (!this.distSamples) {
      const n = Math.ceil(this.duration * Timeline.SAMPLE_HZ) + 1;
      this.distSamples = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const st = this.sample(i / Timeline.SAMPLE_HZ);
        // the intro / start arch sit at d = 0, the finish scenes at the end: only count walking
        this.distSamples[i] = st.phase === 'move' || st.phase === 'pause' ? st.d : st.phase === 'gateStart' || st.phase === 'intro' ? -1 : Infinity;
      }
    }
    const ds = this.distSamples;
    for (let i = 0; i < ds.length; i++) if (ds[i] >= d) return i / Timeline.SAMPLE_HZ;
    return null;
  }

  /** How much faster than real life the walking parts play. */
  speedup(): number {
    const moving = this.track.stats.movingTime / 1000;
    return moving > 0 ? moving / this.moveSeconds : 0;
  }
}
