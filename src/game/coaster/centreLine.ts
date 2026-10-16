import type { CoasterPiece } from './design';

/**
 * The coaster's smooth centre line (Phase 27): a pure, renderer-agnostic sampler that turns a layout
 * (cells, heights, specials) into a continuous curve — position and tangent at every arc length.
 * The voxel track, the voxel and classic trains, the designer ghost and the draft preview all read
 * it, so the train rides exactly the rail that is drawn. It has no Pixi, DOM, world or gameplay
 * dependencies and nothing here feeds back into coaster gameplay: cycle times, ride stats, cost and
 * saves come from `design.ts` and are untouched (a test pins them).
 *
 * Units. x and y are in TILES in cell space (cell (cx, cy) spans [cx, cx + 1) × [cy, cy + 1), its
 * centre is (cx + ½, cy + ½)), z is in coaster height LEVELS (a piece at height h has z = h at its
 * tile centre), and lengths are tile lengths. A renderer multiplies by its own scale: the voxel
 * renderer by 32 voxels per tile and 13 voxels (+5 for the rail top) per level, the classic one by
 * the isometric tile size and 13 px per level. `COASTER_LEVEL_TILES` converts a level into tiles
 * (the unit slope and pitch are measured in).
 *
 * Plan view. Every piece owns exactly its own tile. The line enters through the midpoint of the
 * edge toward the previous piece and leaves through the midpoint of the edge toward the next one,
 * always perpendicular to the edge, so the tangents of neighbouring pieces match exactly at every
 * join (and a zig-zag of single-tile turns can never collide: each arc stays inside its tile). A
 * straight piece is a straight line, one tile long; a turn is a quarter circle of radius
 * `CENTRE_LINE_CORNER_RADIUS` (half a tile, 16 of the 32 voxels) around the tile corner it turns
 * toward, π/4 of a tile long.
 *
 * Height. The height of the line is a function of ground distance (arc length along the plan
 * line, loops collapsed to a point): a monotone cubic Hermite spline (Fritsch–Carlson tangents,
 * never overshooting) through the piece heights at the tile centres. A piece between a lower and a
 * higher one climbs steadily; at a crest or a dip, where the height stops rising and starts
 * falling, the slope is zero, so crests and dips are rounded curves and flats stay flat. Position
 * and slope are continuous everywhere, including across tile edges.
 *
 * Loops. A loop special on a straight piece inserts a vertical ring of radius half a tile in the
 * plane of travel at the piece's exit edge M (the middle of the segment between the loop piece's
 * centre and the next piece's centre), once around: forward and up first, upside down over the top.
 * The ring is a true circle rotated in its vertical plane by the pitch α of the track at M
 * (`ringEntryPitch`), so it starts and ends with the ramp's own tangent (C1 with the straight
 * track, no kink): with F the plan forward and Z up, F' = cos α F + sin α Z, U' = −sin α F +
 * cos α Z, ring(θ) = M + R sin θ F' + R (1 − cos θ) U', tangent pitch = α + θ, centre M + R U'.
 * On a flat run (α = 0) that is the plain ring. The ring adds its circumference to the arc length.
 * A loop on a turn is ignored, as the track content ignores it.
 *
 * Frame and banking (Phase 27 step 2). Every sample has a cross-section frame (`sampleCentreLineFrame`):
 * T the unit tangent, N the plan left of travel (−dirY, dirX, 0) — on a ring the ring's axis, so the
 * cross-section stays perpendicular to the ring plane all the way round — and B = T × N, the
 * cross-section's up (0, 0, 1 on flat track, pointing at the ring's centre on a ring). Banking rolls
 * N and B about T by `centreLineRollAt`: 0 on straights, rings and the station, a raised cosine
 * over a corner's own arc capped at `CENTRE_LINE_BANK_MAX`, signed so the outer rail rises. Roll
 * never moves the centre line, so the train's position and timing are the same with or without it.
 * The rails sit at ±`CENTRE_LINE_HALF_GAUGE` along the rolled N; the structure hangs along −B.
 *
 * Lift chain. `chained[i]` says whether the segment from piece i's centre to piece i + 1's centre
 * carries a chain: a climbing segment whose piece is not marked `freeClimb` (lift hills are a
 * choice since Phase 27 step 4; every older coaster is chained). The speed model reads the same flag.
 *
 * Arc length (`distance`, tiles) runs from the start of piece 0 round the circuit, rings included.
 *
 * Timing. Gameplay keeps its own cell-based clock: `coasterHeadIndex` says how far through the
 * cycle the train is as a fractional piece index (segment k runs from piece k's centre to piece
 * k + 1's centre). `centreLineIndexToDistance` maps that index onto arc length, linearly inside each
 * segment and monotonic overall, so the train reaches every piece centre at exactly the second it
 * always did and the lap time is unchanged; only the speed along the way follows the geometry (a
 * corner is shorter than a straight).
 */

/** Plan radius of a corner, in tiles: 16 of the 32 voxels, so a corner fits inside its tile. */
export const CENTRE_LINE_CORNER_RADIUS = 0.5;
/** Radius of a loop ring to the running surface, in tiles (16 voxels). */
export const CENTRE_LINE_LOOP_RADIUS = 0.5;
/** One height level in tiles: 13 voxels over 32 per tile (contracts/space.ts COASTER_LEVEL_VOXELS). */
export const COASTER_LEVEL_TILES = 13 / 32;
/** Peak banking of a corner, radians (26 degrees: ±2 voxels over the 6-voxel gauge). */
export const CENTRE_LINE_BANK_MAX = 0.45;
/** Rail centre offset from the centre line, tiles (3 voxels either side). */
export const CENTRE_LINE_HALF_GAUGE = 3 / 32;
/** Ties are spaced this much arc apart (4 voxels), on straights, corners and rings alike. */
export const CENTRE_LINE_TIE_SPACING = 4 / 32;
/** Arc from the start of a line to the centre of its first tie (1 voxel: the voxel tie columns are [4k, 4k + 2)). */
export const CENTRE_LINE_TIE_OFFSET = 1 / 32;
/** Plan arc from a piece's entry edge to its support bent (7 voxels). */
export const CENTRE_LINE_SUPPORT_ALONG = 7 / 32;
/** Half the span of a support bent: the legs stand this far (8 voxels) either side of the line along the rolled normal. */
export const CENTRE_LINE_SUPPORT_HALF_SPAN = 8 / 32;

