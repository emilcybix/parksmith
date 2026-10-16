import { Container, Graphics } from 'pixi.js';
import { previewFill } from '../../previewFill';
import { isExclusiveCoasterPiece, type CoasterPiece } from '../../../game/coaster/design';
import { BUILD_BY_ID } from '../../../game/content/catalog';
import type { ParkSession } from '../../../game/session/ParkSession';
import type { CrowdBand, CrowdHeatmapView } from '../../../game/crowd/types';
import type { BuildDefinition, Cell, PlacedObject } from '../../../game/types';
import { cellToWorld, TILE_HEIGHT, TILE_WIDTH } from '../../isometric';
import { cellToView, createViewFrame, rectToView, type CellRect as ViewRect, type MutableViewFrame, type ViewFrame, type XY } from '../../viewRotation';
import type { GameWorld } from '../../../game/World';
import { parcelCentre, parcelRect } from '../../../game/land/parcels';
import { COASTER_LEVEL_VOXELS } from '../contracts/space';

/**
 * The voxel renderer's ground overlays: build preview diamonds (with the scenery-influence preview),
 * the selection outline, the scenery heatmap and the coaster layout in progress. They keep the legacy
 * overlays' meaning and colours, but are drawn for a low-res target (one texel = one voxel step =
 * one legacy world px, so the legacy coordinates still apply): every vertex and line width is a whole
 * texel, diamonds are inset in whole texels along the 2:1 slope, and fill alphas are multiples of
 * 1/8 so the composite's 4x4 Bayer dither (a pixel shows where alpha > (rank + 0.5) / 16) gives
 * clean 25 / 50 / 75 % patterns instead of muddy ones. Outlines are opaque: a dithered 1-texel line
 * breaks into dots. Placed coasters and the ghost of what is being built are voxel geometry, not
 * overlays.
 *
 * Everything is drawn into one root container in world texels, layered crowd heatmap → scenery heatmap →
 * selection → draft → preview → paint (legacy order, with the Phase 14 crowd layer at the bottom; the two heatmaps
 * are never shown together, GameApp keeps them exclusive). `version` changes whenever what the overlays show changes, so a frame that
 * renders them into a low-res target can skip that work when nothing moved.
 *
 * View rotation (Phase 26): the inputs (`drawPreview` cells, `selectObject`, the scenery snapshot,
 * `drawCoasterDraft` pieces) stay WORLD cells and the overlays keep what they were given. Every cell is
 * mapped to its VIEW cell (`cellToView`) right before it is drawn, so for any rotation the drawing equals the
 * view-0 drawing of the turned layout (a footprint outline, hint ring or guide line works on view cells, whose
 * neighbours are the view's own). `setView` redraws the retained state in view space and bumps `version` once;
 * a steady frame after it draws nothing.
 *
 * Bin and ride badges are a separate class (badges.ts) drawn on top of these layers.
 */

/** Texels a path's top face stands above the ground (the voxel renderer's PATH_PICK_LIFT). */
const PATH_PREVIEW_LIFT = 3;

const HALF_WIDTH = TILE_WIDTH / 2;
const HALF_HEIGHT = TILE_HEIGHT / 2;

/** What the voxel preview/selection colours are; legacy hues, see WorldRenderer's overlays. */
const OUTLINE_WHITE = 0xffffff;
const PREVIEW_FILL_ALPHA = 0.5;
/**
 * Phase 36 (the Phase 11 "white outline, not a red fill" item): a clear that will happen is filled at 6/8, not 4/8. The
 * overlay composites alpha as a dither, and in headless Chromium the 4/8 checkerboard of the demolition red over a
 * brick path or a coaster's supports averaged out to the path's own pink at 1:1, so the armed coaster read as white
 * outlines only. A refused clear keeps the 4/8 slate.
 */
