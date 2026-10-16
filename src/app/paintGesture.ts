import { BUILD_BY_ID } from '../game/content/catalog';
import {
  COLOUR_SWATCHES,
  ENTRANCE_COLOUR_ID,
  SWATCH_COUNT,
  colourSlotsFor,
  sameObjectColours,
  type ObjectColours,
} from '../game/content/colours';
import { recolourCharge, type ColourCostMode } from '../game/content/colourCost';
import {
  COLOUR_PRESET_BY_ID,
  paintRecord,
  paintTargetFor,
  rolesOfRecord,
  type PaintBrush,
  type PaintTarget,
} from '../game/content/colourPresets';
import type { Cell, PlacedObject } from '../game/types';
import type { ColourBatchResult, ColourEdit } from '../game/World';
import type { UndoGestureKind } from './undo/types';
import { lineCells } from './lineCells';

/**
 * Phase 28 step 2: the pure model of the Paint tool. Everything that decides WHAT a click or a drag does is
 * here and is a unit test: which thing is under a cell, what the brush would do to it (and the words the
 * cursor readout uses for it), the eyedropper, and `PaintGesture`, the state of one press-drag-release:
 *
 *  - every object the pointer path crosses is painted once per gesture (a coaster by any of its cells, the
 *    entrance gate by its cell, empty ground and paths do nothing);
 *  - Shift, read at pointer down, widens a swatch or default brush to every slot (a preset or a copied brush is
 *    already whole-object);
 *  - one undo entry per gesture however many objects, opened lazily at the first real change (a drag over
 *    grass makes none) and committed at the end;
 *  - a recolour costs `recolourCharge` per object changed, charged ONCE at the end as one transaction, and a
 *    gesture that would overdraw stops painting more objects (what it painted stays);
 *  - Ctrl+Z in the middle of a drag commits and undoes what the gesture painted so far (the ring's rule for any
 *    drag). GameApp then calls `dropUndone`: those objects leave the gesture's count, label and charge, so the
 *    release charges only what is still painted and is named for it. An undone object is not painted again by
 *    the same gesture (the pointer is usually still on it).
 *
 * GameApp supplies the world, the undo ring and the cost mode through `PaintHost`; nothing here touches
 * React, Pixi or a renderer.
 */

export const PAINT_ENTRANCE_NAME = 'Entrance gate';

/** What one cell of the map would recolour: a placed object (a coaster by any piece) or the entrance gate. */
export type PaintTargetInfo =
  | { readonly kind: 'object'; readonly key: string; readonly objectId: number; readonly definitionId: string; readonly name: string; readonly cells: readonly Cell[] }
  | { readonly kind: 'gate'; readonly key: string; readonly definitionId: typeof ENTRANCE_COLOUR_ID; readonly name: string; readonly cells: readonly Cell[] };

/** The slice of GameWorld the Paint tool reads and writes. */
export interface PaintWorld {
  readonly entrance: Cell;
  readonly cash: number;
  readonly gateColours: ObjectColours | null;
  objectAt(cell: Cell): PlacedObject | undefined;
  objectFootprint(object: PlacedObject): Cell[];
  objectColours(objectId: number): ObjectColours | null;
  recolourBatch(edits: readonly ColourEdit[]): ColourBatchResult;
  postTransaction(amount: number, label: string, category?: 'construction'): void;
}

/** The slice of the undo ring a gesture drives (the same calls the bulldozer makes). */
export interface PaintUndo {
  begin(kind: UndoGestureKind): boolean;
  commit(label: string): void;
  setPendingLabel(label: string): void;
  readonly hasPending: boolean;
  readonly newest: { readonly id: number; readonly kind: UndoGestureKind } | null;
}

export interface PaintHost {
  readonly world: PaintWorld;
  readonly undo: PaintUndo;
  mode(): ColourCostMode;
  /** The park rule `recolourCostMultiplier`. */
  multiplier(): number;
  /** A recolour was applied: the app bumps its colour-edit counter (the undo stamp and the save token). */
  onChanged(): void;
  toast(text: string): void;
}

const sameCell = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y;

