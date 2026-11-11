import type { Activity } from './track';

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  license: string;
}

/** Bundled CC0 music (public/music, see CREDITS.md). */
export const TRACKS: MusicTrack[] = [
  { id: 'stage-1', title: 'Stage 1', artist: 'Juhani Junkala', license: 'CC0' },
  { id: 'stage-2', title: 'Stage 2', artist: 'Juhani Junkala', license: 'CC0' },
  { id: 'boss-fight', title: 'Boss Fight', artist: 'Juhani Junkala', license: 'CC0' },
  { id: 'stage-select', title: 'Stage Select', artist: 'Juhani Junkala', license: 'CC0' },
];

export const DEFAULT_TRACK: Record<Activity, string> = {
  hike: 'stage-1',
  camphike: 'stage-2',
  trailrun: 'boss-fight',
};

export const SAMPLE_RATE = 48000;
const FADE_IN = 0.4;
const FADE_OUT = 2.5;

let ctx: AudioContext | null = null;
export function audioContext() {
  ctx ??= new AudioContext({ sampleRate: SAMPLE_RATE });
  return ctx;
}

const decoded = new Map<string, Promise<AudioBuffer>>();

function preferredExt() {
  return new Audio().canPlayType('audio/ogg; codecs="vorbis"') ? 'ogg' : 'm4a';
}

/** Decode a bundled track (cached). */
export function loadTrack(id: string): Promise<AudioBuffer> {
  let p = decoded.get(id);
  if (!p) {
    p = fetch(`/music/${id}.${preferredExt()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Music ${id} not found`);
        return r.arrayBuffer();
      })
      .then((b) => audioContext().decodeAudioData(b));
    decoded.set(id, p);
    p.catch(() => decoded.delete(id));
  }
  return p;
}

export async function decodeFile(file: Blob): Promise<AudioBuffer> {
  return audioContext().decodeAudioData(await file.arrayBuffer());
}

/** The finished soundtrack: the track looped to `duration`, with a short fade-in and a fade-out at the end. */
export async function renderSoundtrack(src: AudioBuffer, duration: number, volume: number): Promise<AudioBuffer> {
  const frames = Math.max(1, Math.ceil(duration * SAMPLE_RATE));
  const off = new OfflineAudioContext(2, frames, SAMPLE_RATE);
  const node = off.createBufferSource();
  node.buffer = src;
  node.loop = true;
  const gain = off.createGain();
  gain.gain.setValueAtTime(0, 0);
  gain.gain.linearRampToValueAtTime(volume, Math.min(FADE_IN, duration / 2));
  gain.gain.setValueAtTime(volume, Math.max(FADE_IN, duration - FADE_OUT));
  gain.gain.linearRampToValueAtTime(0, duration);
  node.connect(gain).connect(off.destination);
  node.start(0);
  return off.startRendering();
}

/** Plays the soundtrack in the preview and acts as the master clock while it's running. */
export class PreviewPlayer {
  private node: AudioBufferSourceNode | null = null;
  private startedAt = 0; // context time
  private offset = 0; // video seconds at startedAt

  get playing() {
    return this.node != null;
  }

  /** Current video time according to the audio clock, or null if not playing. */
  time(): number | null {
    if (!this.node || !ctx || ctx.state !== 'running') return null;
    return this.offset + (ctx.currentTime - this.startedAt);
  }

  start(buf: AudioBuffer, at: number) {
    this.stop();
    const c = audioContext();
    if (c.state === 'suspended') void c.resume();
    if (at >= buf.duration) return;
    const n = c.createBufferSource();
    n.buffer = buf;
    n.connect(c.destination);
    n.start(0, Math.max(0, at));
    this.node = n;
    this.startedAt = c.currentTime;
    this.offset = at;
    n.onended = () => {
      if (this.node === n) this.node = null;
    };
  }

  stop() {
    if (this.node) {
      this.node.onended = null;
      try { this.node.stop(); } catch { /* already stopped */ }
      this.node.disconnect();
      this.node = null;
    }
  }
}