const HALF_PI = Math.PI / 2;
const TURN_LENGTH = CENTRE_LINE_CORNER_RADIUS * HALF_PI;
const RING_LENGTH = 2 * Math.PI * CENTRE_LINE_LOOP_RADIUS;

export interface CentreLine {
  /** Pieces on the line: a shuttle's line has two scratch pieces after its real ones (`realPieceCount`). */
  readonly pieceCount: number;
  /**
   * Phase 44: the layout's own pieces, indices 0 … realPieceCount − 1 (= pieceCount on a circuit). A shuttle layout
   * (`launchSpeed` on its first piece) is built on its own open ring: the real pieces, then a scratch piece straight
   * on past the last (continuing its climb, so the spike ends steep) and one behind the first (the station's
   * lead-in), never drawn and never reached by the train. Nothing on it is chained.
   */
  readonly realPieceCount: number;
  /** Arc length of the whole circuit, rings included (tiles). */
  readonly totalLength: number;
  readonly cellX: Int32Array;
  readonly cellY: Int32Array;
  /** Unit direction of travel into piece i and out of it (cardinal; out = in on a straight). */
  readonly inX: Int8Array;
  readonly inY: Int8Array;
  readonly outX: Int8Array;
  readonly outY: Int8Array;
  /** 0 straight, +1 / -1 the sign of in × out for a turn. */
  readonly turn: Int8Array;
  /** 1 where a loop ring follows piece i (a loop special on a straight piece). */
  readonly loop: Uint8Array;
  /** Plan length of piece i's own line: 1 on a straight, π/4 on a turn. */
  readonly tileLength: Float64Array;
  /** Arc length where piece i begins (its entry edge); `tileStart[pieceCount]` = totalLength. */
  readonly tileStart: Float64Array;
  /** Arc length at piece i's centre; `centreDistance[pieceCount]` = `centreDistance[0]` + total. */
  readonly centreDistance: Float64Array;
  /** Ground distance (rings collapsed) where piece i begins. */
  readonly groundStart: Float64Array;
  readonly groundTotal: number;
  /** Ground distance at piece i's centre (the spline nodes) and the height and slope there. */
  readonly nodeGround: Float64Array;
  readonly nodeHeight: Float64Array;
  /** Climb at each node, in levels per tile of ground distance. */
  readonly nodeSlope: Float64Array;
  /**
   * 1 where the segment from piece i's centre to piece i + 1's centre carries the lift chain:
   * `centreLineChainedSegments` (a climbing segment that is not marked `freeClimb`).
   */
  readonly chained: Uint8Array;
  /** Nose-up pitch of the track at each loop ring's base (radians, 0 without a ring): the ring is rotated by it. */
  readonly ringEntryPitch: Float64Array;
  /**
   * Phase 46: the element piece i belongs to (`ELEMENT_*`: 0 none), the share of the element its own tile covers
   * (`elementFrom` … `elementTo`, 0 … 1 over the whole element) and the roll's direction (±1).
   */
  readonly elementKind: Uint8Array;
  readonly elementFrom: Float64Array;
  readonly elementTo: Float64Array;
  readonly elementSign: Int8Array;
  /** Phase 46: 1 on a piece of a helix (banked steeper, `CENTRE_LINE_HELIX_BANK`). */
  readonly helix: Uint8Array;
}

/** Phase 46: element kinds on the line. */
export const ELEMENT_NONE = 0;
export const ELEMENT_AIRTIME = 1;
export const ELEMENT_CORKSCREW = 2;
export const ELEMENT_ZERO_G = 3;
export const ELEMENT_COBRA = 4;
const ELEMENT_OF: Readonly<Record<string, number>> = {
  'airtime-hill': ELEMENT_AIRTIME, corkscrew: ELEMENT_CORKSCREW, 'zero-g-roll': ELEMENT_ZERO_G, 'cobra-roll': ELEMENT_COBRA,
};
/** Pieces an element spans, by kind. */
const ELEMENT_SPAN = [0, 1, 2, 2, 2];
/**
 * Phase 46 shapes, by kind: the hump over the element (levels, a sin² over its length, so it starts and ends level
 * with the track), the heartline the roll turns round (tiles above the rail top: the track swings round it, never
 * past a tile's half width with the rails) and whether it rolls a full turn.
 */
export const ELEMENT_BUMP_LEVELS = [0, 0.8, 0.4, 1, 2.5];
export const ELEMENT_HEARTLINE_TILES = [0, 0, 11 / 32, 6 / 32, 8 / 32];
const ELEMENT_ROLLS = [false, false, true, true, true];
/** Phase 46: the peak banking of a helix turn, radians (40 degrees). */
export const CENTRE_LINE_HELIX_BANK = 0.7;

/**
 * Which segments carry a lift chain (1 per piece i for the segment from its centre to piece
 * i + 1's centre): a segment is chained exactly when it climbs, `height[i + 1] > height[i]`, and
 * its piece is not marked `freeClimb`, the same data `coasterSpeedProfile` reads. Pure.
 */
export const centreLineChainedSegments = (pieces: readonly CoasterPiece[]): Uint8Array => {
  const count = pieces.length;
  const chained = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    chained[index] = pieces[(index + 1) % count].height > pieces[index].height && pieces[index].freeClimb !== true ? 1 : 0;
  }
  return chained;
};

