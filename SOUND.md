# Sound effects for Parksmith

How the game's sound effects work and how to put your own in. The music has its own guide (MUSIC.md).

Recorded effects live in `public/sfx/` (`ui/`, `coasters/`, `ambience/`). Unlike the music they have no manifest: the
cue each file plays is set in `src/audio/AudioEngine.ts` (`SOUND_FILES` for one-shots, `EMITTER_FILES` for positional
loops, `BED_FILES` for the park beds). Every cue that has a built-in synthesised version falls back to it while its
file is missing, still loading or fails to decode. A recorded-only cue (marked * below) is then not heard.

## Which file plays when

| File | Plays when |
|---|---|
| `ui/ui_click.ogg` | a button in the interface is pressed |
| `ui/build_land.ogg` | something is built |
| `ui/build_water.ogg` | a water ride or water scenery is built (Splash Rings, Ripple Fountain) |
| `ui/purchase_cash.ogg` | the player spends money (a build, paths, land) |
| `ui/repair_hammer.ogg` | a mechanic finishes a repair |
| `ui/notify_message.ogg` | an important message appears (objective, level, capacity …) |
| `ui/ui_error.ogg` | an action is refused, or another alert appears |
| `ui/facility_toilet_flush.ogg` * | a guest uses a toilet |
| `ui/water_splash_big.ogg` * | a Splash Rings cycle ends |
| `ui/water_splash_small.ogg` * | a Puddle Jumpers cycle ends |
| `ui/water_splash_crackle.ogg` * | loops at every Ripple Fountain |
| `coasters/ride_track_roll.ogg` * | loops where a coaster train rolls: louder and higher the faster it goes |
| `coasters/ride_lift_chain.ogg` * | loops while a train climbs a chain lift |
| `coasters/ride_launch_long.ogg` * | a shuttle (Thunder Launch) fires from its station; a launch piece |
| `coasters/ride_launch_short.ogg` * | a train passes a boost piece |
| `coasters/scream.mp3` * | riders on a big drop or an inversion, now and then as an intense ride leaves, and a shuttle launch |
| `coasters/ride_crash.ogg` * | a coaster breaks down |
| `coasters/ride_lift_motor.ogg` * | loops at every other running flat ride (its motor) |
| `coasters/ride_train_steam.ogg` * | loops while the Bumble Coach runs |
| `coasters/ride_steam.ogg` * | the Bumble Coach leaves the station |
| `coasters/ride_train_engine.ogg` * | loops while Temple Trek's carts run |
| `coasters/ride_gokart.ogg` | not used yet (there is no go-kart ride) |
| `ambience/park_ambience1.mp3` * | the daytime park bed (quieter in rain) |
| `ambience/park_ambience3.mp3` * | the crowd bed, with the guests near the middle of the screen |
| `ambience/park_ambience4.mp3` * | the chatter layer, only when it is busy |
| `ambience/park_ambience2.mp3` * | the rides bed, with the running rides near the middle of the screen |
| `ambience/weather_thunder_near.ogg` * | thunder from a near bolt in a storm (stronger storms are nearer) |
| `ambience/weather_thunder_far.ogg` * | thunder from a far bolt |

### Synthesised only, for now

These play from `src/audio/synth.ts` until a recording is added. To add one, put the file in `public/sfx/` and list it
under the cue's id in `SOUND_FILES` (a one-shot). The rain and night beds are loops in `renderLoop` and would need a
`BED_FILES` entry and a line in `bedLevel`.

| Cue id | Plays when | Suggested file |
|---|---|---|
| `bell` | a coaster train leaves its station (the dispatch bell) | `coasters/ride_bell.ogg` |
| `whoosh` | a train goes over a crest that drops; louder the deeper the drop | `coasters/ride_whoosh.ogg` |
| `brake` | a train comes back into its station (the brakes) | `coasters/ride_brake.ogg` |
| `rain` (bed) | in rain and storms, fuller the harder it rains | `ambience/weather_rain.ogg` |
| `night` (bed) | crickets at night (quieter in rain) | `ambience/park_night.ogg` |

## Coaster events

Worked out from the track and where the train is (`src/audio/rideSounds.ts`). It only reads the simulation and never
changes it. Each event fires once, as the train enters its piece:

| Event | Where | Cue |
|---|---|---|
| Dispatch | the train leaves the station after loading | `bell`; on an intense ride (intensity over 50) sometimes `scream` |
| Chain lift | while the train is on a chained piece | `chain` loop |
| Crest | a piece the next one is lower than | `whoosh`, louder with the drop's depth |
| Big drop | a crest that drops 2 levels or more | `scream`, by chance |
| Inversion | a loop, corkscrew, zero-g roll or cobra roll | `scream`, by chance |
| Boost / launch | a boost or launch piece | `boost` / `launch` |
| Brakes | the train enters the station again | `brake` |
| Rolling | the whole ride | `roll` loop, pitch from 0.75× to 1.25× with the speed |
| Shuttle | Thunder Launch fires from its station | `launch` and `scream` |

The scream's chance grows with the ride's intensity (0.2 at intensity 0, certain from 64) and so does its loudness. The
chance is a hash of the ride, the lap and the piece, so the same lap always screams the same way.

## How a sound is heard

- **Where it is:** every park sound is full in the middle of the screen, about half at the edge, faint just beyond and
  silent a screen away. It is panned left or right by where it is on screen. A coaster off-screen is not heard.
