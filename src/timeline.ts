import { clamp, distAtCost, type Checkpoint, type Track } from './track';

export const PAUSE_SECONDS: Record<Checkpoint['kind'], number> = {
  start: 0,
  summit: 2.6,
  peak: 1.6,
  rest: 1.2,
  finish: 1.4,
};

export const INTRO_SECONDS = 2.8;
export const OUTRO_SECONDS = 4.2;

type Event =
  | { kind: 'move'; t0: number; t1: number; c0: number; c1: number }
  | { kind: 'pause'; t0: number; t1: number; cp: Checkpoint };

export interface TimelineState {
  t: number;
  phase: 'intro' | 'move' | 'pause' | 'outro';
  d: number; // metres along the track
  /** 0..1 progress through intro / outro (0 otherwise / 1 after). */
  introU: number;
  outroU: number;
  /** Checkpoint we're currently paused at, if any. */
  pauseCp: Checkpoint | null;
  pauseU: number;
  /** Most recently reached checkpoint and when (video seconds). */
  lastReached: { cp: Checkpoint; t: number } | null;
}

export class Timeline {
  readonly duration: number;
  readonly intro = INTRO_SECONDS;
  readonly outro = OUTRO_SECONDS;
  readonly events: Event[] = [];
  readonly reachTimes = new Map<string, number>();
  private track: Track;

  constructor(track: Track, checkpoints: Checkpoint[], duration: number) {
    this.track = track;
    this.duration = duration;

    const stops = checkpoints
      .filter((c) => c.enabled && c.kind !== 'start')
      .sort((a, b) => a.d - b.d);
    let pauseTotal = stops.reduce((s, c) => s + PAUSE_SECONDS[c.kind], 0);
    const available = duration - this.intro - this.outro;
    const maxPause = available * 0.35;
    const pauseScale = pauseTotal > maxPause ? maxPause / pauseTotal : 1;
    pauseTotal *= pauseScale;
    const moveTotal = Math.max(1, available - pauseTotal);

    let t = this.intro;
    let c = 0;
    for (const cp of stops) {
      const cc = track.cost[Math.min(track.n - 1, Math.round(cp.d / track.step))];
      const dt = moveTotal * (cc - c);
      if (dt > 0.001) this.events.push({ kind: 'move', t0: t, t1: t + dt, c0: c, c1: cc });
      t += Math.max(0, dt);
      c = cc;
      const p = PAUSE_SECONDS[cp.kind] * pauseScale;
      this.events.push({ kind: 'pause', t0: t, t1: t + p, cp });
      this.reachTimes.set(cp.id, t);
      t += p;
    }
    if (c < 1) {
      const dt = moveTotal * (1 - c);
      this.events.push({ kind: 'move', t0: t, t1: t + dt, c0: c, c1: 1 });
    }
    const start = checkpoints.find((cp) => cp.kind === 'start');
    if (start) this.reachTimes.set(start.id, 0);
  }

  sample(tRaw: number): TimelineState {
    const t = clamp(tRaw, 0, this.duration);
    const outroStart = this.duration - this.outro;
    const base: TimelineState = {
      t,
      phase: 'move',
      d: 0,
      introU: clamp(t / this.intro, 0, 1),
      outroU: clamp((t - outroStart) / this.outro, 0, 1),
      pauseCp: null,
      pauseU: 0,
      lastReached: null,
    };

    for (const e of this.events) {
      if (e.kind === 'pause' && e.t0 <= t) base.lastReached = { cp: e.cp, t: e.t0 };
    }

    if (t < this.intro) return { ...base, phase: 'intro', d: 0 };
    if (t >= outroStart) return { ...base, phase: 'outro', d: this.track.stats.distance };

    for (const e of this.events) {
      if (t < e.t0 || t >= e.t1) continue;
      const u = (t - e.t0) / (e.t1 - e.t0);
      if (e.kind === 'pause') {
        return { ...base, phase: 'pause', d: e.cp.d, pauseCp: e.cp, pauseU: u };
      }
      // Ease a little into and out of every checkpoint.
      const s = u * u * (3 - 2 * u);
      const ue = u + (s - u) * 0.35;
      return { ...base, phase: 'move', d: distAtCost(this.track, e.c0 + (e.c1 - e.c0) * ue) };
    }
    // Between the last event and the outro (e.g. finish pause ended).
    return { ...base, phase: 'move', d: this.track.stats.distance };
  }
}
