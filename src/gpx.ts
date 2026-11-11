export interface RawPoint {
  lat: number;
  lon: number;
  ele: number | null;
  time: number | null; // epoch ms
  hr: number | null;
  temp?: number | null;
}

/** Totals reported by the watch itself (FIT session), when available. */
export interface SessionSummary {
  distance?: number;
  ascent?: number;
  descent?: number;
  calories?: number;
  avgHr?: number;
  maxHr?: number;
  avgTemp?: number;
}

export interface ParsedTrack {
  name: string;
  points: RawPoint[];
  /** Lowercase sport hint, e.g. "hiking", "running", "trail_running". */
  sport?: string;
  session?: SessionSummary;
}

/** Parse a GPX 1.1 file (track points, or route points as a fallback). */
export function parseGpx(text: string): ParsedTrack {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('That file is not valid GPX/XML.');
  }

  let nodes = doc.getElementsByTagName('trkpt');
  if (nodes.length === 0) nodes = doc.getElementsByTagName('rtept');
  if (nodes.length === 0) throw new Error('No track points found in this GPX file.');

  const points: RawPoint[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const lat = parseFloat(n.getAttribute('lat') ?? '');
    const lon = parseFloat(n.getAttribute('lon') ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const eleText = n.getElementsByTagName('ele')[0]?.textContent;
    const timeText = n.getElementsByTagName('time')[0]?.textContent;
    const hrText = n.getElementsByTagNameNS('*', 'hr')[0]?.textContent;

    const ele = eleText != null ? parseFloat(eleText) : NaN;
    const time = timeText != null ? Date.parse(timeText) : NaN;
    const hr = hrText != null ? parseFloat(hrText) : NaN;

    points.push({
      lat,
      lon,
      ele: Number.isFinite(ele) ? ele : null,
      time: Number.isFinite(time) ? time : null,
      hr: Number.isFinite(hr) && hr > 0 ? hr : null,
    });
  }

  const rawName =
    doc.querySelector('trk > name')?.textContent?.trim() ||
    doc.querySelector('metadata > name')?.textContent?.trim() ||
    '';

  const typeText = doc.querySelector('trk > type')?.textContent?.trim().toLowerCase();
  const suunto = /^suuntoapp-([A-Za-z]+)-/.exec(rawName)?.[1]?.toLowerCase();
  return { name: prettifyName(rawName), points, sport: typeText || suunto };
}

/** "suuntoapp-Hiking-2026-10-30T17-59-41Z" -> "Hiking" */
function prettifyName(name: string): string {
  const suunto = /^suuntoapp-([A-Za-z]+)-/.exec(name);
  if (suunto) return suunto[1];
  return name || 'My Hike';
}