export const BULLDOZE_FILL_ALPHA = 6 / 8;
const SELECTION_FILL_ALPHA = 0.25;
/** Phase 28 paint hover: the brush colour over the target's cells, the same 25 % as the selection fill. */
const PAINT_FILL_ALPHA = 0.25;
const BLOCKED_FILL_ALPHA = 0.5;
/** The parked draft: half of the 50 % blocked fill, so it still lands on a clean 25 % pattern. */
const DRAFT_PARKED_ALPHA = 0.5;
const GUIDE_ALPHA = 0.5;


const INFLUENCE_BASE_ALPHA = 0.22;
const INFLUENCE_SCORE_ALPHA = 0.34;
const INFLUENCE_EDGE_COLOR = 0xfff4c9;

/**
 * Phase 14 crowd heatmap, per band (quiet, normal, busy, severe): hues apart from the scenery heatmap's and from the
 * biome path colours (desert sand, winter snow), alphas on eighths (2/8, 3/8, 5/8, 6/8) for clean dither patterns.
 * Severe tiles also get an opaque white 1-texel rim round their set, so the worst places read without colour.
 */
export const CROWD_BAND_COLORS: readonly [number, number, number, number] = [0x7aa7d9, 0x3fbfa0, 0xffb347, 0xff4f6d];
export const CROWD_BAND_ALPHAS: readonly [number, number, number, number] = [2 / 8, 3 / 8, 5 / 8, 6 / 8];
export const CROWD_RIM_COLOR = 0xffffff;

/**
 * Phase 21 land: unowned parcels are dimmed (a dark 3/8 dither where the parcel is for sale now, 5/8 beyond it), the
 * owned land is fenced with an opaque 2-texel rail, and every parcel for sale carries a small sign at its centre. The
 * price is read on hover (the cursor readout), never from colour.
 */
export const LAND_DIM_COLOR = 0x152033;
export const LAND_FOR_SALE_ALPHA = 3 / 8;
export const LAND_LOCKED_ALPHA = 5 / 8;
export const LAND_FENCE_COLOR = 0xf3e2b3;
export const LAND_SIGN_COLOR = 0xffd166;
export const LAND_SIGN_POST_COLOR = 0x6b4f2a;

/**
 * A ground diamond whose vertices are whole texels. An inset of `i` texels pulls the top and bottom
 * in by `i` and the sides by `2i`, keeping the 2:1 slope (legacy diamondPoints insets both axes by
 * the same amount, which bends the slope and lands on fractional texels).
 */
export const texelDiamond = (x: number, y: number, inset = 0): number[] => [
  x, y + inset,
  x + HALF_WIDTH - 2 * inset, y + HALF_HEIGHT,
  x, y + TILE_HEIGHT - inset,
  x - HALF_WIDTH + 2 * inset, y + HALF_HEIGHT,
];

/** Legacy score → alpha, snapped to eighths so the dither pattern is regular. */
const influenceAlpha = (score: number): number =>
  Math.max(1, Math.round((INFLUENCE_BASE_ALPHA + score / 100 * INFLUENCE_SCORE_ALPHA) * 8)) / 8;

/** The diamond edge shared with the neighbour in each cardinal direction, as [x0, y0, x1, y1] from the cell's top vertex. */
const EDGE_TO_NEIGHBOUR: readonly (readonly [number, number, number, number])[] = [
  [HALF_WIDTH, HALF_HEIGHT, 0, TILE_HEIGHT], // +x: right → bottom
  [0, 0, -HALF_WIDTH, HALF_HEIGHT], // −x: top → left
  [-HALF_WIDTH, HALF_HEIGHT, 0, TILE_HEIGHT], // +y: left → bottom
  [0, 0, HALF_WIDTH, HALF_HEIGHT], // −y: top → right
];

interface InfluenceEntry {
  readonly cell: Cell;
  readonly score: number;
}

