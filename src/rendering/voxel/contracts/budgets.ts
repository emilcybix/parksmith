/**
 * Performance budgets the voxel renderer is built and tested against. The hard constraint is that
 * the game keeps running well in a browser on low-tier machines, so every budget here is about the
 * cheapest hardware the park should still play on (Intel UHD-class iGPUs, Mali/Adreno phones).
 */

/**
 * Most low-res texels the G-buffer and composite may cover. The smallest zoom N (device px per
 * texel) is the smallest one whose target fits, so a DPR-2 laptop or DPR-3 phone never runs the
 * composite at full backing-store resolution. 2.2 Mtexel keeps 1080p at DPR 1 at N = 1.
 */
export const LOW_RES_TEXEL_BUDGET = 2_200_000;

/** Extra texels on every side of the low-res target so composite taps never read outside it. */
export const GUARD_BAND_TEXELS = 6;

/** Largest zoom, in CSS px per texel. */
export const MAX_ZOOM_CSS_PER_TEXEL = 4;

/** Texture fetches per texel the composite may spend in the heaviest preset. */
export const COMPOSITE_FETCH_BUDGET = 16;

/**
 * Box budgets per compiled model, all parts included, after hollowing. The coaster entries are
 * per track piece (content/coaster.ts, Phase 27 step 2: two rails on ties over a spine, banked
 * corners, a support bent per raised piece, a chain on climbs), measured on the fixture layouts:
 * - a flat straight piece is 11 boxes at level 0 and 15 to 26 raised (its bent: footings, legs,
 *   beam, then a rung and a diagonal brace per 12-voxel bay);
 * - a straight ramp is 55 to 85 (every layer in one-voxel treads: 13 a level), a crest 30 to 60;
 * - a flat corner is about 78 (staircases of two rails, seven radial ties and the spine, banked),
 *   a corner that climbs, falls or crests 100 to 155;
 * - a loop ring adds about 180 (rails, ties and the spine of the ring);
 * - a train (Phase 27 step 3) is rigid parts uploaded once with the station's chunk: per car up to 48
 *   boxes (body, chassis, wheels, seat rows, restraints, a lead nose or the serpent's tail: 27 to 46),
 *   its riders 3 or 4 per seat (the type's capacity spread over its cars: 9 per comet car, 8 per star
 *   chaser car, 8 or 4 per serpent car), a coupling two half-bars of 2: 166 (comet, 4 cars), 229 (star
 *   chaser, 5) and 257 (serpent, 6) in all, on 4 · cars − 2 transform slots (14, 18 and 22);
 * - a station piece adds up to about 20 (platform, edge, post, canopy, valance, bulbs, gate,
 *   dispatch light, stone bed), a boost 20, a chained climb up to 10, the brake run 6.
 */
export const BOX_BUDGET = {
  bespokeRide: 2_500,
  genericRide: 1_500,
  kiosk: 400,
  entrance: 600,
  tree: 600,
  lampOrFlowers: 150,
  benchOrBin: 40,
  fountain: 400,
  coasterPerPiece: 14,
  coasterRampPerArm: 36,
  coasterBentPerLevel: 10,
  coasterTurnPiece: 92,
  coasterRampedTurnPiece: 130,
  coasterLoopRing: 210,
  coasterCar: 48,
  /** One car's riders (up to four seats of 4 boxes; measured 9 at most). */
  coasterRiders: 16,
  /** One coupling HALF-bar (two per coupling; measured 2). */
  coasterCoupling: 3,
  /** A whole train: every car, its riders and both halves of every coupling (measured 166, 229 and 257 for comet, star chaser and serpent). */
  coasterTrain: 300,
  figure: 8,
  /** Phase 29: a guest carrying a souvenir (umbrella, balloon, plush, glow wand): the guest's 8 plus 2 for the prop. */
  figureWithProp: 10,
  /**
   * Phase 24 map props (content/props), per kind at both quarter turns after hollowing, measured in content/props.test.ts:
   * a 1x1 prop is 3 to 113 boxes (the palm's segment fronds are the most expensive), a 2x1 log or driftwood 37 to 108, a 2x2
   * (great oak, sea stack, rock spire, glacier rock, temple ruin) 21 to 32. Props are stepped domes (two crossing boxes a
   * layer) rather than ellipsoids, which is what keeps a forest of them inside PROP_MAP_BOX_BUDGET.
   */
  prop: 120,
  propLong: 160,
  propLarge: 320,
} as const;

