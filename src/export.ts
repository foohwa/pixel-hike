import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { PixelRenderer } from './renderer';

export interface ExportOptions {
  duration: number;
  fps: number;
  scale: number; // integer upscale of the low-res frame
  onProgress?: (u: number) => void;
  signal?: AbortSignal;
  /** Finished soundtrack (already looped/faded to the video length), or null for a silent video. */
  audio?: AudioBuffer | null;
}

/** Renders every frame deterministically and encodes an H.264 MP4 in the browser (WebCodecs). */
export async function exportMp4(r: PixelRenderer, opts: ExportOptions): Promise<Blob> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser has no WebCodecs video encoder. Try a recent Chrome, Edge or Safari.');
  }
  const W = r.W * opts.scale, H = r.H * opts.scale;
  const codec = await pickCodec(W, H, opts.fps);
  const audio = opts.audio ?? null;
  const audioCodec = audio ? await pickAudioCodec(audio.sampleRate, audio.numberOfChannels) : null;

  const up = document.createElement('canvas');
  up.width = W;
  up.height = H;
  const ctx = up.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: opts.fps },
    audio: audio && audioCodec
      ? { codec: audioCodec.muxer, sampleRate: audio.sampleRate, numberOfChannels: audio.numberOfChannels }
      : undefined,
    fastStart: 'in-memory',
  });
  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (encodeError = e),
  });
  encoder.configure({ codec, width: W, height: H, bitrate: Math.round(W * H * opts.fps * 0.25), framerate: opts.fps });

  const frames = Math.round(opts.duration * opts.fps);
  const usPerFrame = 1e6 / opts.fps;
  for (let i = 0; i < frames; i++) {
    if (opts.signal?.aborted) {
      encoder.close();
      throw new DOMException('Export cancelled', 'AbortError');
    }
    if (encodeError) throw encodeError;
    r.renderAt(i / opts.fps);
    ctx.drawImage(r.canvas, 0, 0, W, H);
    const frame = new VideoFrame(up, { timestamp: Math.round(i * usPerFrame), duration: Math.round(usPerFrame) });
    encoder.encode(frame, { keyFrame: i % (opts.fps * 2) === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 8) await new Promise((res) => setTimeout(res, 1));
    if (i % 10 === 0) {
      opts.onProgress?.(i / frames);
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;

  if (audio && audioCodec) await encodeAudio(audio, audioCodec.encoder, muxer, opts.duration);

  muxer.finalize();
  opts.onProgress?.(1);
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

async function pickCodec(width: number, height: number, framerate: number) {
  for (const codec of ['avc1.640033', 'avc1.640028', 'avc1.4d0028', 'avc1.42e01f']) {
    try {
      const s = await VideoEncoder.isConfigSupported({ codec, width, height, framerate, bitrate: 8e6 });
      if (s.supported) return codec;
    } catch {
      /* try next */
    }
  }
  throw new Error(`No H.264 encoder available for ${width}x${height}.`);
}

async function pickAudioCodec(sampleRate: number, numberOfChannels: number) {
  if (typeof AudioEncoder === 'undefined') return null;
  const options = [
    { encoder: 'mp4a.40.2', muxer: 'aac' as const }, // AAC-LC: plays everywhere (iPhone, Instagram…)
    { encoder: 'opus', muxer: 'opus' as const },
  ];
  for (const o of options) {
    try {
      const s = await AudioEncoder.isConfigSupported({ codec: o.encoder, sampleRate, numberOfChannels, bitrate: 160_000 });
      if (s.supported) return o;
    } catch {
      /* try next */
    }
  }
  console.warn('No audio encoder available; exporting without music.');
  return null;
}

async function encodeAudio(buf: AudioBuffer, codec: string, muxer: Muxer<ArrayBufferTarget>, seconds: number) {
  let err: unknown = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => (err = e),
  });
  const { sampleRate, numberOfChannels } = buf;
  const length = Math.min(buf.length, Math.round(seconds * sampleRate)); // never longer than the video
  enc.configure({ codec, sampleRate, numberOfChannels, bitrate: 160_000 });
  const block = Math.round(sampleRate / 10);
  const chans = Array.from({ length: numberOfChannels }, (_, c) => buf.getChannelData(c));
  for (let start = 0; start < length; start += block) {
    if (err) throw err;
    const n = Math.min(block, length - start);
    const planar = new Float32Array(n * numberOfChannels);
    chans.forEach((ch, c) => planar.set(ch.subarray(start, start + n), c * n));
    const data = new AudioData({
      format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels,
      timestamp: Math.round((start / sampleRate) * 1e6), data: planar,
    });
    enc.encode(data);
    data.close();
    while (enc.encodeQueueSize > 16) await new Promise((r) => setTimeout(r, 1));
  }
  await enc.flush();
  enc.close();
  if (err) throw err;
}
