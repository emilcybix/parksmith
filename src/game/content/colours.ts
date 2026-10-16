/**
 * Phase 28 step 1: colour customisation data. Pure content, no simulation reads it.
 *
 * Two things live here:
 *
 * - SWATCHES, the curated candy colours a player may pick. A saved colour is an index into this
 *   list, never a free RGB, so every choice stays inside the look of the game and inside the
 *   256-material voxel palette. The list is APPEND-ONLY: an index is the save format.
 * - SLOTS, per catalog definition, the ordered named parts of a model a swatch can repaint. The
 *   record stored on a placed object is aligned with this list (also append-only per definition).
 *   Both renderers use the same slot ids; each maps them to its own art (voxel blueprint tags,
 *   classic rideArt colours). Everything that is not a slot (steel, wood, glass, water, glow,
 *   riders, ground contact) stays fixed.
 *
 * Step 1 covered the ten flat rides. Step 2 adds the three coasters (4 slots), the shops and facilities
 * (2), the bench, bin, lollipop lamp, sunburst flowers and ripple fountain, and the entrance gate (a
 * park-level pseudo definition, ENTRANCE_COLOUR_ID). Trees, paths and fences stay fixed (see
 * ARCHITECTURE.md "Colour customisation" for why).
 */

/**
 * The slot vocabulary, which is also the role vocabulary of the presets (colourPresets.ts): a slot id
 * names a ROLE ("the main body colour", "the rails"), the per-definition `label` says what it paints
 * on that object. Step 1 used the first three; step 2 adds `rail` and `support` for coasters.
 */
export type ColourSlotId = 'primary' | 'secondary' | 'trim' | 'rail' | 'support';

export const COLOUR_SLOT_IDS: readonly ColourSlotId[] = ['primary', 'secondary', 'trim', 'rail', 'support'];

/**
 * @deprecated Step 1's tags, by slot id. A slot's compile/emit tag is now POSITIONAL (its index in the
 * definition's slot list plus one: `ColourSlotDef.tag`, `colourSlotTag`). For every flat ride the order is
 * primary, secondary, trim, so primary 1, secondary 2 and trim 3 are still right for them (a test pins that).
 * `rail` and `support` are listed only so old code that indexes by any ColourSlotId still compiles: they are
 * NOT the coaster tags (a coaster's rail is tag 3, its supports tag 4); use `colourSlotTag(definitionId, id)`.
 * 0 means "fixed". Tags fit three bits.
 */
export const COLOUR_SLOT_TAG: Readonly<Record<ColourSlotId, number>> = { primary: 1, secondary: 2, trim: 3, rail: 4, support: 5 };

/** The most slots any one object may declare (the coasters declare four). Tags 1..5 fit the 3-bit field. */
export const MAX_COLOUR_SLOTS = 5;

/**
 * The pseudo definition id of the entrance gate. The gate is not a placed object: its colours are a
 * park-level record (`GameWorld.gateColours`), validated and normalised through this id so every
 * colour helper works for it unchanged. It is never a catalog id.
 */
export const ENTRANCE_COLOUR_ID = 'park-entrance';

/** What kind of thing a colourable definition is (UI grouping and tests). */
export type ColourKind = 'ride' | 'coaster' | 'stall' | 'comfort' | 'scenery' | 'gate';

export interface ColourSlotDef {
  readonly id: ColourSlotId;
  /** Compile/emit tag: the slot's index in its definition's list plus one (1..MAX_COLOUR_SLOTS). */
  readonly tag: number;
  /** Short UI label ("Main"); fits a 64 px label column. */
  readonly label: string;
  /** What the slot paints: tooltip and accessible description. */
  readonly description: string;
  /** The colour the voxel renderer draws today for this slot (the UI's Default chip). */
  readonly defaultRgb: number;
  /**
   * The name of the default colour: the swatch's name when a swatch is exactly `defaultRgb`, else
   * its DEFAULT_COLOUR_NAMES entry (a colour no swatch offers any more, see SWATCH_SEEDS).
   */
  readonly defaultName: string;
}