const CARDINAL_DIRECTIONS: readonly Cell[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

const influenceColor = (score: number): number =>
  score >= 50 ? 0xff9f45 : score >= 20 ? 0xffd166 : 0x5fe0b6;

/**
 * Strokes the diamond sides that face outside `cells` (one path, one stroke), so a group of cells
 * gets one clean outline rather than a lattice. Edges are whole-texel diagonals of slope ½.
 */
export const strokeOutline = (graphic: Graphics, cells: readonly Cell[], color: number, width: number): void => {
  // `cells` are already VIEW cells when a view is turned (see viewCells).
  const covered = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
  let any = false;
  for (const cell of cells) {
    const point = cellToWorld(cell);
    CARDINAL_DIRECTIONS.forEach((direction, side) => {
      if (covered.has(`${cell.x + direction.x},${cell.y + direction.y}`)) return;
      const [x0, y0, x1, y1] = EDGE_TO_NEIGHBOUR[side];
      graphic.moveTo(point.x + x0, point.y + y0).lineTo(point.x + x1, point.y + y1);
      any = true;
    });
  }
  if (any) graphic.stroke({ color, alpha: 1, width });
};

/** Score-coloured diamonds, then a bright 1-texel rim around the covered set so the exact radius reads. */
const paintInfluence = (graphic: Graphics, entries: readonly InfluenceEntry[], frame: ViewFrame): void => {
  const cells = entries.map((entry) => viewCell(frame, entry.cell));
  entries.forEach((entry, index) => {
    const point = cellToWorld(cells[index]);
    graphic.poly(texelDiamond(point.x, point.y)).fill({ color: influenceColor(entry.score), alpha: influenceAlpha(entry.score) });
  });
  strokeOutline(graphic, cells, INFLUENCE_EDGE_COLOR, 1);
};

/** The crowd view as retained (WORLD cells, copied: the caller may reuse its arrays). */
interface CrowdHeld {
  readonly revision: number;
  readonly cells: readonly Cell[];
  readonly bands: readonly CrowdBand[];
}

/**
 * One fill per band (every diamond of a band in one path: the diamonds never overlap), then the white rim round the
 * severe set. At most 4 fills and 1 stroke whatever the tile count.
 */
const paintCrowd = (graphic: Graphics, held: CrowdHeld, frame: ViewFrame): void => {
  const cells = viewCells(frame, held.cells);
  const severe: Cell[] = [];
  for (let band = 0; band < 4; band += 1) {
    let any = false;
    for (let index = 0; index < cells.length; index += 1) {
      if (held.bands[index] !== band) continue;
      const point = cellToWorld(cells[index]);
      graphic.poly(texelDiamond(point.x, point.y));
      any = true;
      if (band === 3) severe.push(cells[index]);
    }
    if (any) graphic.fill({ color: CROWD_BAND_COLORS[band], alpha: CROWD_BAND_ALPHAS[band] });
  }
  if (severe.length > 0) strokeOutline(graphic, severe, CROWD_RIM_COLOR, 1);
};

const landScratch: ViewRect = { x: 0, y: 0, width: 0, depth: 0 };

/** The ground diamond of a whole parcel (one quad: an axis-aligned square of cells is one diamond on screen). */
const parcelDiamond = (frame: ViewFrame, world: GameWorld, parcel: number): number[] => {
  const rect = parcelRect(world.land.grid, parcel);
  const view = rectToView(frame, rect.x0, rect.y0, rect.x1 - rect.x0 + 1, rect.y1 - rect.y0 + 1, landScratch);
  const top = cellToWorld({ x: view.x, y: view.y });
  const right = cellToWorld({ x: view.x + view.width - 1, y: view.y });
  const bottom = cellToWorld({ x: view.x + view.width - 1, y: view.y + view.depth - 1 });
  const left = cellToWorld({ x: view.x, y: view.y + view.depth - 1 });
  return [
    top.x, top.y,
    right.x + HALF_WIDTH, right.y + HALF_HEIGHT,
    bottom.x, bottom.y + TILE_HEIGHT,
    left.x - HALF_WIDTH, left.y + HALF_HEIGHT,
  ];
};

/**
 * The land layer: one dim quad per unowned parcel (two fills: for sale now, and beyond), the fence round the owned
 * cells (one stroke), and a sign per parcel for sale (one fill each for posts and boards). Drawn on change only.
 */
const paintLand = (graphic: Graphics, world: GameWorld, frame: ViewFrame): void => {
  const land = world.land;
  const forSale: number[] = [];
  const locked: number[] = [];
  for (let parcel = 0; parcel < land.parcelCount; parcel += 1) {
    if (land.isParcelOwned(parcel)) continue;
    (land.isForSale(parcel) ? forSale : locked).push(parcel);
  }
  for (const [parcels, alpha] of [[forSale, LAND_FOR_SALE_ALPHA], [locked, LAND_LOCKED_ALPHA]] as const) {
    if (parcels.length === 0) continue;
    for (const parcel of parcels) graphic.poly(parcelDiamond(frame, world, parcel));
    graphic.fill({ color: LAND_DIM_COLOR, alpha });
  }
  const owned: Cell[] = [];
  for (const parcel of land.ownedParcels()) {
    const rect = parcelRect(land.grid, parcel);
    for (let y = rect.y0; y <= rect.y1; y += 1) {
      for (let x = rect.x0; x <= rect.x1; x += 1) if (x < world.width && y < world.height) owned.push(viewCell(frame, { x, y }));
    }
  }
  strokeOutline(graphic, owned, LAND_FENCE_COLOR, 2);
  if (forSale.length === 0) return;
  for (const parcel of forSale) {
    const point = cellToWorld(viewCell(frame, parcelCentre(land.grid, parcel)));
    graphic.rect(point.x, point.y + HALF_HEIGHT - 6, 1, 7);
  }
  graphic.fill({ color: LAND_SIGN_POST_COLOR, alpha: 1 });
  for (const parcel of forSale) {
    const point = cellToWorld(viewCell(frame, parcelCentre(land.grid, parcel)));
    graphic.rect(point.x - 4, point.y + HALF_HEIGHT - 10, 9, 5);
  }
  graphic.fill({ color: LAND_SIGN_COLOR, alpha: 1 });
};

/** World-texel centre of a track piece, lifted by its height level. */
const coasterPoint = (piece: CoasterPiece, frame: ViewFrame): { x: number; y: number } => {
  const point = cellToWorld(viewCell(frame, piece.cell));
  return { x: point.x, y: point.y + TILE_HEIGHT / 2 - piece.height * COASTER_LEVEL_VOXELS };
};

/** Empties a layer; true when it had anything to remove. */
const clearLayer = (layer: Container): boolean => {
  if (layer.children.length === 0) return false;
  layer.removeChildren().forEach((child) => child.destroy({ children: true }));
  return true;
};

/** The view cell of a world cell, in a fresh Cell (overlays are redrawn on change only, never per frame). */
export const viewCell = (frame: ViewFrame, cell: Cell): Cell => {
  const out: XY = { x: 0, y: 0 };
  cellToView(frame, cell.x, cell.y, out);
  return { x: out.x, y: out.y };
};

/** The view cells of a list of world cells; the list itself when the view is not turned. */
export const viewCells = (frame: ViewFrame, cells: readonly Cell[]): readonly Cell[] =>
  frame.rotation === 0 ? cells : cells.map((cell) => viewCell(frame, cell));

/** Whether two frames map every cell the same way (the map size only matters for a turned view). */
export const sameViewFrame = (a: ViewFrame, b: ViewFrame): boolean =>
  a.rotation === b.rotation && (a.rotation === 0 || (a.width === b.width && a.height === b.height));

export class VoxelOverlays {
  /** Bumped on every change to what the overlays show. Only ever grows. */
  version = 0;
  /** Phase 21: unowned land, its fence and the for-sale signs (the bottom layer; empty on a wholly owned map). */
  private readonly landLayer = new Container();
  /** What the land layer was drawn from: the world, its land revision and whether the view moved since. */
  private landKey: { world: GameWorld; revision: number } | null = null;
  private landDirty = true;
  /** Phase 14: the crowd flow heatmap, above the land layer. */
  private readonly crowdLayer = new Container();
  private readonly influenceLayer = new Container();
  private readonly selectionLayer = new Container();
  /** Phase 28: what the Paint tool would recolour under the cursor (the top layer; the tool and a build preview are never both up). */
  private readonly paintLayer = new Container();
  private readonly draftLayer = new Container();
  private readonly previewLayer = new Container();
  private selectedObjectId: number | null = null;
  private influenceVisible = false;
  private influenceDirty = true;
  private influenceVersion = -1;
  /** The last crowd view given (null = hidden or never given); retained so a turn or a re-show can redraw it. */
  private crowd: CrowdHeld | null = null;
  /** The layer no longer matches `crowd` in the current view (a turn, or a new revision while it was hidden). */
  private crowdDirty = false;
  /** The view the layers are drawn in (rotation and the world map size); view 0 until `setView`. */
  private readonly frame: MutableViewFrame = createViewFrame();
  /** What was last asked for, in WORLD cells, so a turn can redraw it. */
  private preview: {
    cells: Cell[]; definition: BuildDefinition | null; valid: boolean; bulldoze: boolean; blocked: Cell[] | null;
  } | null = null;
  private draft: { pieces: CoasterPiece[]; armed: boolean } | null = null;
  /** The paint hover as asked for, in WORLD cells (a copy), so a turn can redraw it. */
  private paintHover: { cells: Cell[]; tint: number | null } | null = null;

  /** `session` is read on every draw, so the overlays always show the renderer's current park. */
  constructor(root: Container, private readonly session: () => ParkSession) {
    this.influenceLayer.visible = false;
    this.crowdLayer.visible = false;
    root.addChild(this.landLayer, this.crowdLayer, this.influenceLayer, this.selectionLayer, this.draftLayer, this.previewLayer, this.paintLayer);
  }

  /** True when nothing would be drawn, so a frame can skip the overlays entirely. */
  get isEmpty(): boolean {
    const influenceShown = this.influenceVisible && this.influenceLayer.children.length > 0;
    const crowdShown = this.crowdLayer.visible && this.crowdLayer.children.length > 0;
    return !influenceShown
      && !crowdShown
      && this.landLayer.children.length === 0
      && this.selectionLayer.children.length === 0
      && this.paintLayer.children.length === 0
      && this.draftLayer.children.length === 0
      && this.previewLayer.children.length === 0;
  }

  /** A new park: forget the selection, the draft and the preview, and rebuild from its world. */
  reset(): void {
    this.selectedObjectId = null;
    this.influenceVersion = -1;
    this.influenceDirty = true;
    // The old park's flow means nothing in the new one (and its revision may repeat): GameApp pushes the new view.
    this.crowd = null;
    this.crowdDirty = false;
    this.crowdLayer.visible = false;
    if (clearLayer(this.crowdLayer)) this.changed();
    this.drawCoasterDraft([]);
    this.clearPreview();
    this.clearPaintHover();
    this.landKey = null;
    this.landDirty = true;
    this.syncWorld();
  }

  /**
   * The map was turned (or its size changed): copies the rotation and the world map size and redraws the
   * retained overlays (selection, heatmap, preview, coaster draft) in view space. Bumps `version` once, and
   * only when the frame actually differs, so a repeated call is free.
   */
  setView(frame: ViewFrame): void {
    const same = sameViewFrame(frame, this.frame);
    this.frame.rotation = frame.rotation;
    this.frame.width = frame.width;
    this.frame.height = frame.height;
    if (same) return;
    const before = this.version;
    this.landDirty = true;
    this.drawLand();
    this.influenceDirty = true;
    this.drawInfluence();
    if (this.crowd !== null) {
      this.crowdDirty = true;
      this.drawCrowd();
    }
    this.refreshSelection();
    this.drawPaintHover();
    const preview = this.preview;
    if (preview !== null) this.drawPreview(preview.cells, preview.definition, preview.valid, preview.bulldoze, preview.blocked);
    const draft = this.draft;
    if (draft !== null) this.drawCoasterDraft(draft.pieces, draft.armed);
    this.version = before + 1;
  }

  /** The world changed: the heatmap may have, and the selected object may have gone. */
  syncWorld(): void {
    this.drawLand();
    this.influenceDirty = true;
    this.drawInfluence();
    this.refreshSelection();
  }

  /** Phase 21: redraws the land layer when the owned land (or the world, or the view) changed; free otherwise. */
  private drawLand(): void {
    const world = this.session().world;
    const key = this.landKey;
    if (!this.landDirty && key !== null && key.world === world && key.revision === world.landRevision) return;
    this.landDirty = false;
    this.landKey = { world, revision: world.landRevision };
    const hadContent = clearLayer(this.landLayer);
    if (!world.land.restricted) {
      if (hadContent) this.changed();
      return;
    }
    const graphic = new Graphics();
    paintLand(graphic, world, this.frame);
    this.landLayer.addChild(graphic);
    this.changed();
  }

  selectObject(object: PlacedObject | null): void {
    this.selectedObjectId = object?.id ?? null;
    this.refreshSelection();
  }

  setInfluenceVisible(visible: boolean): void {
    if (visible !== this.influenceVisible) this.changed();
    this.influenceVisible = visible;
    this.influenceLayer.visible = visible;
    if (visible) this.drawInfluence();
  }

  /**
   * Phase 14: shows the crowd flow heatmap for `view`, or hides it (null). The layer is rebuilt only when the
   * revision differs from the one drawn (or the view turned since); the same revision again costs no Graphics call
   * and leaves `version` alone, whatever arrays it comes in. Hiding keeps the drawing, so showing the same revision
   * again is free too. Nothing is ever drawn while hidden.
   */
  setCrowdHeatmap(view: Readonly<CrowdHeatmapView> | null): void {
    if (view === null) {
      if (!this.crowdLayer.visible) return;
      this.crowdLayer.visible = false;
      if (this.crowdLayer.children.length > 0) this.changed();
      return;
    }
    const wasShown = this.crowdLayer.visible && this.crowdLayer.children.length > 0;
    this.crowdLayer.visible = true;
    if (this.crowd === null || this.crowd.revision !== view.revision) {
      const count = Math.min(view.cells.length, view.bands.length);
      const cells: Cell[] = new Array(count);
      const bands: CrowdBand[] = new Array(count);
      for (let index = 0; index < count; index += 1) {
        const cell = view.cells[index];
        cells[index] = { x: cell.x, y: cell.y };
        bands[index] = view.bands[index];
      }
      this.crowd = { revision: view.revision, cells, bands };
      this.crowdDirty = true;
    }
    if (this.crowdDirty) {
      this.drawCrowd();
      return;
    }
    if (!wasShown && this.crowdLayer.children.length > 0) this.changed();
  }

  /**
   * Footprint diamonds (and a decoration's influence) for a build, bulldoze or path preview. Phase 37: `blocked`
   * cells take the refused fill whatever `valid` says (the path draft's cells that cannot take a path).
   */
  drawPreview(
    cells: readonly Cell[], definition: BuildDefinition | null, valid: boolean, bulldoze = false, blocked: readonly Cell[] | null = null,
  ): void {
    this.clearPreview();
    if (cells.length === 0) return;
    // Retained in WORLD cells for setView (a copy: callers reuse their arrays).
    const held = blocked && blocked.length > 0 ? blocked.slice() : null;
    this.preview = { cells: cells.slice(), definition, valid, bulldoze, blocked: held };
    if (definition?.kind === 'scenery' && definition.stats?.sceneryAppeal) {
      this.drawSceneryPreview(cells, definition);
    }
    const graphic = new Graphics();
    const fill = previewFill(valid, bulldoze);
    const refused = previewFill(false, bulldoze);
    const blockedKeys = held ? new Set(held.map((cell) => `${cell.x},${cell.y}`)) : null;
    const fillAlpha = bulldoze && valid ? BULLDOZE_FILL_ALPHA : PREVIEW_FILL_ALPHA;
    const paths = this.session().world.paths;
    const shown = viewCells(this.frame, cells);
    shown.forEach((cell, index) => {
      const point = cellToWorld(cell);
      // A path's top face stands PATH_PREVIEW_LIFT texels up: its diamond sits on that face, not under it (QA 2026-10-14).
      const world = cells[index];
      const lift = paths.has(`${world.x},${world.y}`) ? PATH_PREVIEW_LIFT : 0;
      const color = blockedKeys?.has(`${world.x},${world.y}`) ? refused : fill;
      graphic.poly(texelDiamond(point.x, point.y - lift, 1)).fill({ color, alpha: fillAlpha }).stroke({ color: OUTLINE_WHITE, alpha: 1, width: 1 });
    });
    this.previewLayer.addChild(graphic);
    this.changed();
  }

  /**
   * Phase 28: the Paint tool's hover. An outline round the target's cells and, when `tint` is a colour, a 25 %
   * fill in it, in the selection layer's style (no shader, no ghost). Retained in world cells and redrawn on a
   * turn; the same cells and tint again cost nothing and leave `version` alone.
   */
  setPaintHover(cells: readonly Cell[], tint: number | null): void {
    if (cells.length === 0) {
      this.clearPaintHover();
      return;
    }
    const held = this.paintHover;
    if (held !== null && held.tint === tint && held.cells.length === cells.length
      && held.cells.every((cell, index) => cell.x === cells[index].x && cell.y === cells[index].y)) return;
    this.paintHover = { cells: cells.map((cell) => ({ x: cell.x, y: cell.y })), tint };
    this.drawPaintHover();
  }

  clearPaintHover(): void {
    if (this.paintHover === null) return;
    this.paintHover = null;
    if (clearLayer(this.paintLayer)) this.changed();
  }

  private drawPaintHover(): void {
    const hadContent = clearLayer(this.paintLayer);
    const hover = this.paintHover;
    if (hover === null) {
      if (hadContent) this.changed();
      return;
    }
    const outline = new Graphics();
    const cells = viewCells(this.frame, hover.cells);
    if (hover.tint !== null) {
      for (const cell of cells) {
        const point = cellToWorld(cell);
        outline.poly(texelDiamond(point.x, point.y)).fill({ color: hover.tint, alpha: PAINT_FILL_ALPHA });
      }
    }
    strokeOutline(outline, cells, OUTLINE_WHITE, 2);
    this.paintLayer.addChild(outline);
    this.changed();
  }

  clearPreview(): void {
    this.preview = null;
    if (clearLayer(this.previewLayer)) this.changed();
  }

  /**
   * What the voxel ghost cannot show for the coaster layout in progress: red under blocked cells and
   * the guide back to the station. The track itself is the scene's ghost (VoxelScene.setCoasterDraft),
   * so it is the real built track; the overlay dims with it while another tool is armed.
   */
  drawCoasterDraft(pieces: readonly CoasterPiece[], armed = true): void {
    const hadContent = clearLayer(this.draftLayer);
    this.draftLayer.alpha = armed ? 1 : DRAFT_PARKED_ALPHA;
    this.draft = pieces.length === 0 ? null : { pieces: pieces.slice(), armed };
    if (pieces.length === 0) {
      if (hadContent) this.changed();
      return;
    }
    const graphic = new Graphics();
    // Blocked cells (occupied ground, a path under low track, other track too close: Phase 38) glow red under the track.
    for (const [index, piece] of pieces.entries()) {
      if (this.session().world.canPlaceCoasterPiece({ cell: piece.cell, height: piece.height, exclusive: isExclusiveCoasterPiece(pieces, index) })) continue;
      const point = cellToWorld(viewCell(this.frame, piece.cell));
      graphic.poly(texelDiamond(point.x, point.y, 1)).fill({ color: 0xff6f86, alpha: BLOCKED_FILL_ALPHA });
    }
    const first = pieces[0];
    const last = pieces[pieces.length - 1];
    const closable = pieces.length >= 3
      && Math.abs(first.cell.x - last.cell.x) + Math.abs(first.cell.y - last.cell.y) === 1;
    if (!closable && pieces.length >= 2) {
      // A guide back to the station reminds the player the loop must close.
      const from = coasterPoint(last, this.frame);
      const to = coasterPoint(first, this.frame);
      graphic.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ color: OUTLINE_WHITE, width: 1, alpha: GUIDE_ALPHA });
    }
    this.draftLayer.addChild(graphic);
    this.changed();
  }

  private changed(): void {
    this.version += 1;
  }

  private refreshSelection(): void {
    const hadContent = clearLayer(this.selectionLayer);
    const object = this.selectedObjectId === null ? undefined : this.session().world.objects.get(this.selectedObjectId);
    const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
    if (!object || !definition) {
      this.selectedObjectId = null;
      if (hadContent) this.changed();
      return;
    }
    const outline = new Graphics();
    const footprint = viewCells(this.frame, this.session().world.objectFootprint(object));
    for (const cell of footprint) {
      const point = cellToWorld(cell);
      outline.poly(texelDiamond(point.x, point.y)).fill({ color: 0xffe66d, alpha: SELECTION_FILL_ALPHA });
    }
    strokeOutline(outline, footprint, 0xfff5a8, 2);
    this.selectionLayer.addChild(outline);
    this.changed();
  }

  private drawInfluence(): void {
    // A hidden heatmap is not worth building; construction only marks it dirty, the toggle pays.
    if (!this.influenceVisible) return;
    const snapshot = this.session().scenery.snapshot();
    if (snapshot.version === this.influenceVersion && !this.influenceDirty && this.influenceLayer.children.length > 0) return;
    this.influenceDirty = false;
    this.influenceVersion = snapshot.version;
    const hadContent = clearLayer(this.influenceLayer);
    if (snapshot.cells.length === 0) {
      if (hadContent) this.changed();
      return;
    }
    const graphic = new Graphics();
    paintInfluence(graphic, snapshot.cells, this.frame);
    this.influenceLayer.addChild(graphic);
    this.changed();
  }

  /** Rebuilds the crowd layer from the retained view; only while shown (a hidden layer stays dirty). */
  private drawCrowd(): void {
    if (!this.crowdLayer.visible || this.crowd === null) return;
    this.crowdDirty = false;
    const hadContent = clearLayer(this.crowdLayer);
    if (this.crowd.cells.length === 0) {
      if (hadContent) this.changed();
      return;
    }
    const graphic = new Graphics();
    paintCrowd(graphic, this.crowd, this.frame);
    this.crowdLayer.addChild(graphic);
    this.changed();
  }

  private drawSceneryPreview(cells: readonly Cell[], definition: BuildDefinition): void {
    const radius = Math.max(0, Math.floor(definition.stats?.sceneryRadius ?? 0));
    const appeal = Math.max(0, definition.stats?.sceneryAppeal ?? 0);
    if (appeal <= 0) return;
    const world = this.session().world;
    const influence = new Graphics();
    const minimumX = Math.max(0, Math.min(...cells.map((cell) => cell.x)) - radius);
    const maximumX = Math.min(world.width - 1, Math.max(...cells.map((cell) => cell.x)) + radius);
    const minimumY = Math.max(0, Math.min(...cells.map((cell) => cell.y)) - radius);
    const maximumY = Math.min(world.height - 1, Math.max(...cells.map((cell) => cell.y)) + radius);
    const distanceTo = (cell: Cell): number =>
      Math.min(...cells.map((source) => Math.abs(source.x - cell.x) + Math.abs(source.y - cell.y)));
    const covered = new Set<string>();
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        if (distanceTo({ x, y }) <= radius) covered.add(`${x},${y}`);
      }
    }
    const entries: InfluenceEntry[] = [];
    for (const key of covered) {
      const [x, y] = key.split(',').map(Number);
      entries.push({ cell: { x, y }, score: appeal * (radius + 1 - distanceTo({ x, y })) / (radius + 1) });
    }
    paintInfluence(influence, entries, this.frame);
    this.previewLayer.addChild(influence);
  }
}