const stepSign = (from: number, to: number, other: number, otherTo: number, wantX: boolean): number => {
  const dx = to - from;
  const dy = otherTo - other;
  if (dx === 0 && dy === 0) return wantX ? 1 : 0;
  const alongX = Math.abs(dx) >= Math.abs(dy);
  if (wantX) return alongX ? Math.sign(dx) : 0;
  return alongX ? 0 : Math.sign(dy);
};

/**
 * Builds the centre line of a layout. The layout is a closed circuit (the last piece leads back to
 * the first); a malformed one (gaps, a U-turn) still gets a well-defined line, never NaN. O(n).
 */
export const createCentreLine = (pieces: readonly CoasterPiece[]): CentreLine => {
  if (pieces.length >= 2 && pieces[0].launchSpeed !== undefined) {
    return { ...createCentreLine(shuttleRing(pieces)), realPieceCount: pieces.length };
  }
  const count = pieces.length;
  const cellX = new Int32Array(count);
  const cellY = new Int32Array(count);
  const inX = new Int8Array(count);
  const inY = new Int8Array(count);
  const outX = new Int8Array(count);
  const outY = new Int8Array(count);
  const turn = new Int8Array(count);
  const loop = new Uint8Array(count);
  const tileLength = new Float64Array(count);
  const tileStart = new Float64Array(count + 1);
  const centreDistance = new Float64Array(count + 1);
  const groundStart = new Float64Array(count + 1);
  const nodeGround = new Float64Array(count + 1);
  const nodeHeight = new Float64Array(count + 1);
  const nodeSlope = new Float64Array(count + 1);

  for (let index = 0; index < count; index += 1) {
    const piece = pieces[index];
    const previous = pieces[(index - 1 + count) % count].cell;
    const next = pieces[(index + 1) % count].cell;
    cellX[index] = piece.cell.x;
    cellY[index] = piece.cell.y;
    const alone = count < 2;
    const dirInX = alone ? 1 : stepSign(previous.x, piece.cell.x, previous.y, piece.cell.y, true);
    const dirInY = alone ? 0 : stepSign(previous.x, piece.cell.x, previous.y, piece.cell.y, false);
    let dirOutX = alone ? 1 : stepSign(piece.cell.x, next.x, piece.cell.y, next.y, true);
    let dirOutY = alone ? 0 : stepSign(piece.cell.x, next.x, piece.cell.y, next.y, false);
    // Both neighbours on one side: run straight through, as the track content does.
    if (dirOutX === -dirInX && dirOutY === -dirInY) {
      dirOutX = dirInX;
      dirOutY = dirInY;
    }
    inX[index] = dirInX;
    inY[index] = dirInY;
    outX[index] = dirOutX;
    outY[index] = dirOutY;
    turn[index] = Math.sign(dirInX * dirOutY - dirInY * dirOutX);
    loop[index] = piece.special === 'loop' && turn[index] === 0 && !alone ? 1 : 0;
    tileLength[index] = turn[index] === 0 ? 1 : TURN_LENGTH;
    tileStart[index + 1] = tileStart[index] + tileLength[index] + (loop[index] === 1 ? RING_LENGTH : 0);
    groundStart[index + 1] = groundStart[index] + tileLength[index];
    centreDistance[index] = tileStart[index] + tileLength[index] / 2;
    nodeGround[index] = groundStart[index] + tileLength[index] / 2;
    nodeHeight[index] = piece.height;
  }
  const totalLength = tileStart[count];
  const groundTotal = groundStart[count];
  if (count > 0) {
    centreDistance[count] = centreDistance[0] + totalLength;
    nodeGround[count] = nodeGround[0] + groundTotal;
    nodeHeight[count] = nodeHeight[0];
  }

  // Monotone cubic Hermite tangents (Fritsch–Carlson / Butland): zero at crests, dips and flats,
  // the weighted harmonic mean of the two neighbouring slopes on a steady climb or fall.
  for (let index = 0; index < count; index += 1) {
    const before = index > 0 ? index - 1 : count - 1;
    const groundBefore = index > 0 ? nodeGround[before] : nodeGround[before] - groundTotal;
    const distanceBefore = nodeGround[index] - groundBefore;
    const distanceAfter = nodeGround[index + 1] - nodeGround[index];
    const slopeBefore = (nodeHeight[index] - nodeHeight[before]) / distanceBefore;
    const slopeAfter = (nodeHeight[index + 1] - nodeHeight[index]) / distanceAfter;
    if (slopeBefore * slopeAfter <= 0) {
      nodeSlope[index] = 0;
      continue;
    }
    const w1 = 2 * distanceAfter + distanceBefore;
    const w2 = distanceAfter + 2 * distanceBefore;
    nodeSlope[index] = (w1 + w2) / (w1 / slopeBefore + w2 / slopeAfter);
  }
  if (count > 0) nodeSlope[count] = nodeSlope[0];

  const ringEntryPitch = new Float64Array(count);
  const elementKind = new Uint8Array(count);
  const elementFrom = new Float64Array(count);
  const elementTo = new Float64Array(count);
  const elementSign = new Int8Array(count);
  for (let index = 0; index < count; index += 1) {
    const kind = ELEMENT_OF[pieces[index].special ?? ''] ?? ELEMENT_NONE;
    if (kind === ELEMENT_NONE || count < 3) continue;
    const span = ELEMENT_SPAN[kind];
    // A cobra rolls toward the inside of its U-turn (the way a bank leans); the straight rolls one fixed way.
    const sign = kind === ELEMENT_COBRA ? (turn[index] > 0 ? -1 : 1) : 1;
    for (let part = 0; part < span; part += 1) {
      const at = (index + part) % count;
      elementKind[at] = kind;
      elementFrom[at] = part / span;
      elementTo[at] = (part + 1) / span;
      elementSign[at] = sign;
    }
  }
  const helix = helixPieces(turn, nodeHeight, count);
  const line: CentreLine = {
    pieceCount: count,
    realPieceCount: count,
    totalLength,
    cellX,
    cellY,
    inX,
    inY,
    outX,
    outY,
    turn,
    loop,
    tileLength,
    tileStart,
    centreDistance,
    groundStart,
    groundTotal,
    nodeGround,
    nodeHeight,
    nodeSlope,
    chained: centreLineChainedSegments(pieces),
    ringEntryPitch,
    elementKind,
    elementFrom,
    elementTo,
    elementSign,
    helix,
  };
  // A ring is rotated by the track's pitch at its base (the exit edge of its piece).
  for (let index = 0; index < count; index += 1) {
    if (loop[index] === 0) continue;
    HEIGHT.ground = groundStart[index + 1];
    evaluateHeight(line, HEIGHT);
    ringEntryPitch[index] = Math.atan(HEIGHT.slope * COASTER_LEVEL_TILES);
  }
  return line;
};