/** The target under a cell: the gate first (it is no placed object), then whatever object occupies it. */
export const resolvePaintTarget = (world: Pick<PaintWorld, 'entrance' | 'objectAt' | 'objectFootprint'>, cell: Cell): PaintTargetInfo | null => {
  if (sameCell(cell, world.entrance)) {
    return { kind: 'gate', key: 'gate', definitionId: ENTRANCE_COLOUR_ID, name: PAINT_ENTRANCE_NAME, cells: [{ ...world.entrance }] };
  }
  const object = world.objectAt(cell);
  if (!object) return null;
  const definition = BUILD_BY_ID.get(object.definitionId);
  return {
    kind: 'object',
    key: `o${object.id}`,
    objectId: object.id,
    definitionId: object.definitionId,
    name: definition?.name ?? object.definitionId,
    cells: world.objectFootprint(object),
  };
};

export const targetLabel = (target: PaintTarget): string => (target === 'primary' ? 'Main' : target === 'secondary' ? 'Accent' : 'Every part');

const isSwatch = (value: number): boolean => Number.isInteger(value) && value >= 0 && value < SWATCH_COUNT;

/** The brush as a name: a swatch's name, a preset's name, "Default colours" or "Colours of Picnic Pocket". */
export const brushName = (brush: PaintBrush): string => {
  switch (brush.kind) {
    case 'default': return 'Default colours';
    case 'swatch': return isSwatch(brush.swatch) ? COLOUR_SWATCHES[brush.swatch].name : 'Default colours';
    case 'preset': return COLOUR_PRESET_BY_ID.get(brush.presetId)?.name ?? 'Default colours';
    case 'copied': return `Colours of ${brush.sourceName}`;
  }
};

/** What painting `brush` over `target` means in words: "Main to Teal", "Every part to Teal", "Seaside colours". */
export const brushAction = (brush: PaintBrush, target: PaintTarget): string => {
  switch (brush.kind) {
    case 'default': return `${targetLabel(target)} to default`;
    case 'swatch': return `${targetLabel(target)} to ${brushName(brush)}`;
    case 'preset': return `${brushName(brush)} colours`;
    case 'copied': return brushName(brush);
  }
};

export type PaintVerdict =
  | { readonly kind: 'skip'; readonly text: string }
  | { readonly kind: 'same'; readonly text: string }
  | { readonly kind: 'paint'; readonly text: string; readonly record: ObjectColours | null };

/** What the brush would do to one target whose colours are `current`, with the words the readout shows. */
export const judgePaint = (
  target: Pick<PaintTargetInfo, 'definitionId' | 'name'>,
  current: ObjectColours | null,
  brush: PaintBrush,
  paintTarget: PaintTarget,
): PaintVerdict => {
  if (colourSlotsFor(target.definitionId).length === 0) {
    const tree = target.definitionId === 'confetti-tree';
    return { kind: 'skip', text: tree ? 'Trees keep their colours' : `${target.name} keeps its colours` };
  }
  const next = paintRecord(target.definitionId, current, brush, paintTarget);
  if (next === 'skip') return { kind: 'skip', text: `No ${targetLabel(paintTarget)} part` };
  if (sameObjectColours(current, next)) return { kind: 'same', text: 'Already these colours' };
  return { kind: 'paint', text: brushAction(brush, paintTarget), record: next };
};

/** The eyedropper: the brush that copies a target's colours, or null when the target is not colourable. */
export const pickBrush = (world: Pick<PaintWorld, 'objectColours' | 'gateColours'>, target: PaintTargetInfo): PaintBrush | null => {
  if (colourSlotsFor(target.definitionId).length === 0) return null;
  const current = target.kind === 'gate' ? world.gateColours : world.objectColours(target.objectId);
  return { kind: 'copied', sourceName: target.name, roles: rolesOfRecord(target.definitionId, current) };
};

/** The undo label of a gesture: "Painted Petal Roundabout", "Painted 6 things". */
export const paintedLabel = (names: readonly string[]): string => (
  names.length === 1 ? `Painted ${names[0]}` : `Painted ${names.length} things`
);

/** What one finished gesture did. */
export interface PaintOutcome {
  /** Objects (the gate counts as one) whose colours changed and are still changed (not undone mid-drag). */
  readonly changed: number;
  /** The cash charged, 0 almost always. */
  readonly charge: number;
  readonly label: string;
  /** The ring entry the gesture made (null when nothing changed, or the ring declined). */
  readonly entryId: number | null;
  /** True when the gesture stopped painting because the next object would have overdrawn the cash. */
  readonly stoppedForCash: boolean;
  /** The readout words of the last thing that was skipped (for a click on something unpaintable), else null. */
  readonly lastSkip: string | null;
}

