import type { Checkpoint, Track } from './track';

/**
 * Per-track memory in localStorage (nothing leaves the browser, the GPX/FIT file is never changed).
 *
 * Checkpoints the user touches become "pinned": they're stored in full and always win over the
 * automatically detected ones near the same spot, so switching activity/character/etc. never
 * undoes a rename, a type change, a toggle or a deletion.
 */
export interface SavedState {
  v: 1;
  savedAt: number;
  settings: Record<string, string | number | boolean | null>;
  pins: Checkpoint[];
  /** Distances (m) of auto checkpoints the user deleted. */
  tombstones: number[];
}

const NEAR = 200; // metres: a pin/tombstone hides auto checkpoints this close

export function trackKey(t: Track) {
  return `pixelhike:v1:${Math.round(t.stats.startTime / 1000)}:${Math.round(t.stats.distance)}`;
}

export function loadSaved(t: Track): SavedState | null {
  try {
    const raw = localStorage.getItem(trackKey(t));
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedState;
    return s.v === 1 ? s : null;
  } catch {
    return null;
  }
}

export function save(t: Track, s: Omit<SavedState, 'v' | 'savedAt'>) {
  try {
    localStorage.setItem(trackKey(t), JSON.stringify({ v: 1, savedAt: Date.now(), ...s }));
    return true;
  } catch {
    return false; // storage full / disabled
  }
}

export function forget(t: Track) {
  localStorage.removeItem(trackKey(t));
}

const isEnd = (c: Checkpoint) => c.kind === 'start' || c.kind === 'finish';

/** Auto-detected checkpoints with the user's pins and deletions applied. */
export function mergeCheckpoints(detected: Checkpoint[], pins: Checkpoint[], tombstones: number[]): Checkpoint[] {
  const kept = detected.filter((c) => {
    if (isEnd(c)) return !pins.some((p) => p.kind === c.kind);
    if (pins.some((p) => !isEnd(p) && Math.abs(p.d - c.d) < NEAR)) return false;
    if (tombstones.some((d) => Math.abs(d - c.d) < NEAR)) return false;
    return true;
  });
  const all = [...kept, ...pins.map((p) => ({ ...p }))].sort((a, b) => a.d - b.d);
  // renumber the automatic ones so hidden duplicates don't leave gaps (CP 1, CP 3 → CP 1, CP 2)
  const prefix: Partial<Record<Checkpoint['kind'], string>> = { peak: 'PEAK', cp: 'CP', camp: 'CAMP' };
  const count: Record<string, number> = {};
  for (const c of all) {
    const p = prefix[c.kind];
    if (!p || c.pinned) continue;
    count[p] = (count[p] ?? 0) + 1;
    c.name = `${p} ${count[p]}`;
  }
  return all;
}

let pinSeq = 0;
/** Marks a checkpoint as user-edited (gives it a stable, unique id). */
export function pin(cp: Checkpoint) {
  if (cp.pinned) return;
  cp.pinned = true;
  cp.id = `pin-${Math.round(cp.d)}-${Date.now().toString(36)}${(pinSeq++).toString(36)}`;
}
