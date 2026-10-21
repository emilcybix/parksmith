import { version } from '../../package.json';

/**
 * What the About panel of the start screen shows: the game version (the one number in
 * package.json, never typed twice) and a short static changelog. Phase 19 put it in the pause menu too, with the
 * feedback form; it is data so it can grow without touching the panel.
 */
export const GAME_VERSION: string = version;

/**
 * Phase 56: the credits the sounds' licences ask for (CC-BY and the like), one line each, shown under About. Every
 * file's source and licence is listed in SOUND.md; a file that asks for attribution gets its line here.
 */
export const SOUND_CREDITS: readonly string[] = [];

export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  changes: readonly string[];
}

/** Newest first. Keep each entry to a handful of lines a player would care about. */
export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    version: '0.3.2',
    date: '2026-10',
    title: 'Faster start and fewer snags',
    changes: [
      'A faster first load: the game downloads less before the park appears, and the classic renderer only when it is needed.',
      'Settings, Save / Load and the Paint panel are fetched in the background once the park is on screen, so they open at once.',
      'A mute key (M) that turns all sound off and back on, and says which.',
      'A crowd heatmap key (T), the same as the crowd flow button. Both keys can be changed in Settings > Keyboard.',
      'The cards list in Park Pulse says when there are more cards below.',
    ],
  },
  {
    version: '0.3.1',
    date: '2026-10',
    title: 'Safer autosaves and clearer cards',
    changes: [
      'Two autosave generations: if the latest autosave cannot be read, Continue and crash recovery fall back to the one before it.',
      'Locked build cards state what their research needs: points, cash, the study before it and any rating.',
      'The Treats tab is now Shops: food, drinks and souvenir stalls.',
      'Estates show the land you own and the next parcel price in the Overview.',
      'The weather popover says what rain, heat and night do to guests and which souvenirs sell.',
      'The top bar names the park you are playing.',
      'The game was re-measured for balance and a seated guest no longer jumps onto the bench.',
    ],
  },
  {
    version: '0.3.0',
    date: '2026-10',
    title: 'Guest life and the guest inspector',
    changes: [
      'Guest life: benches to rest on, queasy riders after intense rides, heat, cold and rain that guests feel, and souvenir stalls (umbrellas, sun hats, balloons, plush toys, glow wands).',
      'A guest inspector: click a guest to see what they are doing, thinking and needing, what they like and what they carry.',
      'Complaint links: when guests complain about a queue or a price, Park Pulse and the Activity tab link straight to the building.',
      'Turn the whole map view a quarter at a time (Q and E); coasters climb, crawl and chain realistically with a lift readout.',
      'Colours: paint any building, pick a palette for the whole park, and choose a colour before placing.',
      'Build filters: rides by kind, shops by what they sell and scenery by theme.',
      'Older saves still load.',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-10',
    title: 'Estates and sound',
    changes: [
      'Estates: 64 x 64 maps where you own the land by the gate and buy the rest parcel by parcel (Meadow Estate, or Generate with Estate on).',
      'Room to Grow, a scenario about buying land, and the Land surveyor bonus.',
      'Money pops where you spend or earn it, the cash counter counts, and rides, stalls and guests react on screen.',
      'Sound: music, a crowd and machinery ambience that follows the camera, and cues, with six volume sliders.',
      'Crowd flow: busy paths, a heatmap and named neighborhoods; twelve new rides, stalls and decorations; a bigger card pool.',
      'A loading screen, an error screen that can recover your last save, and a feedback report under About.',
      'Settings > Graphics: choose the renderer and a lighter light-and-shading mode for a weak graphics card.',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10',
    title: 'Garden Gate alpha',
    changes: [
      'Start screen and pause menu, with a slow camera drift over your latest park.',
      'Saves: autosave, ten manual slots, crash recovery and whole-park undo.',
      'Settings: UI scale, reduced motion, weather effects, camera speed, autosave interval.',
      'A day and night cycle, weather and optional opening hours in the sandbox.',
      'The Map: a run of generated parks with a deck of cards, plus Scenario and Sandbox modes.',
      'A voxel renderer by default, with the classic renderer as the fallback.',
    ],
  },
];

export const latestChangelogEntry = (): ChangelogEntry => CHANGELOG[0];