export class PaintGesture {
  private readonly painted = new Set<string>();
  /** Names and count of what the gesture painted and still owns: everything since pointer down, or since a Ctrl+Z mid-drag. */
  private names: string[] = [];
  private lastCell: Cell | null = null;
  private changedCount = 0;
  private stopped = false;
  private skipText: string | null = null;
  private finished = false;
  /** The target the gesture really paints with: Shift (read at pointer down) widens it to every part. */
  readonly target: PaintTarget;

  constructor(
    private readonly host: PaintHost,
    private readonly brush: PaintBrush,
    target: PaintTarget,
    shift: boolean,
  ) {
    this.target = paintTargetFor(target, shift);
  }

  get changed(): number { return this.changedCount; }

  /**
   * Ctrl+Z in the middle of this gesture committed its pending snapshot and undid it: what was painted so far is
   * back to its old colours and no longer this gesture's to count, name or charge. The gesture goes on; its next
   * real change opens a new snapshot (`begin`), and the release commits and charges only that.
   */
  dropUndone(): void {
    if (this.finished) return;
    this.changedCount = 0;
    this.names = [];
  }

  /** Pointer down on `cell`. */
  start(cell: Cell): void {
    this.lastCell = cell;
    this.paintCells([cell]);
  }

  /** The pointer moved to `cell` with the button held: every cell on the straight path is crossed. */
  move(cell: Cell): void {
    if (this.finished) return;
    const from = this.lastCell;
    this.lastCell = cell;
    this.paintCells(from && !sameCell(from, cell) ? lineCells(from, cell).slice(1) : [cell]);
  }

  /** Pointer up, or a cancel: what was painted stays, as one undo entry and one charge. */
  end(): PaintOutcome {
    if (this.finished) return this.outcome(null, 0);
    this.finished = true;
    const { world, undo } = this.host;
    let entryId: number | null = null;
    if (undo.hasPending) {
      undo.commit(paintedLabel(this.names));
      const newest = undo.newest;
      entryId = this.changedCount > 0 && newest?.kind === 'recolour' ? newest.id : null;
    }
    const amount = recolourCharge(this.host.mode(), this.changedCount, this.host.multiplier());
    if (amount > 0) world.postTransaction(-amount, 'Repainting', 'construction');
    return this.outcome(entryId, amount);
  }

  private outcome(entryId: number | null, charge: number): PaintOutcome {
    return {
      changed: this.changedCount,
      charge,
      label: paintedLabel(this.names),
      entryId,
      stoppedForCash: this.stopped,
      lastSkip: this.skipText,
    };
  }

  private paintCells(cells: readonly Cell[]): void {
    if (this.stopped) return;
    const { world } = this.host;
    const edits: ColourEdit[] = [];
    const names: string[] = [];
    for (const cell of cells) {
      const target = resolvePaintTarget(world, cell);
      if (!target || this.painted.has(target.key)) continue;
      this.painted.add(target.key);
      const current = target.kind === 'gate' ? world.gateColours : world.objectColours(target.objectId);
      const verdict = judgePaint(target, current, this.brush, this.target);
      if (verdict.kind !== 'paint') {
        this.skipText = verdict.text;
        continue;
      }
      // The cash check runs against the running total, so a long drag stops at the object it cannot pay for.
      const total = recolourCharge(this.host.mode(), this.changedCount + edits.length + 1, this.host.multiplier());
      if (total > world.cash) {
        this.stopped = true;
        this.host.toast(`Not enough cash to repaint more · $${total.toLocaleString()} needed, $${Math.floor(world.cash).toLocaleString()} available`);
        break;
      }
      edits.push(target.kind === 'gate' ? { gate: true, colours: verdict.record } : { objectId: target.objectId, colours: verdict.record });
      names.push(target.name);
    }
    if (edits.length === 0) return;
    // Taken right before the first change and outside the batch below (`begin` is idempotent while pending, and
    // opens a new snapshot when Ctrl+Z settled the earlier one mid-drag).
    this.host.undo.begin('recolour');
    const result = world.recolourBatch(edits);
    if (result.changedCount === 0) return;
    this.changedCount += result.changedCount;
    this.names.push(...names);
    this.host.onChanged();
    this.host.undo.setPendingLabel(paintedLabel(this.names));
  }
}
