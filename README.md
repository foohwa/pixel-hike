# Pixel Hike

Turn a GPX workout into a cute pixel-art route video — like Relive / Strava Flyover / Suunto 3D playback, but chunky.

- **3D diorama** — real terrain (free AWS Terrain Tiles) rendered at 320×180 and quantised to a 32-colour palette, camera follows a chibi hiker along the track.
- **2D map** — top-down retro topo map with contour lines.
- **Activities** — *Hike*, *Camp hike* (stops of 2 h+ become campsites; the clock time-lapses through the night while you sleep in the tent) and *Trail run* (runner sprite, aid-station checkpoints, race timer + moving pace, FINISHER card). Guessed from the file, switchable.
- **Checkpoints** — summit, other peaks (by prominence), rests, campsites, aid stations, viewpoints and finish. Auto-detected; rename, change type, delete, or add your own at the current scrub position.
- **Characters** — Hiker, Runner, Dog or Cat, each male or female, plus an optional dog/cat buddy. Animations switch with the terrain (walk, climb > 15 %, careful descent, run, cheer, rest, sleep). All follow one [sprite standard](docs/SPRITE_SPEC.md), so you can drop in your own sheet.
- **Day & night** — sun and moon positions (and the real moon phase) are computed from your GPS + timestamps: sky colours, stars, a head-lamp at night, a little sun/moon dial, and SUNRISE / SUNSET pop-ups.
- **Start / finish arch** — race-day opening and ending scenes: a lit arch with your banner text, event logos and tagline, START/FINISH pillars, a 3·2·1·GO! countdown, the runner (and buddy) sprinting off, a pixel dissolve into the map, and a FINISHER! scene with the finish time. Auto-on for trail runs; colour selectable; small arches mark start/finish on the map.
- **Trail zones** — the trail is dressed by elevation: lowland jungle (ferns, palms), montane forest, mossy forest (moss cushions, beard-moss trees, pitcher plants), rocky ridge or alpine meadow. Tropical tracks default to real cloud-forest heights (1,000 m / 1,500 m); elsewhere the bands split the track's own range. Steep stretches (>~28%) get fixed ropes, roots, rock steps and a warning sign; the elevation profile is coloured by zone and a toast names each new zone. Props darken at night except inside the head-lamp glow.
- **Event logo** — upload a race/event logo: its flat background is removed and it's re-drawn on an exact pixel grid (dominant colour per cell, 2–6 colours or the game palette). Shown on the intro card, as a corner badge and on the finish card; saved with your edits.
- **Data HUD** — distance, elevation, clock (or race timer + pace), pulsing heart rate, temperature (FIT), elevation profile, minimap.
- **Music** — four bundled CC0 chiptunes by Juhani Junkala (auto-picked per activity), or your own file. Looped to the video length with a fade-out, played in the preview and muxed into the MP4 as AAC. Credits in [`public/music/CREDITS.md`](public/music/CREDITS.md).
- **Remembers your edits** — renamed / retyped / hidden / deleted / added checkpoints and all settings are saved per track in your browser (localStorage) and survive activity changes and reloads. The GPX/FIT file itself is never modified. *Reset edits* forgets them.
- **You are here** — a marker in the checkpoint list follows the hiker; passed checkpoints grey out, click a checkpoint's km line to jump there.
- **Export** — MP4 (H.264) encoded in the browser with WebCodecs; 16:9 or 9:16, 720p/1080p. Your GPX never leaves the browser (only elevation tiles are fetched).

## Run

```sh
npm install
npm run dev
```

Open the printed URL and drop a **GPX** or **FIT** file. From Suunto: activity → ··· → **Export GPX workout** or **Export as FIT file**.

- *GPX workout*: positions, elevation, timestamps, heart rate.
- *FIT*: all of that plus temperature and the watch's own totals (ascent, distance, calories), so the numbers match the Suunto app.
- *GPX route / KML route*: shape only; timing is faked at 4 km/h.