/**
 * Phase 46: the pieces of a helix: four or more consecutive turns the same way whose heights change by two levels or
 * more over the run (the stats' `coasterHelixRuns` rule, read here as a ring; a visual flag only).
 */
const helixPieces = (turn: Int8Array, height: Float64Array, count: number): Uint8Array => {
  const flags = new Uint8Array(count);
  if (count < 4) return flags;
  let origin = -1;
  for (let index = 0; index < count; index += 1) {
    if (turn[index] === 0 || turn[index] !== turn[(index - 1 + count) % count]) { origin = index; break; }
  }
  if (origin < 0) return flags;
  let step = 0;
  while (step < count) {
    const start = (origin + step) % count;
    const sign = turn[start];
    let length = 1;
    while (step + length < count && sign !== 0 && turn[(start + length) % count] === sign) length += 1;
    if (sign !== 0 && length >= 4 && Math.abs(height[(start + length - 1) % count] - height[start]) >= 2) {
      for (let part = 0; part < length; part += 1) flags[(start + part) % count] = 1;
    }
    step += length;
  }
  return flags;
};

/** Smootherstep: 0 → 1 with zero slope and curvature at both ends. */
const smoother = (u: number): number => u * u * u * (u * (u * 6 - 15) + 10);

/** Phase 46: the element's phase (0 … 1 over the whole element) at plan arc `along` of piece `index`. */
const elementPhase = (line: CentreLine, index: number, along: number): number => {
  const from = line.elementFrom[index];
  return from + (line.elementTo[index] - from) * Math.min(1, Math.max(0, along / line.tileLength[index]));
};

/** Phase 46: the element's roll (radians) at plan arc `along` of piece `index`: a full turn, eased, or 0. */
export const centreLineElementRoll = (line: CentreLine, index: number, along: number): number => {
  const kind = line.elementKind[index];
  if (kind === undefined || !ELEMENT_ROLLS[kind]) return 0;
  return line.elementSign[index] * 2 * Math.PI * smoother(elementPhase(line, index, along));
};

/**
 * Phase 46: moves a sample on an element piece onto the element: the hump raises it (and its slope), and a roll swings
 * the track round its heartline, `hl · ((1 − cos φ) up + sin φ left)` (the cross-section turns about a point `hl` above
 * the rail top). The plan direction is unchanged.
 */
const applyElement = (line: CentreLine, index: number, out: CentreLineSample): void => {
  const kind = line.elementKind[index];
  const u = elementPhase(line, index, out.along);
  const bump = ELEMENT_BUMP_LEVELS[kind];
  if (bump !== 0) {
    const sine = Math.sin(Math.PI * u);
    out.z += bump * sine * sine;
    out.slope += bump * Math.PI * Math.sin(2 * Math.PI * u) * (line.elementTo[index] - line.elementFrom[index]) / line.tileLength[index];
  }
  if (!ELEMENT_ROLLS[kind]) return;
  const roll = line.elementSign[index] * 2 * Math.PI * smoother(u);
  const heartline = ELEMENT_HEARTLINE_TILES[kind];
  const across = heartline * Math.sin(roll);
  out.x += -out.dirY * across;
  out.y += out.dirX * across;
  out.z += (heartline * (1 - Math.cos(roll))) / COASTER_LEVEL_TILES;
};

// ---------------------------------------------------------------------------------------------
// Cache

interface CacheEntry {
  signature: Int32Array;
  line: CentreLine;
}

const SPECIAL_CODE: Readonly<Record<string, number>> = {
  loop: 1, boost: 2, launch: 3, 'airtime-hill': 4, corkscrew: 5, 'zero-g-roll': 6, 'cobra-roll': 7,
};
/** Slot 3 of a piece's signature: its special, plus a bit for the lift flag (the line's `chained`) and one for a shuttle's launch. */
const FREE_CLIMB_BIT = 8;
const LAUNCH_SPEED_BIT = 16;
const pieceCode = (piece: CoasterPiece): number =>
  (piece.special ? SPECIAL_CODE[piece.special] ?? 3 : 0) | (piece.freeClimb === true ? FREE_CLIMB_BIT : 0)
  | (piece.launchSpeed !== undefined ? LAUNCH_SPEED_BIT : 0);
const CACHE = new WeakMap<readonly CoasterPiece[], CacheEntry>();

const signatureMatches = (signature: Int32Array, pieces: readonly CoasterPiece[]): boolean => {
  if (signature.length !== pieces.length * 4) return false;
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    const at = index * 4;
    if (
      signature[at] !== piece.cell.x || signature[at + 1] !== piece.cell.y
      || signature[at + 2] !== piece.height
      || signature[at + 3] !== pieceCode(piece)
    ) return false;
  }
  return true;
};

/**
 * The centre line of a layout, cached per `pieces` array. The cache compares the layout's cells,
 * heights, specials and lift flags on every call (O(n), allocation-free), so an array edited in place — the
 * designer's draft — can never be served a stale line.
 */
export const centreLineFor = (pieces: readonly CoasterPiece[]): CentreLine => {
  const entry = CACHE.get(pieces);
  if (entry && signatureMatches(entry.signature, pieces)) return entry.line;
  const signature = new Int32Array(pieces.length * 4);
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    const at = index * 4;
    signature[at] = piece.cell.x;
    signature[at + 1] = piece.cell.y;
    signature[at + 2] = piece.height;
    signature[at + 3] = pieceCode(piece);
  }
  const line = createCentreLine(pieces);
  CACHE.set(pieces, { signature, line });
  return line;
};