export interface ColourSwatch {
  /** The save value. Never reorder, never delete. */
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly rgb: number;
  /** The colour the classic renderer draws. Equal to `rgb` for every swatch today. */
  readonly classicRgb: number;
  /** Row in the picker: an index into SWATCH_ROWS. */
  readonly row: number;
  /**
   * 'candy' (a colour: it must keep its saturation in every light) or 'neutral' (Cream, the white of
   * canopies and cabins: judged by its lightness against the ground instead). Only the readability
   * test reads it.
   */
  readonly tone: SwatchTone;
}

export type SwatchTone = 'candy' | 'neutral';

const SWATCH_ROW_DEFS = [
  { id: 'sunny', label: 'Sunny' },
  { id: 'berry', label: 'Berry' },
  { id: 'sea', label: 'Sea' },
] as const;

type SwatchSeed = readonly [id: string, name: string, rgb: number, row: number, tone?: SwatchTone];

/**
 * The swatches. Eleven are colours a flat ride already ships with (Cherry, Honey, Cream, Rose, Orchid,
 * Lavender, Violet, Ink, Sky, Mint, Teal) and Lagoon is another catalog colour, so those twelve cost no
 * palette material. The other nine were retuned from the catalog colours they started as, because the
 * readability test (rendering/voxel/colourContrast.test.ts) measured them greying out, vanishing on a
 * ground or collapsing into a neighbour in a real light: the catalog Sunflower 0xffd166, Lemon 0xf5f06c
 * and Apricot 0xf59e55 turn grey at night (saturation 0.12 to 0.21), Ice 0xbde0fe greys at dusk, Jade
 * 0x36c99f sinks into a plot at night, and Vermilion/Cherry, Bubblegum/Orchid, Indigo/Violet and
 * Harbour/Sky become one colour at dusk or night. Each moved as little as the floors allow, keeping its
 * hue. The five that were a ride's slot default moved visibly (24 RGB or more) and were renamed
 * (Buttercup, Citron, Glacier, Azure, Emerald): the default keeps its old name (DEFAULT_COLOUR_NAMES), so
 * the Default chip never names a swatch that would draw something else. Vermilion, Apricot, Bubblegum
 * and Indigo are no slot's default and kept their names.
 */
const SWATCH_SEEDS: readonly SwatchSeed[] = [
  ['cherry', 'Cherry', 0xc0392b, 0],
  ['vermilion', 'Vermilion', 0xfa6539, 0],
  ['apricot', 'Apricot', 0xfa9157, 0],
  ['honey', 'Honey', 0xe8b23a, 0],
  ['buttercup', 'Buttercup', 0xffea2b, 0],
  ['citron', 'Citron', 0xf4ff52, 0],
  ['cream', 'Cream', 0xfff0c8, 0, 'neutral'],
  ['rose', 'Rose', 0xef6f8f, 1],
  ['bubblegum', 'Bubblegum', 0xffa6ce, 1],
  ['orchid', 'Orchid', 0xd977b8, 1],
  ['lavender', 'Lavender', 0x8f7cf7, 1],
  ['violet', 'Violet', 0x9557d1, 1],
  ['indigo', 'Indigo', 0x6a49b3, 1],
  ['ink', 'Ink', 0x2b2d42, 1],
  ['glacier', 'Glacier', 0x96cfff, 2],
  ['sky', 'Sky', 0x53b7e8, 2],
  ['azure', 'Azure', 0x3a90c7, 2],
  ['mint', 'Mint', 0x61e7d3, 2],
  ['emerald', 'Emerald', 0x24d692, 2],
  ['teal', 'Teal', 0x3aa7a3, 2],
  ['lagoon', 'Lagoon', 0x1b7f79, 2],
];

export const COLOUR_SWATCHES: readonly ColourSwatch[] = Object.freeze(
  SWATCH_SEEDS.map(([id, name, rgb, row, tone = 'candy'], index): ColourSwatch => Object.freeze({ index, id, name, rgb, classicRgb: rgb, row, tone })),
);

export const SWATCH_COUNT: number = COLOUR_SWATCHES.length;

export const SWATCH_ROWS: readonly { readonly id: string; readonly label: string; readonly swatches: readonly number[] }[] = Object.freeze(
  SWATCH_ROW_DEFS.map((row, rowIndex) => Object.freeze({
    id: row.id,
    label: row.label,
    swatches: Object.freeze(COLOUR_SWATCHES.filter((swatch) => swatch.row === rowIndex).map((swatch) => swatch.index)),
  })),
);

