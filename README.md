# Pixel Hike

Turn a GPX workout into a cute pixel-art route video — like Relive / Strava Flyover / Suunto 3D playback, but chunky.

- **3D diorama** — real terrain (free AWS Terrain Tiles) rendered at 320×180 and quantised to a 32-colour palette, camera follows a chibi hiker along the track.
- **2D map** — top-down retro topo map with contour lines.
- **Checkpoints** — summit, other peaks (by prominence), long rests (12+ min, tent + zZz) and finish are detected automatically; rename or toggle them. The hiker cheers, flags rise, confetti pops.
- **Data HUD** — distance, elevation, real clock time with sun/moon, pulsing heart rate, elevation profile, minimap.
- **Real sky** — the sun position is computed from your GPS + timestamps, so night starts get stars and a headlamp.
- **Export** — MP4 (H.264) encoded in the browser with WebCodecs; 16:9 or 9:16, 720p/1080p. Your GPX never leaves the browser (only elevation tiles are fetched).

## Run

```sh
npm install
npm run dev
```

Open the printed URL and drop a GPX file. From Suunto: activity → ··· → **Export GPX workout**
(GPX workout has timestamps + heart rate; "GPX route"/"KML route" only have the shape, so timing is faked at 4 km/h).

For development, put a track at `public/samples/hike.gpx` (git-ignored) and open `/?sample`.

## How it works

| File | What it does |
|---|---|
| `src/gpx.ts` | Parse GPX (lat/lon/ele/time + Garmin `TrackPointExtension` heart rate) |
| `src/track.ts` | Resample to even distance steps, smoothing, stats, stop + peak detection |
| `src/timeline.ts` | Maps video seconds → distance; intro/outro, pauses at checkpoints, slower on steep/slow parts |
| `src/dem.ts` | Fetches Terrarium elevation tiles and samples them |
| `src/terrain.ts` | Height grid → mesh, diorama soil skirt, instanced trees, toon + headlamp shader |
| `src/renderer.ts` | Camera rig (look-ahead follow cam that lifts over ridges), trail lines, low-res render + palette/dither post pass |
| `src/overlay.ts` | Pixel-perfect sprites (hiker, flags, tents, confetti) and HUD, drawn on a 2D canvas |
| `src/sprites.ts`, `src/font.ts` | Hand-made sprites and a 5×7 bitmap font |
| `src/export.ts` | Deterministic frame-by-frame render → WebCodecs H.264 → MP4 (mp4-muxer) |

## Swapping in your own art (Grok Imagine + unfake.js)

Sprites are char-maps in `src/sprites.ts`, coloured from the shared palette in `src/palette.ts`.
To use AI art: generate a 16×16-ish character in Grok Imagine, clean it with
[unfake.js](https://github.com/jenissimo/unfake.js) using a **fixed palette** (the 32 colours in `palette.ts`)
and a manual scale, then load the PNG instead of the char-map.

## Scripts

- `node scripts/shot.mjs <outdir> <3d|2d> <landscape|portrait> t1 t2 …` — screenshots at given video times (needs `npm run dev` on port 5199).
- `node scripts/export-test.mjs out.mp4 [mode] [aspect] [scale]` — full export in headless Chrome.

Elevation data: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen; SRTM, GMTED, NED, ETOPO1 and others).