// ---------------------------------------------------------------------------------------------
// Sampling

/** A point on the centre line. Reused by callers (the sampler allocates nothing). */
export interface CentreLineSample {
  /** Position: tiles in cell space, and height in levels. */
  x: number;
  y: number;
  z: number;
  /** Plan direction of travel (unit, cardinal-to-cardinal through a corner). On a loop ring this is the ring plane's forward and never flips. */
  dirX: number;
  dirY: number;
  /** Climb in levels per tile of ground distance (the ring's base slope on a ring). */
  slope: number;
  /** Nose-up angle of the tangent (radians): atan(slope · level height) on track, 0 → 2π round a ring. */
  pitch: number;
  /** 0 off a ring; the angle round it (0 → 2π) on one. */
  ringAngle: number;
  /** Unit tangent in tile units (x, y, z all in tiles): (dir · cos pitch, sin pitch). */
  tangentX: number;
  tangentY: number;
  tangentZ: number;
  /** The arc length sampled, wrapped onto the circuit: [0, totalLength). */
  distance: number;
  /** The piece whose tile (or ring, for the piece before it) the point is on. */
  piece: number;
  /** Scratch: plan arc length along `piece`'s own line, 0 … tileLength (set by every sample). */
  along: number;
}

export const createCentreLineSample = (): CentreLineSample => ({
  x: 0, y: 0, z: 0, dirX: 1, dirY: 0, slope: 0, pitch: 0, ringAngle: 0,
  tangentX: 1, tangentY: 0, tangentZ: 0, distance: 0, piece: 0, along: 0,
});

/** The spline's height (levels) and slope (levels per tile) at a ground distance. */
export interface GroundHeight {
  /** Input of `evaluateHeight`: the ground distance to evaluate at. */
  ground: number;
  z: number;
  slope: number;
}

export const createGroundHeight = (): GroundHeight => ({ ground: 0, z: 0, slope: 0 });

/**
 * Height and slope of the line at ground distance `ground` (any value; wrapped onto the circuit).
 * Writes into `out` and returns it.
 */
export const centreLineHeightAt = (line: CentreLine, ground: number, out: GroundHeight): GroundHeight => {
  out.ground = ground;
  return evaluateHeight(line, out);
};

/** `centreLineHeightAt` reading the ground distance from `out.ground` (see `resampleCentreLine`). */
const evaluateHeight = (line: CentreLine, out: GroundHeight): GroundHeight => {
  const ground = out.ground;
  const count = line.pieceCount;
  if (count === 0) {
    out.z = 0;
    out.slope = 0;
    return out;
  }
  const total = line.groundTotal;
  let wrapped = ground % total;
  if (wrapped < 0) wrapped += total;
  const nodes = line.nodeGround;
  let segment: number;
  let at = wrapped;
  if (wrapped < nodes[0]) {
    segment = count - 1;
    at = wrapped + total;
  } else {
    let low = 0;
    let high = count - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (nodes[middle] <= wrapped) low = middle;
      else high = middle - 1;
    }
    segment = low;
  }
  const span = nodes[segment + 1] - nodes[segment];
  const t = Math.min(1, Math.max(0, (at - nodes[segment]) / span));
  const t2 = t * t;
  const t3 = t2 * t;
  const h0 = line.nodeHeight[segment];
  const h1 = line.nodeHeight[segment + 1];
  const m0 = line.nodeSlope[segment] * span;
  const m1 = line.nodeSlope[segment + 1] * span;
  out.z = h0 * (2 * t3 - 3 * t2 + 1) + m0 * (t3 - 2 * t2 + t) + h1 * (-2 * t3 + 3 * t2) + m1 * (t3 - t2);
  out.slope = (h0 * (6 * t2 - 6 * t) + m0 * (3 * t2 - 4 * t + 1) + h1 * (-6 * t2 + 6 * t) + m1 * (3 * t2 - 2 * t)) / span;
  return out;
};

const HEIGHT = createGroundHeight();

const setTangent = (out: CentreLineSample): void => {
  const cosine = Math.cos(out.pitch);
  out.tangentX = out.dirX * cosine;
  out.tangentY = out.dirY * cosine;
  out.tangentZ = Math.sin(out.pitch);
};

/**
 * Plan position and direction at arc length `out.along` inside piece `index` (0 ≤ along ≤
 * tileLength), written to `out.x`, `out.y`, `out.dirX`, `out.dirY`. Heights are the caller's business.
 */
const setPlanAt = (line: CentreLine, index: number, out: CentreLineSample): void => {
  const g = out.along;
  const dirInX = line.inX[index];
  const dirInY = line.inY[index];
  const centreX = line.cellX[index] + 0.5;
  const centreY = line.cellY[index] + 0.5;
  if (line.turn[index] === 0) {
    out.x = centreX + dirInX * (g - 0.5);
    out.y = centreY + dirInY * (g - 0.5);
    out.dirX = dirInX;
    out.dirY = dirInY;
    return;
  }
  const dirOutX = line.outX[index];
  const dirOutY = line.outY[index];
  const radius = CENTRE_LINE_CORNER_RADIUS;
  const angle = g / radius;
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  // The arc's centre is the tile corner the turn goes round: entry edge midpoint + radius · out.
  const arcX = centreX - 0.5 * dirInX + radius * dirOutX;
  const arcY = centreY - 0.5 * dirInY + radius * dirOutY;
  out.x = arcX + radius * (-dirOutX * cosine + dirInX * sine);
  out.y = arcY + radius * (-dirOutY * cosine + dirInY * sine);
  out.dirX = dirInX * cosine + dirOutX * sine;
  out.dirY = dirInY * cosine + dirOutY * sine;
};

