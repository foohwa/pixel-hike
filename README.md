# Pixel Hike

Turn a GPX workout into a cute pixel-art route video — like Relive / Strava Flyover / Suunto 3D playback, but chunky.

- **3D diorama** — real terrain (free AWS Terrain Tiles) rendered at 320×180 and quantised to a 32-colour palette, camera follows a chibi hiker along the track.
- **2D map** — top-down retro topo map with contour lines.
- **Activities** — *Hike*, *Camp hike* (stops of 2 h+ become campsites; the clock time-lapses through the night while you sleep in the tent) and *Trail run* (runner sprite, aid-station checkpoints, race timer + moving pace, FINISHER card). Guessed from the file, switchable.
- **Checkpoints** — summit, other peaks (by prominence), rests, campsites, aid stations, viewpoints and finish. Auto-detected; rename, change type, delete, or add your own at the current scrub position.
- **Characters** — Hiker, Runner, Dog or Cat, each male or female, plus an optional dog/cat buddy. Animations switch with the terrain (walk, climb > 15 %, careful descent, run, cheer, rest, sleep). All follow one [sprite standard](docs/SPRITE_SPEC.md), so you can drop in your own sheet.
- **Day & night** — sun and moon positions (and the real moon phase) are computed from your GPS + timestamps: sky colours, stars, a head-lamp at night, a little sun/moon dial, and SUNRISE / SUNSET pop-ups.
- **Start / finish arch** — race-day opening and ending scenes: a lit arch with your banner text, event logos and tagline, START/FINISH pillars, a 3·2·1·GO! countdown, the runner (and buddy) sprinting off, a pixel dissolve into the map, and a FINISHER! scene with the finish time. Auto-on for trail runs; colour selectable; small arches mark start/finish on the map.
- **Scenery** — *Auto* picks by location: **tropical rainforest** (dense lumpy canopy, tall emergent trees, small moss-green trees and mossy ground above 1,500 m) or **alpine** (pines thinning out to a real treeline by latitude, then meadow, rock and snow). *Classic* keeps the original look.
- **Clouds & mist** — mist pools in the valleys around sunrise (trees poke through it, cleared around you) and burns off by mid-morning; drifting cloud shadows by day; pixel clouds above the horizon.
- **Local wildlife** — a few encounters picked for where you hiked, the height and the time of day: hornbills crossing the sky, macaques by the trail and a Malayan tapir at night in Southeast Asian rainforest; parrots and monkeys in other tropics; marmots, ibex and golden eagles up high; deer, rabbits and hawks in temperate woods; butterflies round you by day. Ground animals sit beside the trail and dash (or hop) off as you pass, with a pop-up naming them.
- **Fireflies & birds** — fireflies on low jungle nights, a flock crossing around sunrise/sunset, and the head-lamp throws a beam ahead instead of a round pool.
- **Real sun & moon light** — ridges cast shadows along the real sun direction (ray-marched over a height map, works in 3D and 2D): valleys stay in the range's shadow after sunrise while high ridges catch first light, and low evening sun throws long shadows. At night the light comes from the real moon's position, as bright as its phase; starlight only when it's down.
- **Real weather** — the day's hourly weather for the area from [Open-Meteo](https://open-meteo.com/) (free, no key; only a rough location rounded to ~10 km and the dates are sent, and the answer is kept in the browser): pixel rain (drizzle → downpour) with splashes, grey overcast skies and dimmer sun, more mist, thunderstorms with lightning flashes, a RAIN / STORM line in the HUD and a "RAIN STARTS" pop-up. Without a watch thermometer the HUD shows the model's air temperature adjusted to your height. The sidebar sums it up ("Rain 11:29–17:44"); or pick *Always clear*, *Drizzle*, *Rain* or *Thunderstorm*.
- **Rivers, lakes & roads** — rivers, streams, lakes, reservoirs, roads and dirt tracks from OpenStreetMap (downloaded once per area as pre-cut vector tiles from OpenFreeMap — a few seconds — and kept in the browser's IndexedDB, so reopening a route needs no network; springs and waterfalls, which the tiles leave out, come from a small Overpass query in the background, and the full Overpass query is the fallback if the tile server is down), draped on the terrain with the canopy cleared along their banks; a pop-up names each river you cross (each name at most once per 15 km). The route is split into trail / tar road / dirt track (shown under the preview); local roads without a surface tag count as tar. Terrain tiles are cached the same way. `node scripts/bake-map.mjs` saves the sample route's map next to the private sample (`public/samples/map-<area>.json`, git-ignored) so the dev server opens it instantly and offline. Data © OpenStreetMap contributors (ODbL).
- **River & road look** — rivers get a real-width water surface with lighter banks and glints drifting downstream (moonlight on the water on bright nights); main roads are a dark band with a dashed centre line, dirt tracks are dotted, and residential lanes are only drawn near the route so towns don't turn into a grey scribble. Little bridges where the route crosses water on a road, cars and motorbikes on nearby roads (headlights at night), street lights along main roads and town streets at night, and white water on steep streams.
- **Viewpoints & landmarks** — OpenStreetMap viewpoints beside the trail (plus the most open high ground the terrain finder can spot) become *Viewpoint* checkpoints: the walker stops, the banner slides away and the camera swings round towards the view. Summits and rest stops take the names mapped there (GUNUNG KORBU, KEM BALAK); camps get a little sign and a pop-up, springs a water drop, and waterfalls are drawn on the map; one within ~2.5 km of the route is also shown beside the trail where you pass closest, with an arrow sign and a "1.5KM AWAY" pop-up — in 3D as a cliff built into the hillside with falling water and a splash pool, in 2D as a sprite. Switch it off under *Checkpoints*.
- **Summit signs & aid tents** — a signboard with the name and height next to you at summits/peaks (the banner just shouts SUMMIT!), and a striped aid tent with a volunteer and water at race checkpoints.
- **Splits & next** — each checkpoint banner adds the leg: distance, climb and time since the previous checkpoint; a NEXT line shows the coming checkpoint with distance and climb to go.
- **"Me" character** — dress the character in your own kit: headwear (headlamp, headband, cap, bucket hat), hair, skin, top + sleeves, shorts/pants, race vest/backpack, shoes, bib, poles, wristband. Preset: the KORGA UTR race kit from the finish photos. Saved per track.
- **Trail zones** (optional, off by default — open the collapsed "Trail zones" section) — the trail is dressed by elevation: lowland jungle (ferns, palms), montane forest, mossy forest (moss cushions, beard-moss trees, pitcher plants), rocky ridge or alpine meadow. Tropical tracks default to real cloud-forest heights (1,000 m / 1,500 m); elsewhere the bands split the track's own range. Steep stretches (>~28%) get fixed ropes, roots, rock steps and a warning sign; the elevation profile is coloured by zone and a toast names each new zone. Props darken at night except inside the head-lamp glow.
- **Event logo** — upload a race/event logo: its flat background is removed and it's re-drawn on an exact pixel grid (dominant colour per cell, 2–6 colours or the game palette). Shown on the intro card, as a corner badge and on the finish card; saved with your edits.
- **Photo moments** — add photos from the hike (JPEG; multi-select). Each finds its spot on the trail by its GPS tag (on loops, the pass that matches its time), else its time taken, else the file date; anything else lands at the scrubber (move any photo with ⌖). At each photo the walker stops, a camera flash, and the photo drops in as a pixel-art polaroid beside them, captioned with the time + km or your own caption. Colours: game palette (dithered) or the photo's own. Saved with the track's edits as small copies (never uploaded).
- **Speech bubbles** — type a line, *+ Bubble here*, and the character says it at that spot, typed out like game dialogue (beside them when a checkpoint banner is up).
- **Heart-rate effects** — on your hardest stretches (the top ~15 % of this hike's heart rate) the character flashes yellow on each heartbeat and sweats; near your max (top ~3 %) it blinks red like a game character taking damage, puffs and plods. The HUD heart turns yellow / red too. Without a heart rate, steep climbs just make you sweat.
- **Data HUD** — distance, elevation, clock (or race timer + pace), pulsing heart rate, temperature (FIT), elevation profile, minimap.
- **Music** — four bundled CC0 chiptunes by Juhani Junkala (auto-picked per activity), or your own file. Looped to the video length with a fade-out, played in the preview and muxed into the MP4 as AAC. Credits in [`public/music/CREDITS.md`](public/music/CREDITS.md).
- **Remembers your edits** — renamed / retyped / hidden / deleted / added checkpoints and all settings are saved per track in your browser (localStorage) and survive activity changes and reloads. The GPX/FIT file itself is never modified. *Reset edits* forgets them.
- **You are here** — a marker in the checkpoint list follows the hiker; passed checkpoints grey out, click a checkpoint's km line to jump there.
- **Pixel poster** — *Poster PNG* makes a 1080×1350 still of the whole hike as a game level map: title and date, the route on the 3D diorama (or the 2D map, whichever view you picked) lit by a good time of day, with its checkpoint flags and the summit's name, six stat tiles, up to four of your photos as little polaroids, the elevation profile and your character cheering (plus the event logo).
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
| `src/dem.ts` | Fetches Terrarium elevation tiles (cached in IndexedDB) and samples them |
| `src/water.ts` | Map data loading order (cache → baked sample → tiles → Overpass), rivers/lakes/roads in 3D, route surface split |
| `src/osmtiles.ts` | OpenFreeMap vector tiles: protobuf decoding, clipping to tile edges, rejoining rivers/roads cut at edges, lake pieces grouped to one water level |
| `src/cache.ts` | Small IndexedDB key/value store for map data and terrain tiles |
| `src/terrain.ts` | Height grid → mesh, diorama soil skirt, instanced trees, toon + headlamp shader |
| `src/renderer.ts` | Camera rig (look-ahead follow cam that lifts over ridges), trail lines, low-res render + palette/dither post pass |
| `src/overlay.ts` | Pixel-perfect sprites (hiker, flags, tents, confetti) and HUD, drawn on a 2D canvas |
| `src/sprites.ts`, `src/font.ts` | Props/HUD icons (flags, tent, campfire, aid station, moon phase) and a 5×7 bitmap font |
| `src/export.ts` | Deterministic frame-by-frame render → WebCodecs H.264 (+ AAC audio) → MP4 (mp4-muxer) |
| `src/audio.ts` | Bundled tracks, soundtrack rendering (OfflineAudioContext loop + fades), preview player / clock |
| `src/gate.ts` | Start/finish arch scenes (pixel stage, countdown, dissolve) and the mini arch for the map |
| `src/hero3d.ts` | The walker + companion standing in the 3D scene: pixel-exact camera-facing quads at their depth, lit by the scene, casting silhouette shadows along the sun / moon |
| `src/sites3d.ts` | Checkpoint set pieces built into the 3D terrain: aid station (red gazebos), camp (tents, fire ring), rest bench, summit cairn + signboard, viewpoint deck, start/finish arch; real flags that raise on arrival; lit at night |
| `src/falls3d.ts` | 3D waterfall (rock cliff, animated water curtain, splash pool) set into the terrain |
| `src/landmarks.ts` | Viewpoint finder (OSM viewpoints + terrain openness) and naming checkpoints after mapped peaks / camps |
| `src/zones.ts` | Elevation zones + technical stretches, trail-side prop sprites (placed per frame in `renderer.ts`) |
| `src/effort.ts` | Heart-rate effort zones (from the track's own heart-rate spread), the flash / sweat / breath effects |
| `src/moments.ts`, `src/exif.ts` | Photo moments (EXIF time / GPS → spot on the track, pixel-art polaroid) and speech bubbles |
| `src/weather.ts` | Open-Meteo hourly weather (cached), weather at a moment, rain / splash / lightning drawing |
| `src/wildlife.ts` | Region → species, encounter planning along the track, animal sprites and how they move |
| `src/poster.ts` | The PNG poster: route snapshot (`PixelRenderer.snapshot`), stats tiles, photos, profile |
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
- `node scripts/bake-map.mjs` — save the sample route's map data to `public/samples/map-<area>.json` (git-ignored) so the dev server opens it instantly and offline.
- `node scripts/gpx-to-fit.mjs in.gpx out.fit` — make a FIT test file from a GPX (adds synthetic temperature/totals; test data only).

The browser scripts use the machine's GPU (`scripts/browser.mjs`). On a machine without one (CI), set `SWIFTSHADER=1` for software WebGL — it works, but is ~90× slower (the e2e takes ~7 min instead of ~13 s).

Music: "Chiptune Adventures" by Juhani Junkala, CC0 ([OpenGameArt](https://opengameart.org/content/4-chiptunes-adventure)).

Map tiles: [OpenFreeMap](https://openfreemap.org) (OpenStreetMap data, OpenMapTiles schema).

Elevation data: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen; SRTM, GMTED, NED, ETOPO1 and others).