/**
 * Names of the slot defaults that are no swatch (the catalog colours the swatches were retuned from).
 * Never a swatch's name: the Default chip must not name a swatch that would draw something else.
 */
export const DEFAULT_COLOUR_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0xffd166: 'Sunflower',
  0xf5f06c: 'Lemon',
  0x4c9fd4: 'Harbour',
  0xbde0fe: 'Ice',
  0x36c99f: 'Jade',
  // Step 2: the shipped colours of coasters, stalls, comforts, scenery and the gate.
  0xe4572e: 'Flame',
  0x7048c9: 'Amethyst',
  0x79543a: 'Timber',
  0x2c5b64: 'Steel',
  0x4d7f86: 'Pale steel',
  0xf59e55: 'Tangerine',
  0x48bfe3: 'Cyan',
  0x7fc8e8: 'Powder blue',
  0xe8d44d: 'Lemonade',
  0xb9743c: 'Caramel',
  0xf6b34f: 'Marigold',
  0x5a9b8f: 'Sage',
  0x4f8f86: 'Eucalyptus',
  0xffe2a8: 'Custard',
  0xd5f6ff: 'Frost',
  0xfff0f5: 'Blush white',
  0xfff0b8: 'Vanilla',
  0xe4fff7: 'Mist',
  0xcdf8ec: 'Seafoam',
  0xb96748: 'Terracotta',
  0x48786b: 'Moss',
  0x8ee3c5: 'Spearmint',
  0x335c67: 'Slate teal',
  0xffe66d: 'Lamp yellow',
  0xffcf56: 'Saffron',
  0xff7ca3: 'Carnation',
  0x4ea8de: 'Fountain blue',
  0xff6f91: 'Flamingo',
  0x254f4a: 'Pine',
  // Phase 22 (profile-gated entries): the Cactus Cooler walls and roof.
  0x2f855a: 'Clover',
  0xf687b3: 'Peony',
  // Phase 16: the Puddle Jumpers frogs and canopy (the catalog hex of the Sunburst Flowers bed, named for the first time).
  0x52b788: 'Lily pad',
});

/** The swatch that is exactly this colour, or undefined. */
export const swatchOfRgb = (rgb: number): ColourSwatch | undefined => COLOUR_SWATCHES.find((swatch) => swatch.rgb === rgb);

const defaultNameOf = (rgb: number): string => {
  const name = swatchOfRgb(rgb)?.name ?? DEFAULT_COLOUR_NAMES[rgb];
  if (name === undefined) throw new Error(`Colour slot default 0x${rgb.toString(16)} has no name: add it to DEFAULT_COLOUR_NAMES.`);
  return name;
};

type SlotSeed = readonly [id: ColourSlotId, label: string, description: string, defaultRgb: number];

/** Builds a frozen slot list; the tag of each slot is its position plus one. */
const table = (seeds: readonly SlotSeed[]): readonly ColourSlotDef[] => {
  if (seeds.length > MAX_COLOUR_SLOTS) throw new Error(`A definition may declare at most ${MAX_COLOUR_SLOTS} colour slots.`);
  return Object.freeze(seeds.map(([id, label, description, defaultRgb], index): ColourSlotDef => (
    Object.freeze({ id, tag: index + 1, label, description, defaultRgb, defaultName: defaultNameOf(defaultRgb) })
  )));
};

/** The flat rides keep step 1's labels. */
const flat = (id: ColourSlotId, description: string, defaultRgb: number): SlotSeed => (
  [id, id === 'primary' ? 'Main' : id === 'secondary' ? 'Accent' : 'Trim', description, defaultRgb]
);

/**
 * The slot tables of the flat rides. Order per ride is the save format: primary, secondary, then trim where
 * a ride has one. A slot's `defaultRgb` is the catalog `color` (primary) or `accent` (secondary); the trim
 * defaults are the fixed decorative colours the voxel blueprints use today (a test pins all of it against
 * the catalog).
 */