/** The piece at a wrapped arc length (the last piece whose start is at or before it). */
const pieceAt = (line: CentreLine, wrapped: number): number => {
  const starts = line.tileStart;
  let low = 0;
  let high = line.pieceCount - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= wrapped) low = middle;
    else high = middle - 1;
  }
  return low;
};

/**
 * `sampleCentreLine` for a hot loop: the arc length comes in through `out.distance` instead of an
 * argument, because V8 boxes a double that crosses a call it did not inline (a heap number per
 * call), which in a per-car per-frame loop is an allocation per car per frame.
 */
export const resampleCentreLine = (line: CentreLine, out: CentreLineSample): CentreLineSample => {
  const distance = out.distance;
  const count = line.pieceCount;
  if (count === 0) {
    out.x = 0; out.y = 0; out.z = 0; out.dirX = 1; out.dirY = 0; out.slope = 0; out.pitch = 0;
    out.ringAngle = 0; out.distance = 0; out.piece = 0;
    setTangent(out);
    return out;
  }
  const total = line.totalLength;
  let wrapped = Number.isFinite(distance) ? distance % total : 0;
  if (wrapped < 0) wrapped += total;
  if (!(wrapped >= 0)) wrapped = 0;
  const index = pieceAt(line, wrapped);
  const local = wrapped - line.tileStart[index];
  const length = line.tileLength[index];
  out.distance = wrapped;
  out.piece = index;
  if (local <= length || line.loop[index] === 0) {
    out.along = local < length ? local : length;
    setPlanAt(line, index, out);
    HEIGHT.ground = line.groundStart[index] + out.along;
    evaluateHeight(line, HEIGHT);
    out.z = HEIGHT.z;
    out.slope = HEIGHT.slope;
    if (line.elementKind[index] !== ELEMENT_NONE) applyElement(line, index, out);
    out.pitch = Math.atan(out.slope * COASTER_LEVEL_TILES);
    out.ringAngle = 0;
    setTangent(out);
    return out;
  }
  // The loop ring after this piece: a vertical circle in the plane of travel on its exit edge M,
  // rotated by the track's pitch α there so it enters and leaves along the ramp's own tangent
  // (position and tangent continuous with the straight track). With α = 0 it is the plain ring:
  // forward = R sin θ along the plan direction, rise = R (1 − cos θ) up.
  out.along = length;
  setPlanAt(line, index, out);
  HEIGHT.ground = line.groundStart[index] + length;
  evaluateHeight(line, HEIGHT);
  const radius = CENTRE_LINE_LOOP_RADIUS;
  const angle = Math.min(2 * Math.PI, (local - length) / radius);
  const forward = Math.sin(angle) * radius;
  const rise = (1 - Math.cos(angle)) * radius;
  const entryPitch = line.ringEntryPitch[index];
  const entryCos = Math.cos(entryPitch);
  const entrySin = Math.sin(entryPitch);
  const along = forward * entryCos - rise * entrySin;
  out.x += out.dirX * along;
  out.y += out.dirY * along;
  out.z = HEIGHT.z + (forward * entrySin + rise * entryCos) / COASTER_LEVEL_TILES;
  out.slope = HEIGHT.slope;
  out.pitch = entryPitch + angle;
  out.ringAngle = angle;
  setTangent(out);
  return out;
};

/**
 * Samples the centre line at arc length `distance` (any value, wrapped onto the circuit and stored
 * wrapped in `out.distance`). An empty layout samples the origin. Allocation-free.
 */
export const sampleCentreLine = (line: CentreLine, distance: number, out: CentreLineSample): CentreLineSample => {
  out.distance = distance;
  return resampleCentreLine(line, out);
};

// ---------------------------------------------------------------------------------------------
// Banking and the cross-section frame

/**
 * Banking (roll about the tangent, radians) at plan arc length `along` (0 … tileLength) inside piece
 * `index`: exactly 0 on a straight piece (so on the station run, straight by validation; a station
 * whose first piece is the lap's closing corner banks that corner like any other), and inside a
 * corner a raised cosine over the corner's own arc, `−turn · BANK_MAX · sin²(π along / tileLength)`:
 * 0 at both edges (continuous with the straights, C1 everywhere, zero slope at the edges and the
 * apex), capped at `CENTRE_LINE_BANK_MAX` at the apex. The sign lifts the outer rail: roll > 0
 * raises the −N side (the right of travel), which for a left turn (turn = +1) is the outside.
 * Rings are not pieces: use `centreLineRollAt` (0 on a ring). Pure, allocation-free.
 */
export const centreLineRollInPiece = (line: CentreLine, index: number, along: number): number => {
  // Phase 46: a rolling element's roll replaces any banking on its pieces.
  const kind = line.elementKind[index];
  if (kind !== undefined && ELEMENT_ROLLS[kind]) return centreLineElementRoll(line, index, along);
  const turn = line.turn[index];
  // `!turn` also covers an index off the end (an empty layout's frame): no piece, no banking.
  if (!turn) return 0;
  const sine = Math.sin((Math.PI * along) / line.tileLength[index]);
  const bank = (line.helix[index] === 1 ? CENTRE_LINE_HELIX_BANK : CENTRE_LINE_BANK_MAX) * sine * sine;
  // Written so a corner's edges give exactly +0, like the straights, rather than −0.
  return turn > 0 ? 0 - bank : bank;
};

/**
 * Banking at an arc length (any value, wrapped like `sampleCentreLine`): 0 on straights, rings and
 * the station, `centreLineRollInPiece` inside a corner. Step 3's cars read the roll of their own
 * centre from here. Pure, allocation-free.
 */
export const centreLineRollAt = (line: CentreLine, distance: number): number => {
  const count = line.pieceCount;
  if (count === 0) return 0;
  const total = line.totalLength;
  let wrapped = Number.isFinite(distance) ? distance % total : 0;
  if (wrapped < 0) wrapped += total;
  if (!(wrapped >= 0)) wrapped = 0;
  const index = pieceAt(line, wrapped);
  const local = wrapped - line.tileStart[index];
  const length = line.tileLength[index];
  if (local > length) return 0;
  return centreLineRollInPiece(line, index, local);
};