- **The zoom:** zoomed all the way in only the park is heard, all the way out only the music (an equal-power
  cross-fade). The music keeps playing underneath, so zooming out picks it up where it was. The start screen is all
  music. The UI sounds are never scaled.
- **Voice budget:** at most 10 positional loops play at once (`MAX_VOICES`); the loudest win.
- **Paused:** coasters and rides are silent and fire no events; only the fountains keep splashing.
- **Buses:** coaster and ride sounds are on the Rides bus, the beds and thunder on Ambience, the toilet on Guests, the
  interface on UI. The Settings sliders and the mute key (M) cover them all.
- **Repeats:** each cue has a shortest gap between two plays (`SOUND_GAP_MS`), so a burst is heard as one sound.

## Variants

A cue in `SOUND_FILES` may list several files instead of one:

```ts
scream: ['coasters/scream.mp3', 'coasters/scream2.ogg', 'coasters/scream3.ogg'],
```

The files play in turn, so a repeated drop does not sound looped. A variant that fails to load is just left out.

## Formats and levels

- **OGG Vorbis** (`.ogg`) first. **MP3** works in every browser too; the four park beds are MP3.
- **One-shots:** short, mono, peaking around -6 dBFS, with no silence at the start.
- **Loops** (positional loops and beds): they must loop seamlessly with no click at the seam. The file loops from
  start to end; there are no loop points. Keep the positional loops short (1–4 s) and the beds 30–90 s.
- **Loudness:** level the beds about 10 dB under the one-shots. They are texture, and the game scales them down again.
- **Memory:** every file is decoded into memory at the first click. A stereo minute at 48 kHz is about 23 MB, so keep
  beds mono or short where you can.

## Testing a new file without a build

1. `yarn dev`, open the game and click once (the browser allows sound only after a gesture).
2. Replace a file in `public/sfx/` with the same name and reload the page. The new file plays; nothing has to be
   rebuilt. A built game (`dist/sfx/`) picks up a replaced file the same way.
3. A new file name, or a variant, needs one line in `SOUND_FILES` (the dev server reloads by itself).
4. A file that does not play: check the browser console's network tab. A wrong path is answered with the page itself,
   which fails to decode, and the synthesised cue plays instead.

For coasters, build one near the gate, zoom all the way in over it and follow the train. For rain and night, use the
sandbox weather and time settings.

## Licences

Every file's source and licence. Every file so far was generated with Claude (claude.ai) for this game, so none asks
for a credit. A file from elsewhere that does (CC-BY, for example a freesound file) also needs its credit line in
`SOUND_CREDITS` (`src/ui/aboutModel.ts`), which shows it under About.

| File | Source | Licence | Credit line |
|---|---|---|---|
| `ambience/park_ambience1.mp3` | generated with Claude (claude.ai) | the game's own | |
| `ambience/park_ambience2.mp3` | generated with Claude (claude.ai) | the game's own | |
| `ambience/park_ambience3.mp3` | generated with Claude (claude.ai) | the game's own | |
| `ambience/park_ambience4.mp3` | generated with Claude (claude.ai) | the game's own | |
| `ambience/weather_thunder_far.ogg` | generated with Claude (claude.ai) | the game's own | |
| `ambience/weather_thunder_near.ogg` | generated with Claude (claude.ai) | the game's own | |
| `coasters/ride_crash.ogg` | generated with Claude (claude.ai) | the game's own | |
| `coasters/ride_gokart.ogg` | generated with Claude (claude.ai) | the game's own | |
| `coasters/ride_launch_long.ogg` | generated with Claude (claude.ai) | the game's own | |
| `coasters/ride_launch_short.ogg` | generated with Claude (claude.ai) | the game's own | |
| `coasters/ride_lift_chain.ogg` | generated with Claude (claude.ai) | the game's own | |
| `coasters/ride_lift_motor.ogg` | generated with Claude (claude.ai) | the game's own | |
| `coasters/ride_steam.ogg` | generated with Claude (claude.ai) | the game's own | |
| `coasters/ride_track_roll.ogg` | generated with Claude (claude.ai) | the game's own | |
| `coasters/ride_train_engine.ogg` | generated with Claude (claude.ai) | the game's own | |
| `coasters/ride_train_steam.ogg` | generated with Claude (claude.ai) | the game's own | |
| `coasters/scream.mp3` | generated with Claude (claude.ai) | the game's own | |
| `ui/build_land.ogg` | generated with Claude (claude.ai) | the game's own | |
| `ui/build_water.ogg` | generated with Claude (claude.ai) | the game's own | |
| `ui/facility_toilet_flush.ogg` | generated with Claude (claude.ai) | the game's own | |
| `ui/notify_message.ogg` | generated with Claude (claude.ai) | the game's own | |
| `ui/purchase_cash.ogg` | generated with Claude (claude.ai) | the game's own | |
| `ui/repair_hammer.ogg` | generated with Claude (claude.ai) | the game's own | |
| `ui/ui_click.ogg` | generated with Claude (claude.ai) | the game's own | |
| `ui/ui_error.ogg` | generated with Claude (claude.ai) | the game's own | |
| `ui/water_splash_big.ogg` | generated with Claude (claude.ai) | the game's own | |
| `ui/water_splash_crackle.ogg` | generated with Claude (claude.ai) | the game's own | |
| `ui/water_splash_small.ogg` | generated with Claude (claude.ai) | the game's own | |

The synthesised sounds (`src/audio/synth.ts`) are the game's own.