export const RIDE_COLOUR_SLOTS: Readonly<Record<string, readonly ColourSlotDef[]>> = Object.freeze({
  'petal-roundabout': table([
    flat('primary', 'Canopy stripes, petals, booth roof and every other bowl', 0xef6f8f),
    flat('secondary', 'Canopy stripes, valance, finial, hub ring and the other bowls', 0xffd166),
  ]),
  'comet-cups': table([
    flat('primary', 'Canopy, deck skirt, booth roof and half the cups', 0x8f7cf7),
    flat('secondary', 'Finial, turntable rim, booth cap and the other cups', 0x61e7d3),
  ]),
  'cloud-hopper': table([
    flat('primary', 'Tower core, winch house, booth roof and the car band', 0x53b7e8),
    flat('secondary', 'Beacon bars and cap, booth band and seat restraints', 0xffd166),
  ]),
  'aurora-wheel': table([
    flat('primary', 'Rim, inner ring, booth roof and cabin roofs', 0x36c99f),
    flat('secondary', 'Spokes, axle, booth band and every other cabin', 0xf5f06c),
    flat('trim', 'Cream cabins', 0xfff0c8),
  ]),
  'moonpetal-carousel': table([
    flat('primary', 'Platform, collar, canopy terraces, pennant and saddles', 0xd977b8),
    flat('secondary', 'Drum, canopy wedges and scallops', 0xfff0c8),
    flat('trim', 'Brass poles, finial and manes', 0xffd166),
  ]),
  'bumble-coach': table([
    flat('primary', 'Carriages and station roof stripes', 0xe8b23a),
    flat('secondary', 'Car bases, roof edge and chimney', 0x2b2d42),
  ]),
  'harbor-swings': table([
    flat('primary', 'Canopy layers and half the chairs', 0x4c9fd4),
    flat('secondary', 'Crown ring, valance, finial, deck skirt and the other chairs', 0xffd166),
    flat('trim', 'Canopy stripes', 0xfff0c8),
  ]),
  'splash-rings': table([
    flat('primary', 'Arches, mast cone and half the boats', 0x3aa7a3),
    flat('secondary', 'Mast stripes and the other boats', 0xbde0fe),
  ]),
  'gale-spinner': table([
    flat('primary', 'Arm, gale ring and the first pod hub', 0x9557d1),
    flat('secondary', 'Second pod hub, hub caps and deck skirt', 0x61e7d3),
  ]),
  'thunder-drum': table([
    flat('primary', 'Drum wall and crown ring', 0xc0392b),
    flat('secondary', 'Drum bands and deck skirt', 0xf5f06c),
  ]),
  // Phase 22 (profile-gated): the slot table is like Comet Cups; the tub and totem art reads these two slots.
  'tiki-tumbler': table([
    flat('primary', 'Thatched canopy, deck skirt, booth roof and half the tubs', 0xb96748),
    flat('secondary', 'Totem finial, turntable rim, booth cap and the other tubs', 0x61e7d3),
  ]),
  // Phase 16.
  'puddle-jumpers': table([
    flat('primary', 'Frogs, canopy stripes and booth roof', 0x52b788),
    flat('secondary', 'Lily pads, frog eyes, valance, finial, canopy stripes and deck skirt', 0xffcf56),
  ]),
  'rocket-pendulum': table([
    flat('primary', 'A-frames, arm and the rocket body', 0x7048c9),
    flat('secondary', 'Nose cone, fins, seat ring, frame caps and deck skirt', 0x61e7d3),
  ]),
  'temple-trek': table([
    flat('primary', 'Temple terraces and booth roof', 0xb96748),
    flat('secondary', 'Gold roof, frieze, finial and the mine cart', 0xffd166),
  ]),
});

/**
 * Coasters: four slots, in this order (the save format). The chain, wheels, chassis, couplings, lamp
 * glow, riders, brakes, chevrons, platform stone and footings stay fixed.
 */
const coaster = (train: number, seats: number, rails: number, supports: number): readonly ColourSlotDef[] => table([
  ['primary', 'Train', 'Train body, nose and stripes, and the station canopy stripes', train],
  ['secondary', 'Seats', 'Seats, restraints and the train trim band', seats],
  ['rail', 'Rails', 'Running rails, station valance, platform edge and queue gate', rails],
  ['support', 'Supports', 'Support bents, spine and ties', supports],
]);