The default video length grows with distance (30 s + 0.75 s per km, max 90 s); the panel shows how much faster than real life the walking plays.

For development, put a track at `public/samples/hike.gpx` / `hike.fit` (git-ignored) and open `/?sample` or `/?sample=fit`.

## How it works

| File | What it does |
|---|---|
| `src/gpx.ts`, `src/fit.ts` | Parse GPX (Garmin `TrackPointExtension` heart rate) and FIT (`@garmin/fitsdk`, records + session totals) |
| `src/track.ts` | Resample to even distance steps, smoothing, grade, moving pace, stats, stops, activity guess, checkpoint detection |
| `src/timeline.ts` | Maps video seconds → distance + clock; intro/outro, pauses (time-lapsed stays), slower on steep/slow parts |
| `src/sky.ts` | Sun & moon position, moon phase, sunrise/sunset search, sky colour ramps |
| `src/characters.ts` | The sprite standard, code-drawn Hiker/Runner/Dog/Cat, PNG sheet loader |
| `src/dem.ts` | Fetches Terrarium elevation tiles and samples them |
| `src/terrain.ts` | Height grid → mesh, diorama soil skirt, instanced trees, toon + headlamp shader |
| `src/renderer.ts` | Camera rig (look-ahead follow cam that lifts over ridges), trail lines, low-res render + palette/dither post pass |
| `src/overlay.ts` | Pixel-perfect sprites (hiker, flags, tents, confetti) and HUD, drawn on a 2D canvas |
| `src/sprites.ts`, `src/font.ts` | Props/HUD icons (flags, tent, campfire, aid station, moon phase) and a 5×7 bitmap font |
| `src/export.ts` | Deterministic frame-by-frame render → WebCodecs H.264 (+ AAC audio) → MP4 (mp4-muxer) |
| `src/audio.ts` | Bundled tracks, soundtrack rendering (OfflineAudioContext loop + fades), preview player / clock |
| `src/gate.ts` | Start/finish arch scenes (pixel stage, countdown, dissolve) and the mini arch for the map |
| `src/zones.ts` | Elevation zones + technical stretches, trail-side prop sprites (placed per frame in `renderer.ts`) |
| `src/logo.ts` | Event logo: background removal, crop, pixel-grid downsampling with colour reduction, outline |
| `src/store.ts` | Per-track saved settings and checkpoint pins/deletions (localStorage), merge with auto-detection |

## Your own characters (Grok Imagine + unfake.js)

See **[docs/SPRITE_SPEC.md](docs/SPRITE_SPEC.md)**: 16×16 frames facing right, a 64×128 sheet with 8 animation rows,
the 32-colour palette (`docs/palette.hex` / `.json`), prompt templates and unfake.js settings.
In the app: **Template PNG** downloads the current character's sheet to paint over; **Use my sprite sheet…** loads yours.

## Scripts

- `node scripts/shot.mjs <outdir> <3d|2d> <landscape|portrait> t1 t2 …` — screenshots at given video times (needs `npm run dev` on port 5199).
- `node scripts/export-test.mjs out.mp4 [mode] [aspect] [scale] [seconds]` — export in headless Chrome (use `BASE=` a `vite preview` URL so hot-reload can't interrupt it).
- `node scripts/e2e.mjs [outdir]` — end-to-end check: checkpoint edits survive activity switches and reloads, you-are-here row, MP4 with audio.
- `node scripts/sheets.mjs` — regenerate `docs/sprites/*.png` from the built-in characters.
- `node scripts/gpx-to-fit.mjs in.gpx out.fit` — make a FIT test file from a GPX (adds synthetic temperature/totals; test data only).

Music: "Chiptune Adventures" by Juhani Junkala, CC0 ([OpenGameArt](https://opengameart.org/content/4-chiptunes-adventure)).

Elevation data: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen; SRTM, GMTED, NED, ETOPO1 and others).