/**
 * Rail-top lift (tiles, signed up) of a point `across` tiles from the centre line (signed, positive
 * toward N, the left of travel) under roll `roll`: `across · tan(roll)`. Both renderers and the voxel
 * tie/rail column layout quantise banking through this one formula.
 */
export const centreLineBankLift = (across: number, roll: number): number => across * Math.tan(roll);

/**
 * Whether the point at plan arc length `along` on piece `index`'s own tile is on a chained climb:
 * its exit half (along ≥ tileLength / 2) when segment `index` is chained, its entry half when the
 * segment before it is. Rings are never chained.
 */
export const centreLineChainedHalf = (line: CentreLine, index: number, along: number): boolean => {
  const count = line.pieceCount;
  if (count === 0) return false;
  const segment = along >= line.tileLength[index] / 2 ? index : (index + count - 1) % count;
  return line.chained[segment] === 1;
};

/** A sample plus its cross-section frame (a superset of `CentreLineSample`: every sampler caller keeps working). */
export interface CentreLineFrame extends CentreLineSample {
  /** Banking, radians, as `centreLineRollAt`. */
  roll: number;
  /** N′: the rolled left of travel (unit, tiles on every axis). The rails sit at ±CENTRE_LINE_HALF_GAUGE along it. */
  normalX: number;
  normalY: number;
  normalZ: number;
  /** B′: the rolled up of the cross-section (unit, tiles), B′ = T × N′. The structure hangs along −B′. */
  upX: number;
  upY: number;
  upZ: number;
}

export const createCentreLineFrame = (): CentreLineFrame => ({
  ...createCentreLineSample(),
  roll: 0, normalX: 0, normalY: 1, normalZ: 0, upX: 0, upY: 0, upZ: 1,
});

/**
 * `sampleCentreLineFrame` for a hot loop: the arc length comes in through `out.distance` (see
 * `resampleCentreLine`). Samples the line, then the frame: N = (−dirY, dirX, 0) is the plan left of
 * travel (the ring's axis on a ring, so it never flips), B = T × N (up on flat track, toward the
 * centre on a ring), and both are rolled about T by the banking: N′ = cos φ N + sin φ B,
 * B′ = −sin φ N + cos φ B. Allocation-free.
 */
export const resampleCentreLineFrame = (line: CentreLine, out: CentreLineFrame): CentreLineFrame => {
  resampleCentreLine(line, out);
  const roll = out.ringAngle > 0 ? 0 : centreLineRollInPiece(line, out.piece, out.along);
  out.roll = roll;
  const normalX = -out.dirY;
  const normalY = out.dirX;
  // B = T × N with N horizontal: (−Tz · dirX, −Tz · dirY, Tx · dirX + Ty · dirY).
  const upX = -out.tangentZ * out.dirX;
  const upY = -out.tangentZ * out.dirY;
  const upZ = out.tangentX * out.dirX + out.tangentY * out.dirY;
  const cosine = Math.cos(roll);
  const sine = Math.sin(roll);
  out.normalX = cosine * normalX + sine * upX;
  out.normalY = cosine * normalY + sine * upY;
  out.normalZ = sine * upZ;
  out.upX = cosine * upX - sine * normalX;
  out.upY = cosine * upY - sine * normalY;
  out.upZ = cosine * upZ;
  return out;
};

/**
 * `sampleCentreLine` plus the cross-section frame at arc length `distance` (any value, wrapped onto
 * the circuit). Allocation-free; see `resampleCentreLineFrame` for what the frame is.
 */
export const sampleCentreLineFrame = (line: CentreLine, distance: number, out: CentreLineFrame): CentreLineFrame => {
  out.distance = distance;
  return resampleCentreLineFrame(line, out);
};

// ---------------------------------------------------------------------------------------------
// Ties and supports: where the structure sits along the line (both renderers lay them out from these)

/**
 * Number of ties on a line `length` tiles of arc long (a piece's `tileLength`, or a ring's
 * circumference): one every `CENTRE_LINE_TIE_SPACING`, the first `CENTRE_LINE_TIE_OFFSET` past the
 * start. 8 on a straight piece, 7 on a corner, 25 round a ring.
 */
export const centreLineTieCount = (length: number): number =>
  length > CENTRE_LINE_TIE_OFFSET ? Math.ceil((length - CENTRE_LINE_TIE_OFFSET) / CENTRE_LINE_TIE_SPACING) : 0;

/** Arc from the start of a line to the centre of its tie `k` (0-based), so tie columns [4k, 4k + 2) voxels and classic strokes agree. */
export const centreLineTieAlong = (k: number): number => CENTRE_LINE_TIE_OFFSET + k * CENTRE_LINE_TIE_SPACING;

/**
 * Arc length of piece `index`'s support bent: `CENTRE_LINE_SUPPORT_ALONG` past its entry edge (never
 * past the piece's middle). Its legs stand `CENTRE_LINE_SUPPORT_HALF_SPAN` either side of the frame
 * there, along the frame's rolled normal, so on a corner they sit beside the arc, not beside the in-arm.
 */
export const centreLineSupportDistance = (line: CentreLine, index: number): number =>
  line.tileStart[index] + Math.min(CENTRE_LINE_SUPPORT_ALONG, line.tileLength[index] / 2);

// ---------------------------------------------------------------------------------------------
// Timing map

/**
 * Arc length of a (possibly unwrapped) fractional piece index, as `coasterHeadIndex` returns it:
 * piece k's centre at index k, linear inside each segment, monotonic. A non-finite index or an empty
 * layout gives 0. The index is wrapped onto the circuit; the result is in [centreDistance[0], centreDistance[0] + total) and callers
 * wrap it onto [0, total) by sampling.
 */