export const COASTER_COLOUR_SLOTS: Readonly<Record<string, readonly ColourSlotDef[]>> = Object.freeze({
  'comet-trail': coaster(0xe4572e, 0xffd166, 0xffd166, 0x79543a),
  'star-chaser': coaster(0x7048c9, 0x61e7d3, 0x61e7d3, 0x2c5b64),
  'skyline-serpent': coaster(0x1b7f79, 0xf5f06c, 0xf5f06c, 0x4d7f86),
  // Phase 39: catalog colours only, so the voxel palette gains no material.
  'whisker-mouse': coaster(0x4c9fd4, 0xef6f8f, 0xef6f8f, 0x4d7f86),
  'timber-twister': coaster(0xc0392b, 0xffd166, 0xffd166, 0x79543a),
  'thunder-launch': coaster(0x9557d1, 0xf5f06c, 0xf5f06c, 0x2c5b64),
  'bat-wing': coaster(0x335c67, 0xffe66d, 0xffe66d, 0x4d7f86),
  'titan-hyper': coaster(0xc0392b, 0xf5f06c, 0xf5f06c, 0x2c5b64),
});

const shop = (walls: number, roof: number): readonly ColourSlotDef[] => table([
  ['primary', 'Walls', 'Walls, gable ends, awning stripes and the cup or sign icon', walls],
  ['secondary', 'Roof', 'Roof, corner posts, counter and the pale awning stripes', roof],
]);

/** Shops and facilities (the service inspector kinds): two slots each. */
export const STALL_COLOUR_SLOTS: Readonly<Record<string, readonly ColourSlotDef[]>> = Object.freeze({
  'picnic-pocket': shop(0xf59e55, 0xffe2a8),
  'fizz-foundry': shop(0x48bfe3, 0xd5f6ff),
  'glacier-scoop': shop(0x7fc8e8, 0xfff0f5),
  'lemon-light': shop(0xe8d44d, 0xd5f6ff),
  'waffle-windmill': shop(0xb9743c, 0xffe2a8),
  'snack-sprint': shop(0xf6b34f, 0xfff0b8),
  'cactus-cooler': shop(0x2f855a, 0xf687b3),
  'cocoa-chalet': shop(0xc0392b, 0xfff0f5),
  'comfort-cabin': shop(0x5a9b8f, 0xe4fff7),
  'comfort-pavilion': shop(0x4f8f86, 0xcdf8ec),
  // Phase 16.
  'pretzel-pram': shop(0xb9743c, 0xffe2a8),
  'coconut-cove': shop(0x3aa7a3, 0xbde0fe),
  // Phase 29.
  'brolly-booth': shop(0x4c9fd4, 0xfff0c8),
  'hat-hutch': shop(0xe8b23a, 0xfff0c8),
  'balloon-bouquet': shop(0xef6f8f, 0xffd166),
  'plushie-parlour': shop(0xd977b8, 0xfff0c8),
  'glow-cart': shop(0x8f7cf7, 0x61e7d3),
  'bean-barrow': shop(0xb9743c, 0xfff0f5),
});

/** Benches and bins. */
export const COMFORT_COLOUR_SLOTS: Readonly<Record<string, readonly ColourSlotDef[]>> = Object.freeze({
  'ribbon-bench': table([
    ['primary', 'Seat', 'Seat planks', 0xb96748],
    ['secondary', 'Back', 'Backrest plank', 0xffd166],
  ]),
  'tidy-totem': table([
    ['primary', 'Body', 'Bin body', 0x48786b],
    ['secondary', 'Lid', 'Band and lid', 0x8ee3c5],
  ]),
});