/**
 * Whole coasters, measured (content/coasterBudget.test.ts) on the fixture layouts of
 * `game/coaster/testLayouts.ts` with about 15 % headroom: the 16-piece developer-park coaster
 * (735 boxes of track, 964 with its star-chaser train), the longest layout the designer allows (64
 * pieces, 44 corners, hills 0 to 4: 6 500 of track, 6 757 with its train of 257, 1 802 in its
 * heaviest track chunk and 1 953 in the heaviest chunk with a train in it, 5 chunks rebuilt once in
 * about 25 ms on the software path), and three 64-piece coasters on an otherwise empty 32 × 32 map
 * (two of the longest and a 64-piece rectangle, trains included: 17 950), well inside
 * DEV_PARK_BOX_BUDGET, so even a park of worst-case coasters costs less than the developer park's
 * full content.
 */
export const COASTER_BOX_BUDGET = {
  /** The 16-piece dev-park coaster's track alone. */
  devPark: 900,
  /** Track plus the serpent's train. */
  longest: 7_800,
  threeLongest: 20_800,
  heaviestChunk: 2_300,
} as const;

/**
 * Phase 24 prop maps, measured (scene/scene.props.test.ts) on the seven shipped maps with REGISTRY content, with about 15 %
 * headroom: the densest map (Frosted Hollow) is 7 870 static boxes, the heaviest chunk 1 003 (the refreshed Seaside Cove: palms and the gate,
 * down from 1 408; the densest forests are 700 to 860), one chunk rebuilds (what clearing a prop costs) in well under a millisecond in Node (0.27 ms
 * at most; the bar is 3 ms), and the worst park a player can build on a prop map (a path grid and the heaviest 3x3 ride on every
 * free plot) is 61 400 boxes on Brookside Meadow, the map with the fewest props. All far inside the developer park's 30 000 for
 * the maps as shipped and MAX_PARK_BOX_BUDGET for a full park.
 *
 * Phase 24 step 2: GENERATED maps are inside the same budgets by construction (scene.generated.test.ts). The generator caps the summed
 * PROP_BOX_WEIGHT per chunk (1 400) and per map (8 600), the weights are asserted to bound the measured boxes, and 500 seeds per biome
 * at normal and high density are checked: heaviest prop chunk 1 424 (Seaside, high, seed 70; 1 433 boxes in the real scene with its
 * terrain and gate) + at most 126 overhead per chunk <= 1 650, heaviest prop total 8 312 + at most 238 overhead <= 9 100. The tide rock
 * and the boardwalk pier are small (at most 40 boxes each).
 */
/** Phase 21: `total` and `worstPark` (and MAX_PARK_BOX_BUDGET) are per 32 x 32 of map area; an estate scales them by its area. */
export const PROP_MAP_BOX_BUDGET = {
  /** All static boxes of a shipped prop map as it starts (measured 7 870). */
  total: 9_100,
  /** The heaviest chunk of a shipped map (measured 1 003, Seaside Cove; a generated Seaside at high density reaches 1 433). */
  heaviestChunk: 1_650,
  /** The heaviest chunk's rebuild, median of 15 frames, milliseconds in Node (measured 0.27). */
  rebuildMs: 3,
  /** The worst park on a prop map (measured 61 389). */
  worstPark: 70_700,
} as const;

/** The developer park, all chunks together. */
export const DEV_PARK_BOX_BUDGET = 30_000;
/** A 32×32 map packed with the heaviest ride on every free 3×3 plot (per 32 x 32 of area: an estate scales it, Phase 21). */
export const MAX_PARK_BOX_BUDGET = 150_000;

/**
 * Above this rasterised area (Σ ab + bc + ca over boxes) per exposed face, the compiler tries a
 * hollowed mesh (kept if it adds < 25 % boxes and rasterises less). It is a REPORTED metric, not a
 * content gate: round and layered shapes stay at 4–9 whatever the author does, and front-to-back box
 * order lets real GPUs reject the hidden fragments early. Box counts are the gate.
 */
export const RASTER_TO_EXPOSED_RATIO = 3;

/** No single blueprint compile slice may run longer than this at 1× (ms). */
export const COMPILE_SLICE_MS = 8;
/** Idle prewarm budget per frame (ms). */
export const PREWARM_BUDGET_MS = 4;