export const centreLineIndexToDistance = (line: CentreLine, index: number): number => {
  const count = line.pieceCount;
  if (count === 0 || !Number.isFinite(index)) return 0;
  const wrapped = ((index % count) + count) % count;
  const segment = Math.min(count - 1, Math.floor(wrapped));
  const from = line.centreDistance[segment];
  return from + (wrapped - segment) * (line.centreDistance[segment + 1] - from);
};

/** Arc length of segment k, from piece k's centre to piece k + 1's centre (rings included). */
export const centreLineSegmentLength = (line: CentreLine, segment: number): number =>
  line.centreDistance[segment + 1] - line.centreDistance[segment];

// ---------------------------------------------------------------------------------------------
// Tile projection, for the voxel track

/** Where a point inside piece `index`'s tile sits relative to its line. */
export interface TileProjection {
  /** Plan arc length along the piece's line, 0 … tileLength. */
  along: number;
  /** Signed distance from the line in tiles (see `projectOntoTile` for the sign). */
  offset: number;
}

export const createTileProjection = (): TileProjection => ({ along: 0, offset: 0 });

/**
 * Projects a point of piece `index`'s tile — `px`, `py` in tiles from the tile's own corner, 0 … 1 —
 * onto the piece's line. On a straight: along the direction of travel, and `offset` across it
 * (positive toward +x when travelling along y, toward +y when travelling along x). On a turn:
 * the angle round the corner times the radius, and `offset` = distance from the corner − radius
 * (positive on the outside of the turn). Allocation-free.
 */
export const projectOntoTile = (line: CentreLine, index: number, px: number, py: number, out: TileProjection): TileProjection => {
  const dirInX = line.inX[index];
  const dirInY = line.inY[index];
  if (line.turn[index] === 0) {
    const along = (px - 0.5) * dirInX + (py - 0.5) * dirInY + 0.5;
    out.along = along < 0 ? 0 : along > 1 ? 1 : along;
    out.offset = dirInX !== 0 ? py - 0.5 : px - 0.5;
    return out;
  }
  const dirOutX = line.outX[index];
  const dirOutY = line.outY[index];
  const radius = CENTRE_LINE_CORNER_RADIUS;
  const qx = px - (0.5 - 0.5 * dirInX + radius * dirOutX);
  const qy = py - (0.5 - 0.5 * dirInY + radius * dirOutY);
  const distance = Math.hypot(qx, qy);
  const cosine = -(qx * dirOutX + qy * dirOutY);
  const sine = qx * dirInX + qy * dirInY;
  const angle = Math.atan2(sine, cosine);
  out.along = (angle < 0 ? 0 : angle > HALF_PI ? HALF_PI : angle) * radius;
  out.offset = distance - radius;
  return out;
};

// ---------------------------------------------------------------------------------------------
// Open layouts (the designer's draft)

/**
 * A draft layout that cannot close yet, as a ring the centre line can be built from: one scratch
 * piece behind the first (the station's lead-in, straight, at the first piece's height) and one
 * ahead of the last (straight on, at the last piece's height), so neither end bends toward a
 * neighbour that does not exist and the track simply ends level. The pieces of the layout are
 * ring[1] … ring[pieces.length]; the two scratch pieces are never drawn. Every consumer of a draft
 * (the voxel ghost, the classic preview) builds this same ring, so they show the same curve.
 */
export const openLayoutRing = (pieces: readonly CoasterPiece[]): CoasterPiece[] => {
  const count = pieces.length;
  if (count === 0) return [];
  const first = pieces[0];
  const last = pieces[count - 1];
  const headX = count >= 2 ? Math.sign(pieces[1].cell.x - first.cell.x) : 1;
  const headY = count >= 2 ? Math.sign(pieces[1].cell.y - first.cell.y) : 0;
  const tailX = count >= 2 ? Math.sign(last.cell.x - pieces[count - 2].cell.x) : 1;
  const tailY = count >= 2 ? Math.sign(last.cell.y - pieces[count - 2].cell.y) : 0;
  const ring: CoasterPiece[] = [{ cell: { x: first.cell.x - headX, y: first.cell.y - headY }, height: first.height }];
  for (const piece of pieces) ring.push({ cell: { x: piece.cell.x, y: piece.cell.y }, height: piece.height, special: piece.special });
  ring.push({ cell: { x: last.cell.x + tailX, y: last.cell.y + tailY }, height: last.height });
  return ring;
};

/**
 * Phase 44: the open ring a shuttle layout's line is built on: its pieces (every one free of a chain), a scratch
 * piece straight on past the last at the height the last climb would reach next, and one behind the first at the
 * station's level. Real pieces keep their indices.
 */
const shuttleRing = (pieces: readonly CoasterPiece[]): CoasterPiece[] => {
  const count = pieces.length;
  const first = pieces[0];
  const last = pieces[count - 1];
  const previous = pieces[count - 2];
  const headX = Math.sign(pieces[1].cell.x - first.cell.x);
  const headY = Math.sign(pieces[1].cell.y - first.cell.y);
  const tailX = Math.sign(last.cell.x - previous.cell.x);
  const tailY = Math.sign(last.cell.y - previous.cell.y);
  const ring: CoasterPiece[] = pieces.map((piece) => ({ cell: piece.cell, height: piece.height, special: piece.special, freeClimb: true }));
  ring.push({ cell: { x: last.cell.x + tailX, y: last.cell.y + tailY }, height: Math.max(0, 2 * last.height - previous.height), freeClimb: true });
  ring.push({ cell: { x: first.cell.x - headX, y: first.cell.y - headY }, height: first.height, freeClimb: true });
  return ring;
};

/** Whether a draft layout can close into a circuit: three pieces or more, the last beside the first. */
export const layoutCanClose = (pieces: readonly CoasterPiece[]): boolean => {
  if (pieces.length < 3) return false;
  const first = pieces[0].cell;
  const last = pieces[pieces.length - 1].cell;
  return Math.abs(first.x - last.x) + Math.abs(first.y - last.y) === 1;
};