/** Scenery with a colour variant. Trees and rocks are fixed on purpose. */
export const SCENERY_COLOUR_SLOTS: Readonly<Record<string, readonly ColourSlotDef[]>> = Object.freeze({
  'lollipop-lamp': table([
    ['primary', 'Post', 'Foot and pole (the lamp glow stays fixed)', 0x335c67],
    ['secondary', 'Cap', 'Cap above the globe', 0xffe66d],
  ]),
  'sunburst-flowers': table([
    ['primary', 'Blooms', 'Yellow blooms and rays (the bed stays green)', 0xffcf56],
    ['secondary', 'Petals', 'Pink petals and hearts', 0xff7ca3],
  ]),
  'ripple-fountain': table([
    ['primary', 'Basin', 'Bowl, coping and underside (stone, water and spray stay fixed)', 0x4ea8de],
  ]),
  // Phase 16 themed scenery (themedScenery.ts): 'primary' is the catalog colour, 'secondary' the accent. The tiki torch's
  // accent tongues belong to its flame and stay fixed, so it has one slot.
  'bunting-mast': table([
    ['primary', 'Bands', 'Mast bands and every other pennant', 0xef6f8f],
    ['secondary', 'Pennants', 'Finial and the other pennants', 0xffd166],
  ]),
  'shell-planter': table([
    ['primary', 'Shell', 'Shell fan and planter bowl (the foliage and blossoms stay fixed)', 0x7fc8e8],
    ['secondary', 'Ribs', 'Ribs of the shell', 0xfff0f5],
  ]),
  'harbor-lighthouse': table([
    ['primary', 'Stripes', 'Every other tower band and the roof (the lamp glow stays fixed)', 0x4c9fd4],
    ['secondary', 'Bands', 'The other tower bands and the gallery', 0xfff0c8],
  ]),
  'tiki-torch': table([
    ['primary', 'Bindings', 'Pole bindings and the bowl rim (the flame stays fixed)', 0xe4572e],
  ]),
  'jungle-idol': table([
    ['primary', 'Stone', 'Head, ears, brow and nose (the stone plinth stays fixed)', 0x48786b],
    ['secondary', 'Jade', 'Eyes and crown', 0x8ee3c5],
  ]),
  'neon-pylon': table([
    ['primary', 'Obelisk', 'The obelisk (the beacon stays fixed)', 0x1b7f79],
    ['secondary', 'Neon', 'Neon strips and bands', 0x61e7d3],
  ]),
  'orbit-globe': table([
    ['primary', 'Globe', 'The globe', 0x8f7cf7],
    ['secondary', 'Orbits', 'Orbit rings and the equator band (the white moons stay fixed)', 0x61e7d3],
  ]),
});

/** The entrance gate, a park-level record under ENTRANCE_COLOUR_ID. Lettering and lantern lights stay fixed. */
export const ENTRANCE_COLOUR_SLOTS: Readonly<Record<string, readonly ColourSlotDef[]>> = Object.freeze({
  [ENTRANCE_COLOUR_ID]: table([
    ['primary', 'Arch', 'Arch ring and lantern housings', 0xff6f91],
    ['secondary', 'Sign', 'Sign board behind the lettering', 0xffd166],
    ['trim', 'Posts', 'The two gate posts', 0x254f4a],
  ]),
});

/** Every colourable id (the catalog ones and ENTRANCE_COLOUR_ID) with its ordered slots. */
export const COLOUR_SLOTS: Readonly<Record<string, readonly ColourSlotDef[]>> = Object.freeze({
  ...RIDE_COLOUR_SLOTS,
  ...COASTER_COLOUR_SLOTS,
  ...STALL_COLOUR_SLOTS,
  ...COMFORT_COLOUR_SLOTS,
  ...SCENERY_COLOUR_SLOTS,
  ...ENTRANCE_COLOUR_SLOTS,
});

const KIND_TABLES: readonly (readonly [ColourKind, Readonly<Record<string, readonly ColourSlotDef[]>>])[] = [
  ['ride', RIDE_COLOUR_SLOTS],
  ['coaster', COASTER_COLOUR_SLOTS],
  ['stall', STALL_COLOUR_SLOTS],
  ['comfort', COMFORT_COLOUR_SLOTS],
  ['scenery', SCENERY_COLOUR_SLOTS],
  ['gate', ENTRANCE_COLOUR_SLOTS],
];

/** The catalog ids that can be recoloured, in a stable order (no pseudo ids). */
export const COLOURABLE_DEFINITION_IDS: readonly string[] = Object.freeze(
  KIND_TABLES.filter(([kind]) => kind !== 'gate').flatMap(([, slots]) => Object.keys(slots)),
);

