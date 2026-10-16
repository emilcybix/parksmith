import type { BuildDefinition, SouvenirKind } from '../../../game/types';
import { LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import type { Blueprint, LightSource, Shape, Vec3 } from '../contracts/blueprint';
import type { ObjectContent } from '../contracts/content';
import { MAT, MAT_COLOR, PATTERN } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { PLOT_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import { slotTagger } from './colourTags';

/**
 * One parameterised builder for every shop and facility (design §12, kiosk): walls inset 4 and 30
 * tall in the catalog colour, a stepped gable roof in the accent, a door, a glazed service window
 * under a striped awning, and an icon on the ridge that says what the building serves. Everything
 * is laid out from the footprint, so the 2×2 kiosks, the 2×1 Snack Sprint and Pretzel Pram (Phase 16)
 * and the 3×2 Comfort Pavilion all come out of the same code.
 *
 * Model space (contracts/blueprint.ts): the unrotated footprint, origin at its minimum corner,
 * shapes from the plot top z = 1 up, the front (door, window, awning) on model +y. The ridge runs
 * along model x, the footprint's longer side, so the roof slopes over the short side and stays low
 * on the 2×1 and 3×2 plots, and its front slope and eave face the path like the shop front does.
 *
 * Colour identity comes from the catalog: walls, every other awning stripe and the drink icon's cup
 * in the colour; roof, corner posts, counter and the other stripes, both ends included, in the
 * accent. Fixed colours (door, icons) are looked up through the palette like any colour; only the
 * glass is named by its MAT id, because colours never resolve to flagged materials
 * (contracts/palette.ts).
 *
 * The camera looks down the view ray (1, 1, 1) (space.ts), so anything standing d voxels in front of
 * a wall hides the d rows of wall below it. The awning is placed against that rule: the front
 * features are judged by how much of them the camera actually sees, not by which faces are exposed.
 */

/** Walls stand this far inside the footprint on every side (art bible). */
export const KIOSK_WALL_INSET = 4;
export const KIOSK_WALL_HEIGHT = 30;
/** The roof reaches this far past the walls on every side (art bible). */
export const KIOSK_ROOF_OVERHANG = 3;
/** Art-bible ceiling of the ridge; the whole model, ridge icon included, stays under it too. */
export const KIOSK_TOP_LIMIT = 58;
export const KIOSK_DOOR_WIDTH = 12;
export const KIOSK_DOOR_HEIGHT = 22;
/** The service window spans z [10, 22) (art bible). */
export const KIOSK_WINDOW_BOTTOM_Z = 10;
export const KIOSK_WINDOW_TOP_Z = 22;
/**
 * From 4a to 4b + 1 in model x, the WINDOW pattern's pane frames (every 4th voxel, patterns.ts) close
 * both of the window's sides: six 3-voxel panes.
 */
export const KIOSK_WINDOW_WIDTH = 25;
/**
 * Door and window sit this deep in the wall: 2 voxels is the smallest step the composite outlines
 * (gbuffer.ts SILHOUETTE_MIN_RESIDUAL), so every opening gets a crisp frame of outline texels. The
 * price is the lintel: the 2 rows under an opening's top edge are always out of view.
 */
export const KIOSK_OPENING_DEPTH = 2;
/**
 * The awning is 5 deep counting the wall voxel it hangs from — all the room the 4-voxel wall inset
 * leaves in front of the wall — in 4-wide stripes (art bible).
 */
export const KIOSK_AWNING_DEPTH = 5;
export const KIOSK_STRIPE_WIDTH = 4;
/**
 * Where the awning meets the wall. Its front edge stands 6 voxels in front of the recessed glass,
 * so it hides the 6 window rows under its lowest voxel; the eave (3 out, at z 31) in turn hides
 * any part of the awning's top that lies further behind the eave's edge than below the eave.
 * At 28 all of the striped slope outside the wall stays in view and the valances end at z 24–25, so
 * the window shows 8–9 of the 10 rows its lintel leaves visible — about two thirds of the glass at
 * both quarter turns, where an awning at 25 showed barely a quarter, a 2-row slit that glowed as a
 * dashed line at night. Higher still, the eave swallows the awning's slope and it reads as a fringe.
 */
export const KIOSK_AWNING_TOP_Z = 28;
/** The ridge icon's footprint (art bible: one 8×8 icon per service kind). */
export const KIOSK_ICON_SIZE = 8;
/** The lit service window's pool of light (art bible), on at dusk and night like the glass glow. */
export const KIOSK_WINDOW_LIGHT_RADIUS = 28;
/**
 * The gable-end windows glow too, so each gets a light, at the art bible's small radius (the ride
 * bulbs'): a halo on the gable wall around the pane. At the service window's 28 the whole gable end
 * lit up brighter than the shop front, and the service window must stay the focal point at night.
 */
export const KIOSK_SIDE_WINDOW_LIGHT_RADIUS = 16;
export const KIOSK_LIGHT_PRESETS = LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT;

const WALL_TOP_Z = PLOT_TOP_Z + KIOSK_WALL_HEIGHT;
/** Corner posts: 3×3 accent trim standing one voxel proud of both walls it joins. */
const POST_SIZE = 3;
/**
 * The accent shell of the roof, measured along the slope: each 1:2 step is 2 voxels deep, so 4
 * covers the step and the 2 voxels under the next one, and the wall-coloured core never shows on
 * a tread — only at the gable ends, where it is meant to.
 */
const ROOF_SHELL_DEPTH = 4;
/** Gable-wall windows: 2×2 panes, framed on every side (y and z from 4a to 4b + 1). */
const SIDE_WINDOW_SIZE = 9;
const SIDE_WINDOW_BOTTOM_Z = 12;
/** Shops serve over a counter under the window, 3 deep and 2 tall, in the accent. */
const COUNTER_DEPTH = 3;
const COUNTER_HEIGHT = 2;
/**
 * The valances hang this far below the awning's top: the accent stripes' to z 24, the colour
 * stripes' a voxel shorter, so the scalloped edge is the pale one and stands off the wall.
 */
const ACCENT_VALANCE_DROP = 4;
const COLOR_VALANCE_DROP = 3;
/** Every light stands this far in front of the wall its window is in. */
const LIGHT_OFFSET = 3;
/**
 * The service window's light sits at the counter, the window's bottom edge: its pool then falls on
 * the path where the queue stands. At mid-window height the paving, 15 voxels down, got under a
 * quarter of the light and the pool dithered away to a few sparks.
 */
const WINDOW_LIGHT_Z = KIOSK_WINDOW_BOTTOM_Z;
/** The icon sinks this far into the ridge, so it sits on the roof instead of hovering over it. */
const ICON_SINK = 1;
/** Drink icon: a straight cup (6 across), 6 tall under a 1-voxel lid of the same radius. */
const CUP_RADIUS = 3;
const CUP_HEIGHT = 6;
/**
 * The straw rises in 2-voxel steps, each leaning one voxel toward model +x. Model +x projects to the
 * screen's right at quarter turn 0 and, turned to world −y, at quarter turn 1 too, so the straw
 * leans right at both — a straw, not the centred stub that made the old cup read as a cupcake.
 */
const STRAW_STEPS = 3;
const STRAW_STEP_HEIGHT = 2;
/** Icon colours: a golden bun, a brown patty and green lettuce; a white lid and a pink straw. */
const BUN_COLOR = MAT_COLOR.HAIR_BLOND;
const PATTY_COLOR = MAT_COLOR.HAIR_BROWN;
const LETTUCE_COLOR = MAT_COLOR.FOLIAGE;
const LID_COLOR = MAT_COLOR.WHITE;
const STRAW_COLOR = MAT_COLOR.ARCH_PINK;
const SIGN_COLOR = MAT_COLOR.WHITE;

/** A half-open run of model x, [from, to). */
export interface KioskSpan {
  from: number;
  to: number;
}

/** Where the openings go along the front wall (model x). */
export interface KioskFrontLayout {
  doors: readonly KioskSpan[];
  window: KioskSpan;
  awning: KioskSpan;
}

type ServiceType = NonNullable<NonNullable<BuildDefinition['stats']>['serviceType']>;

const box = (min: Vec3, size: Vec3, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'box', min, size, material, pattern });

/**
 * The layout covers footprints two or more tiles wide (the front needs a window and a door side by
 * side) and at most two tiles deep (a deeper gable would lift the ridge icon past the art-bible
 * ceiling). The catalog's 2×2, 2×1 and 3×2 all fit; anything else fails loudly, and the scene then
 * shows the placeholder block instead of a kiosk with its window hanging off the wall.
 */
const assertSupportedFootprint = (definition: BuildDefinition): void => {
  const [tilesWide, tilesDeep] = definition.footprint;
  if (tilesWide >= 2 && tilesDeep >= 1 && tilesDeep <= 2) return;
  throw new Error(`kiosk '${definition.id}': footprint ${tilesWide}×${tilesDeep} is not supported `
    + '(needs 2+ tiles along x and 1–2 along y).');
};

/**
 * Door, window and awning along the front. Two tiles wide: the window on the left and the door on
 * the right, as seen on screen at both quarter turns; three tiles wide: the window centred between
 * two doors, one per side of the comfort stop. Facilities stretch the awning over their doors too,
 * shops shade only the counter. Every edge is a whole voxel and the window starts on a multiple of 4.
 */
export const kioskFrontLayout = (definition: BuildDefinition): KioskFrontLayout => {
  const width = definition.footprint[0] * VOXELS_PER_TILE;
  const wallMin = KIOSK_WALL_INSET;
  const wallMax = width - KIOSK_WALL_INSET;
  const facility = definition.kind === 'facility';
  if (width >= 3 * VOXELS_PER_TILE) {
    // Centred to the voxel (12 voxels either side of the middle one), starting on a multiple of 4.
    const windowFrom = width / 2 - (KIOSK_WINDOW_WIDTH - 1) / 2;
    const doors = [
      { from: wallMin + 8, to: wallMin + 8 + KIOSK_DOOR_WIDTH },
      { from: wallMax - 8 - KIOSK_DOOR_WIDTH, to: wallMax - 8 },
    ];
    const window = { from: windowFrom, to: windowFrom + KIOSK_WINDOW_WIDTH };
    const awning = facility ? { from: doors[0].from - 2, to: doors[1].to + 2 } : { from: window.from - 2, to: window.to + 2 };
    return { doors, window, awning };
  }
  const window = { from: wallMin + 8, to: wallMin + 8 + KIOSK_WINDOW_WIDTH };
  const door = { from: wallMax - 6 - KIOSK_DOOR_WIDTH, to: wallMax - 6 };
  const awning = facility ? { from: window.from - 2, to: door.to + 2 } : { from: window.from - 2, to: window.to + 2 };
  return { doors: [door], window, awning };
};

/** An opening in the front wall: carve the recess, then face its back with a 1-voxel panel. */
const opening = (span: KioskSpan, frontY: number, fromZ: number, toZ: number, material: number, pattern: number): Shape[] => [
  box([span.from, frontY - KIOSK_OPENING_DEPTH, fromZ], [span.to - span.from, KIOSK_OPENING_DEPTH, toZ - fromZ], 0),
  box([span.from, frontY - KIOSK_OPENING_DEPTH - 1, fromZ], [span.to - span.from, 1, toZ - fromZ], material, pattern),
];

/**
 * A small window in each gable wall. Only one gable end faces the camera at a time — model +x at
 * quarter turn 0, model −x (world +y) at quarter turn 1 — so each quarter turn shows one of them.
 */
const sideWindows = (width: number, depth: number): Shape[] => {
  const fromY = depth / 2 - 4;
  const rightFace = width - KIOSK_WALL_INSET;
  const size: Vec3 = [1, SIDE_WINDOW_SIZE, SIDE_WINDOW_SIZE];
  const recess: Vec3 = [KIOSK_OPENING_DEPTH, SIDE_WINDOW_SIZE, SIDE_WINDOW_SIZE];
  return [
    box([rightFace - KIOSK_OPENING_DEPTH, fromY, SIDE_WINDOW_BOTTOM_Z], recess, 0),
    box([rightFace - KIOSK_OPENING_DEPTH - 1, fromY, SIDE_WINDOW_BOTTOM_Z], size, MAT.GLASS, PATTERN.WINDOW),
    box([KIOSK_WALL_INSET, fromY, SIDE_WINDOW_BOTTOM_Z], recess, 0),
    box([KIOSK_WALL_INSET + KIOSK_OPENING_DEPTH, fromY, SIDE_WINDOW_BOTTOM_Z], size, MAT.GLASS, PATTERN.WINDOW),
  ];
};

/**
 * The awning: 4-wide stripes, the largest odd count that fits the span, centred on it, in the accent
 * at both ends and every other stripe and in the catalog colour between. The colour is the wall's,
 * so colour stripes at the ends melted into the wall and left pale blocks hanging in the air; pale
 * ends frame the awning instead. Seen from the side each stripe falls a voxel every 2 like the roof
 * above it — a 2-deep strip that starts inside the wall, a 2-deep strip a voxel lower, then a 1-deep
 * valance — and the accent valances hang a voxel lower: a scalloped edge that reads as canvas
 * rather than a plank.
 */
const awningShapes = (span: KioskSpan, frontY: number, accent: number, color: number): Shape[] => {
  let stripes = Math.max(1, Math.floor((span.to - span.from) / KIOSK_STRIPE_WIDTH));
  if (stripes % 2 === 0) stripes -= 1;
  const start = Math.round((span.from + span.to) / 2 - (stripes * KIOSK_STRIPE_WIDTH) / 2);
  const top = KIOSK_AWNING_TOP_Z;
  const shapes: Shape[] = [];
  for (let stripe = 0; stripe < stripes; stripe += 1) {
    const pale = stripe % 2 === 0;
    const material = pale ? accent : color;
    const x = start + stripe * KIOSK_STRIPE_WIDTH;
    const valanceBottom = top - (pale ? ACCENT_VALANCE_DROP : COLOR_VALANCE_DROP);
    shapes.push(
      box([x, frontY - 1, top - 2], [KIOSK_STRIPE_WIDTH, 2, 2], material),
      box([x, frontY + 1, top - 3], [KIOSK_STRIPE_WIDTH, 2, 2], material),
      box([x, frontY + 3, valanceBottom], [KIOSK_STRIPE_WIDTH, KIOSK_AWNING_DEPTH - 4, top - 2 - valanceBottom], material),
    );
  }
  return shapes;
};

/**
 * The stepped gable (1:2 in 1-voxel steps, the compiler's 'gable' shape) over the walls and the
 * overhang, ridge along model x. The accent shell covers every tread and riser; the overhang under
 * the barge boards is hollowed at both gable ends, and a wall-coloured core fills each gable end
 * flush with the wall below, so the end reads as a wall-coloured triangle under accent barge boards
 * that stand the overhang proud of it. Returns the shapes and the ridge's top z.
 */
const roofShapes = (width: number, depth: number, roof: number, wall: number, wallPattern: number): { shapes: Shape[]; ridgeTop: number } => {
  const minX = KIOSK_WALL_INSET - KIOSK_ROOF_OVERHANG;
  const minY = minX;
  const roofWidth = width - 2 * minX;
  const roofDepth = depth - 2 * minY;
  // Layer n spans y ∈ [minY + 2n, depth − minY − 2n); the last non-empty layer is the ridge.
  const layers = Math.ceil(roofDepth / 4);
  const coreMinY = minY + ROOF_SHELL_DEPTH;
  const coreDepth = roofDepth - 2 * ROOF_SHELL_DEPTH;
  const gable = (min: Vec3, size: Vec3, material: number, pattern: number = PATTERN.PLAIN): Shape =>
    ({ kind: 'gable', min, size, ridge: 'x', material, pattern });
  return {
    shapes: [
      gable([minX, minY, WALL_TOP_Z], [roofWidth, roofDepth, layers], roof, PATTERN.ROOF),
      gable([minX, coreMinY, WALL_TOP_Z], [KIOSK_ROOF_OVERHANG, coreDepth, layers], 0),
      gable([width - KIOSK_WALL_INSET, coreMinY, WALL_TOP_Z], [KIOSK_ROOF_OVERHANG, coreDepth, layers], 0),
      gable([KIOSK_WALL_INSET, coreMinY, WALL_TOP_Z], [width - 2 * KIOSK_WALL_INSET, coreDepth, layers], wall, wallPattern),
    ],
    ridgeTop: WALL_TOP_Z + layers,
  };
};

/** A round layer of an icon: a disc about the icon's centre (radius 4 is an 8-wide octagon). */
const disc = (centreX: number, centreY: number, z: number, height: number, radius: number, material: number): Shape =>
  ({ kind: 'cylinder', base: [centreX, centreY, z], radius, length: height, axis: 'z', material });

/** Food: a burger — bun, patty, a line of lettuce and a domed top bun. */
const burgerIcon = (centreX: number, centreY: number, z: number, palette: Palette): Shape[] => {
  const bun = palette.material(BUN_COLOR);
  return [
    disc(centreX, centreY, z, 2, 4, bun),
    disc(centreX, centreY, z + 2, 2, 4, palette.material(PATTY_COLOR)),
    disc(centreX, centreY, z + 4, 1, 4, palette.material(LETTUCE_COLOR)),
    disc(centreX, centreY, z + 5, 2, 4, bun),
    disc(centreX, centreY, z + 7, 1, 3, bun),
  ];
};

/**
 * Drink: a straight cup in the shop's colour under a white lid, with a pink straw rising out of the
 * lid's back half and leaning right. The old flared cup with a wide white lid and a centred straw
 * stub read as a cupcake — food — on the one icon that has to say "drinks".
 */
const cupIcon = (centreX: number, centreY: number, z: number, cup: number, palette: Palette): Shape[] => {
  const straw = palette.material(STRAW_COLOR);
  const lidZ = z + CUP_HEIGHT;
  const shapes: Shape[] = [
    disc(centreX, centreY, z, CUP_HEIGHT, CUP_RADIUS, cup),
    disc(centreX, centreY, lidZ, 1, CUP_RADIUS, palette.material(LID_COLOR)),
  ];
  for (let step = 0; step < STRAW_STEPS; step += 1) {
    shapes.push(box([centreX - 1 + step, centreY - 2, lidZ + step * STRAW_STEP_HEIGHT], [2, 2, STRAW_STEP_HEIGHT], straw));
  }
  return shapes;
};

/** Toilet: an upright white sign facing the front, with a door in the building's colour on it. */
const doorSignIcon = (centreX: number, centreY: number, z: number, door: number, palette: Palette): Shape[] => {
  const half = KIOSK_ICON_SIZE / 2;
  return [
    box([centreX - half, centreY - 1, z], [KIOSK_ICON_SIZE, 2, KIOSK_ICON_SIZE], palette.material(SIGN_COLOR)),
    box([centreX - 2, centreY, z], [4, 1, 6], door),
  ];
};

/** Phase 29 umbrella: a pole under a stepped canopy in the stall's colour. */
const umbrellaIcon = (centreX: number, centreY: number, z: number, canopy: number, palette: Palette): Shape[] => [
  box([centreX - 1, centreY - 1, z], [1, 1, 5], palette.material(MAT_COLOR.INK)),
  disc(centreX, centreY, z + 5, 1, 4, canopy),
  disc(centreX, centreY, z + 6, 1, 3, canopy),
  disc(centreX, centreY, z + 7, 1, 1, palette.material(LID_COLOR)),
];

/** Phase 29 hat: a wide straw brim under a crown in the stall's colour. */
const hatIcon = (centreX: number, centreY: number, z: number, crown: number, palette: Palette): Shape[] => [
  disc(centreX, centreY, z, 1, 4, palette.material(MAT_COLOR.HAIR_BLOND)),
  disc(centreX, centreY, z + 1, 3, 2, crown),
  disc(centreX, centreY, z + 4, 1, 2, palette.material(MAT_COLOR.HAIR_BLOND)),
];

/** Phase 29 balloon: a round balloon in the stall's colour on a short white string. */
const balloonIcon = (centreX: number, centreY: number, z: number, balloon: number, palette: Palette): Shape[] => [
  box([centreX - 1, centreY - 1, z], [1, 1, 3], palette.material(LID_COLOR)),
  disc(centreX, centreY, z + 3, 1, 2, balloon),
  disc(centreX, centreY, z + 4, 3, 3, balloon),
  disc(centreX, centreY, z + 7, 1, 2, balloon),
];

/** Phase 29 plush: a teddy head with two round ears and a pale snout facing the front. */
const plushIcon = (centreX: number, centreY: number, z: number, palette: Palette): Shape[] => {
  const fur = palette.material(MAT_COLOR.HAIR_BROWN);
  return [
    disc(centreX, centreY, z, 5, 3, fur),
    box([centreX - 3, centreY - 1, z + 5], [2, 2, 2], fur),
    box([centreX + 1, centreY - 1, z + 5], [2, 2, 2], fur),
    box([centreX - 1, centreY + 2, z + 1], [2, 2, 2], palette.material(LID_COLOR)),
  ];
};

/** Phase 29 glow wand: a white stick with a glowing star on top. */
const glowWandIcon = (centreX: number, centreY: number, z: number, palette: Palette): Shape[] => {
  const glow = palette.material(MAT_COLOR.LAMP_GLOW);
  return [
    box([centreX - 1, centreY - 1, z], [1, 1, 5], palette.material(LID_COLOR)),
    box([centreX - 2, centreY - 2, z + 5], [3, 3, 3], glow),
    box([centreX - 3, centreY - 1, z + 6], [5, 1, 1], glow),
  ];
};

const souvenirIconShapes = (
  souvenir: SouvenirKind | undefined,
  centreX: number,
  centreY: number,
  z: number,
  wall: number,
  palette: Palette,
): Shape[] => {
  if (souvenir === 'umbrella') return umbrellaIcon(centreX, centreY, z, wall, palette);
  if (souvenir === 'hat') return hatIcon(centreX, centreY, z, wall, palette);
  if (souvenir === 'balloon') return balloonIcon(centreX, centreY, z, wall, palette);
  if (souvenir === 'plush') return plushIcon(centreX, centreY, z, palette);
  if (souvenir === 'glowWand') return glowWandIcon(centreX, centreY, z, palette);
  return [];
};

const iconShapes = (
  service: ServiceType | undefined,
  centreX: number,
  centreY: number,
  z: number,
  wall: number,
  palette: Palette,
): Shape[] => {
  if (service === 'food') return burgerIcon(centreX, centreY, z, palette);
  if (service === 'drink') return cupIcon(centreX, centreY, z, wall, palette);
  if (service === 'toilet') return doorSignIcon(centreX, centreY, z, wall, palette);
  return [];
};

/** A warm window light on at dusk and night, like the glass glow. */
const windowGlow = (position: Vec3, radius: number): LightSource =>
  ({ position, radius, color: MAT_COLOR.WINDOW_GLOW, presets: KIOSK_LIGHT_PRESETS });

/**
 * The service window's pool in front of the counter, and a halo outside each gable window: the
 * blueprint serves both quarter turns, and each turn shows one gable end.
 */
const windowLights = (layout: KioskFrontLayout, width: number, depth: number, frontY: number): LightSource[] => {
  const sideY = depth / 2 - 4 + SIDE_WINDOW_SIZE / 2;
  const sideZ = SIDE_WINDOW_BOTTOM_Z + SIDE_WINDOW_SIZE / 2;
  return [
    windowGlow([Math.floor((layout.window.from + layout.window.to) / 2), frontY + LIGHT_OFFSET, WINDOW_LIGHT_Z], KIOSK_WINDOW_LIGHT_RADIUS),
    windowGlow([width - KIOSK_WALL_INSET + LIGHT_OFFSET, sideY, sideZ], KIOSK_SIDE_WINDOW_LIGHT_RADIUS),
    windowGlow([KIOSK_WALL_INSET - LIGHT_OFFSET, sideY, sideZ], KIOSK_SIDE_WINDOW_LIGHT_RADIUS),
  ];
};

const kioskBlueprint = (definition: BuildDefinition, palette: Palette): Blueprint => {
  assertSupportedFootprint(definition);
  const width = definition.footprint[0] * VOXELS_PER_TILE;
  const depth = definition.footprint[1] * VOXELS_PER_TILE;
  const facility = definition.kind === 'facility';
  // Phase 28: walls, awning colour stripes, gable core and the cup or door icon are colour slot 'primary'
  // (Walls); roof, posts, counter and the pale awning stripes are 'secondary' (Roof). Tags change no geometry.
  const tag = slotTagger(definition.id);
  const wall = tag('primary', palette.material(definition.color));
  const accent = tag('secondary', palette.material(definition.accent));
  // Facilities are brick-built; shops are timber stalls.
  const wallPattern = facility ? PATTERN.BRICK : PATTERN.PLANKS;
  const frontY = depth - KIOSK_WALL_INSET;
  const layout = kioskFrontLayout(definition);
  const shapes: Shape[] = [
    box([KIOSK_WALL_INSET, KIOSK_WALL_INSET, PLOT_TOP_Z], [width - 2 * KIOSK_WALL_INSET, depth - 2 * KIOSK_WALL_INSET, KIOSK_WALL_HEIGHT], wall, wallPattern),
  ];
  for (const x of [KIOSK_WALL_INSET - 1, width - KIOSK_WALL_INSET - POST_SIZE + 1]) {
    for (const y of [KIOSK_WALL_INSET - 1, depth - KIOSK_WALL_INSET - POST_SIZE + 1]) {
      shapes.push(box([x, y, PLOT_TOP_Z], [POST_SIZE, POST_SIZE, KIOSK_WALL_HEIGHT], accent));
    }
  }
  const door = palette.material(MAT_COLOR.TIMBER);
  for (const span of layout.doors) {
    shapes.push(...opening(span, frontY, PLOT_TOP_Z, PLOT_TOP_Z + KIOSK_DOOR_HEIGHT, door, PATTERN.PLANKS));
  }
  shapes.push(...opening(layout.window, frontY, KIOSK_WINDOW_BOTTOM_Z, KIOSK_WINDOW_TOP_Z, MAT.GLASS, PATTERN.WINDOW));
  shapes.push(...sideWindows(width, depth));
  if (!facility) {
    const counterWidth = layout.window.to - layout.window.from + 2;
    shapes.push(box([layout.window.from - 1, frontY, KIOSK_WINDOW_BOTTOM_Z - COUNTER_HEIGHT], [counterWidth, COUNTER_DEPTH, COUNTER_HEIGHT], accent));
  }
  shapes.push(...awningShapes(layout.awning, frontY, accent, wall));
  const roof = roofShapes(width, depth, accent, wall, wallPattern);
  shapes.push(...roof.shapes);
  shapes.push(...(definition.stats?.serviceType === 'souvenir'
    ? souvenirIconShapes(definition.stats.souvenir, width / 2, depth / 2, roof.ridgeTop - ICON_SINK, wall, palette)
    : iconShapes(definition.stats?.serviceType, width / 2, depth / 2, roof.ridgeTop - ICON_SINK, wall, palette)));
  return {
    id: `kiosk:${definition.id}`,
    footprint: definition.footprint,
    parts: [{ id: 'body', pivot: [0, 0, 0], shapes }],
    lights: windowLights(layout, width, depth, frontY),
  };
};

/** Every shop and facility in the catalog; a single static body, so no drivers. */
export const kiosk: ObjectContent = { blueprint: kioskBlueprint };
