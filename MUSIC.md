# Music for Parksmith

How to put your own music in the game. You don't need to change any code: put the files in `public/music/` and list
them in `public/music/manifest.json`. While no track is listed, the built-in synthesised loop plays.

## Contexts

| Context | Plays when | Falls back to |
|---|---|---|
| `menu` | the start screen is up | `park` |
| `park` | in the park, from dawn to dusk | the built-in loop |
| `night` | in the park at night (the park clock's Night) | `park` |

A change of context cross-fades over about 3 seconds. The first track listed for a context is the one that plays.

## Stems and layers

A track is 1–4 **stems**: files of exactly the same length, tempo and key that start together and loop together. Each
stem has a `from` value, the park intensity (0–1) from which it is fully audible. Below that it fades in over 0.15.
The intensity comes from the whole park: 60 % from guests (full at 400) and 40 % from running rides (full at 8). The
start screen is always at 0.

Suggested split:

| Stem | `from` | Content |
|---|---|---|
| 1 | 0 | bass and soft drums, the bed (always on) |
| 2 | 0.25 | chords and accompaniment |
| 3 | 0.5 | melody |
| 4 | 0.8 | extras: counter-melody, glockenspiel, shaker |

When `from` is left out, the stems spread evenly (0, 1/n, 2/n …).

## manifest.json

```json
{
  "tracks": [
    { "id": "menu-theme", "context": "menu", "stems": [{ "file": "menu.ogg" }] },
    {
      "id": "sunny-day",
      "context": "park",
      "gain": 1,
      "stems": [
        { "file": ["day-bed.ogg", "day-bed.flac"], "from": 0 },
        { "file": ["day-chords.ogg", "day-chords.flac"], "from": 0.25 },
        { "file": ["day-melody.ogg", "day-melody.flac"], "from": 0.5 },
        { "file": ["day-extra.ogg", "day-extra.flac"], "from": 0.8 }
      ]
    },
    { "id": "lantern-night", "context": "night", "loopStart": 4.0, "loopEnd": 68.0, "stems": [{ "file": "night.ogg" }] }
  ]
}
```

- `file`: a name inside `public/music/` (subfolders are fine), or a list of the same audio in several formats, best
  first. The game uses the first one the browser can play.
- `gain`: loudness trim for the whole track, 0–2.
- `loopStart` / `loopEnd` (seconds, optional): what comes before `loopStart` plays once as an intro, and the loop then
  runs from `loopStart` to `loopEnd`. Without them the whole file loops.
- An entry with a mistake is skipped, and a file that cannot be loaded or decoded is skipped for the session. In both
  cases the browser console warns, the rest still plays, and the built-in loop takes the place of what is missing.

## Formats

- **OGG** (Vorbis, `.ogg`) is the first choice: small, loops without a gap, plays in Chrome, Firefox, Edge and newer
  Safari. Use about 128 kbit/s at 48 kHz.
- **FLAC** (`.flac`) is the fallback for older Safari: lossless, loops without a gap, about half the size of WAV. List
  it second: `"file": ["day-bed.ogg", "day-bed.flac"]`.
- Avoid MP3 and M4A for loops: the encoder's padding can leave a gap at the seam. Keep WAV for your masters.
- In FL Studio: export with **Wrap remainder**, which folds the reverb tail into the start of the loop, and with
  **Split mixer tracks**, which writes one file per mixer track. Route the instruments to four mixer tracks (bed,
  chords, melody, extras) and each one becomes a stem.

## Making loops that sound right

- The loop length is a whole number of bars. Export every stem from bar 1 to the loop's end.
- There is no reverb tail across the seam. Render the tail and fold it into the start of the file, or use
  `loopStart` / `loopEnd` with an intro.
- Same tempo, key and length for every stem of a track, so that any combination of layers fits together.
- Loudness: about −16 LUFS for the full mix of all stems. The music bus already sits under the sound effects.

## Memory

Each stem is decoded to raw audio in memory: about **0.4 MB per second for each stereo stem** at 48 kHz. Four stereo
stems of 60 s come to roughly 90 MB. At most two tracks are held at once (the one playing and the one fading out). Keep
loops at 30–90 s, and make the bass and drum stems mono where you can, which halves them.

## The sound (suggestion)

The game is cosy voxel art, so the music can sound like the N64: sampled instruments at low resolution (or a sampler set
to 22–32 kHz), short samples, a little reverb. Instruments: marimba, band organ, accordion, glockenspiel, pizzicato,
soft brass. Composition and production are otherwise free: this is a modern player, not an emulated sound chip.

## Testing

`yarn dev`, then click once (the browser allows sound only after a gesture). The start screen plays `menu`, and a park
plays `park` or `night`. A park with many guests and running rides brings in the upper layers. The Music slider in
Settings and the mute key (M) control the music.