/** The kind of a colourable definition (or ENTRANCE_COLOUR_ID), null for everything else. */
export const colourKindOf = (definitionId: string): ColourKind | null => {
  for (const [kind, slots] of KIND_TABLES) if (Object.hasOwn(slots, definitionId)) return kind;
  return null;
};

const NO_SLOTS: readonly ColourSlotDef[] = Object.freeze([]);

/** The ordered slots of a definition (or of ENTRANCE_COLOUR_ID); empty when it is not colourable. */
export const colourSlotsFor = (definitionId: string): readonly ColourSlotDef[] => (
  Object.hasOwn(COLOUR_SLOTS, definitionId) ? COLOUR_SLOTS[definitionId] : NO_SLOTS
);

/**
 * The compile/emit tag of a definition's slot (its index plus one). Throws when the definition has no such
 * slot: content that tags a part with a slot the table does not declare is a bug, caught at authoring time.
 */
export const colourSlotTag = (definitionId: string, slotId: ColourSlotId): number => {
  const found = colourSlotsFor(definitionId).find((candidate) => candidate.id === slotId);
  if (!found) throw new Error(`${definitionId} has no colour slot '${slotId}'`);
  return found.tag;
};

export const isColourable = (definitionId: string): boolean => colourSlotsFor(definitionId).length > 0;

/**
 * A placed object's colours: one entry per slot of its definition, a swatch index or null for the
 * slot default. Frozen and replaced (never mutated) on change, so a renderer may diff by identity.
 * An all-null record is never stored: that is "no record".
 */
export type ObjectColours = readonly (number | null)[];

const isSwatchIndex = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < SWATCH_COUNT
);

const freezeRecord = (entries: (number | null)[]): ObjectColours | null => (
  entries.every((entry) => entry === null) ? null : Object.freeze(entries)
);

/**
 * Strict check for the world API (a UI or a bug handing in garbage is refused, not repaired):
 * the array must have exactly one entry per slot, each null or a valid swatch index. Returns the
 * frozen record, null when every slot is default, or 'invalid'.
 */
export const validateObjectColours = (definitionId: string, colours: unknown): ObjectColours | null | 'invalid' => {
  const slots = colourSlotsFor(definitionId);
  if (slots.length === 0 || !Array.isArray(colours) || colours.length !== slots.length) return 'invalid';
  const entries: (number | null)[] = [];
  for (const entry of colours as unknown[]) {
    if (entry === null) entries.push(null);
    else if (isSwatchIndex(entry)) entries.push(entry);
    else return 'invalid';
  }
  return freezeRecord(entries);
};

/**
 * Lenient normaliser for restore: colours are cosmetic and cannot desync any owner, and slot lists
 * may grow in later versions, so a save is repaired rather than refused. A record on a definition
 * that is not colourable is dropped; a wrong length is padded with null or truncated; an entry that
 * is not a valid swatch index becomes null (default); an all-default result is no record.
 */
export const normaliseObjectColours = (definitionId: string, raw: unknown): ObjectColours | null => {
  const slots = colourSlotsFor(definitionId);
  if (slots.length === 0 || !Array.isArray(raw)) return null;
  const entries: (number | null)[] = [];
  for (let index = 0; index < slots.length; index += 1) {
    const entry: unknown = index < raw.length ? (raw as unknown[])[index] : null;
    entries.push(isSwatchIndex(entry) ? entry : null);
  }
  return freezeRecord(entries);
};

/**
 * Whether picking `swatch` for slot `slotIndex` of the definition is picking its default: the swatch is
 * exactly the slot's default colour. The edit path stores null for it and the classic art draws its
 * default for it, so the swatch the Default chip names never changes the picture in either renderer
 * (the voxel default and that swatch are the same palette material already).
 */
export const isSlotDefaultSwatch = (definitionId: string, slotIndex: number, swatch: number): boolean => {
  const slotDef = colourSlotsFor(definitionId)[slotIndex];
  return slotDef !== undefined && isSwatchIndex(swatch) && COLOUR_SWATCHES[swatch].rgb === slotDef.defaultRgb;
};

/** Value equality of two records (null and undefined both mean "defaults"). */
export const sameObjectColours = (a: ObjectColours | null | undefined, b: ObjectColours | null | undefined): boolean => {
  if (!a || !b) return !a && !b;
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
};
