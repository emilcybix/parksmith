import { BUILD_BY_ID } from '../game/content/catalog';
import { unlockSourceOf } from '../game/profile/unlocks';
import { SCENARIO_BY_ID } from '../game/scenarios/content';
import type { BuildLock } from '../game/session/ParkSession';
import type { BuildDefinition, Cell, Rotation } from '../game/types';
import type { GameWorld, ObjectBuildBlockReason, ParcelPurchaseCheck } from '../game/World';

/**
 * The one place a refused placement is put into words.
 *
 * Two surfaces explain a refusal: the cursor readout, before the click, and the toast, after it.
 * They used to be written separately, which is how the readout ended up saying "Blocked or
 * unaffordable" for four different causes while the toast named the real one (PA-019). Now both
 * read from here, so the same obstacle is always described the same way, and the reason itself is
 * derived from `world.checkObjectBuild` — the same check that actually refuses the build.
 */
export const PATH_BLOCKED_MESSAGE = 'Path cannot be built here';

/** One phrasing for "you cannot afford this", everywhere it is said. */
export const shortfallMessage = (cost: number, cash: number): string =>
  `Need $${Math.round(cost).toLocaleString()} · you have $${Math.max(0, Math.round(cash)).toLocaleString()}`;

/**
 * The receipt for a demolition gesture. Undo cannot reverse a demolition at this level (PA-002),
 * so the confirmation has to carry its own weight: it names what went and what came back, and a
 * single mistaken removal names the building itself rather than counting tiles.
 */
export const demolitionToast = (
  removedLabels: readonly string[],
  refunded: number,
  /** Phase 24: what clearing props cost in this gesture, and the names of the props it cleared (a subset of `removedLabels`). */
  spent = 0,
  clearedLabels: readonly string[] = [],
): string => {
  if (removedLabels.length === 0) return '';
  const money = (amount: number): string => `$${Math.round(amount).toLocaleString()}`;
  // Only props were cleared: "Cleared Saguaro · -$70", "Cleared 3 obstacles · -$210".
  if (clearedLabels.length === removedLabels.length) {
    const what = clearedLabels.length === 1 ? clearedLabels[0] : `${clearedLabels.length} obstacles`;
    return `Cleared ${what} · -${money(spent)}`;
  }
  const what = removedLabels.length === 1
    ? removedLabels[0]
    : `${removedLabels.length} tiles`;
  const parts = [`Demolished ${what}`];
  if (refunded > 0) parts.push(`${money(refunded)} refunded`);
  if (spent > 0) parts.push(`${money(spent)} clearing`);
  return parts.join(' · ');
};

/** What stands in the way of a cell, in words: the one phrasing for the readout, the toast and the path message. */
export const obstacleMessage = (world: GameWorld, cell: Cell): string | null => {
  const obstacle = world.obstacleAt(cell);
  if (obstacle === null) return null;
  if (obstacle.kind === 'water') return 'Blocked by water';
  return obstacle.cost === null
    ? `Blocked by ${obstacle.definition.name} (it cannot be cleared)`
    : `Blocked by ${obstacle.definition.name} · clear it for $${obstacle.cost.toLocaleString()}`;
};

/**
 * Land the park does not own (Phase 21), in words: never silently unbuildable. Names the price when the parcel is for
 * sale now, else says what to buy first. Null on owned land (or off the map).
 */
export const unownedLandMessage = (world: GameWorld, cell: Cell): string | null => {
  if (!world.isInside(cell) || world.isOwned(cell)) return null;
  const parcel = world.land.parcelOfCell(cell);
  return world.land.isForSale(parcel)
    ? `Not your land · buy this parcel for $${world.parcelPrice(parcel).toLocaleString()} with the Land tool`
    : 'Not your land · buy the land between first';
};

/** Phase 21: the Land tool's headline over a parcel ("Parcel for sale · $1,230", "Your land"). */
export const landHoverTitle = (check: ParcelPurchaseCheck): string => {
  if (check.ok) return `Parcel for sale · $${check.price.toLocaleString()}`;
  if (check.reason === 'owned') return 'Your land';
  if (check.price !== null) return `Parcel · $${check.price.toLocaleString()}`;
  return 'Land';
};

/** Phase 21: why a parcel cannot be bought, in the same words for the readout and the toast. */
export const landRefusalText = (world: GameWorld, check: Extract<ParcelPurchaseCheck, { ok: false }>): string => {
  switch (check.reason) {
    case 'owned': return 'You already own this parcel';
    case 'not-adjacent': return 'Buy the land between first: a parcel must border your land';
    case 'funds': return shortfallMessage(check.price ?? 0, world.cash);
    case 'unrestricted': return 'This park owns all of its land';
    case 'outside': return 'That is off the map';
  }
};

/** A path that cannot go on a cell: unowned land, the obstacle when one stands there, else the plain refusal. */
export const pathBlockedMessage = (world: GameWorld, cell: Cell): string => (
  unownedLandMessage(world, cell) ?? obstacleMessage(world, cell) ?? PATH_BLOCKED_MESSAGE
);

/** The bulldozer's headline over a clearable prop: "Clear Red boulder · $180". */
export const clearHoverText = (name: string, cost: number): string => `Clear ${name} · $${Math.round(cost).toLocaleString()}`;

/** The bulldozer on a prop it cannot clear (permanent kinds). */
export const permanentPropText = (name: string): string => `${name} cannot be cleared`;

/**
 * Why a locked entry cannot be placed (Phase 22): research keeps its old text, a profile lock names the scenario that
 * grants it, a scenario lock names the rule.
 */
export const buildLockRefusal = (lock: BuildLock | null | undefined, definitionId?: string): string => {
  if (lock?.kind === 'profile') {
    const source = definitionId === undefined ? undefined : unlockSourceOf(definitionId);
    const name = source === undefined ? undefined : SCENARIO_BY_ID.get(source)?.name;
    return name === undefined ? lock.text : `Unlock it by clearing ${name} (Scenario mode)`;
  }
  if (lock?.kind === 'scenario') return `Locked by this scenario: ${lock.conditionName}`;
  return 'Complete its research project first';
};

/** What is wrong. Identical in the readout and the toast. `lock` is the session's answer for a `locked` refusal. */
export const placementBlockReason = (
  world: GameWorld,
  reason: ObjectBuildBlockReason,
  definition: BuildDefinition,
  anchor: Cell,
  rotation: Rotation,
  lock?: BuildLock | null,
): string => {
  if (reason === 'locked') return buildLockRefusal(lock, definition.id);
  if (reason === 'funds') return shortfallMessage(world.objectCost(definition), world.cash);
  for (const cell of world.footprintCells(definition, anchor, rotation)) {
    if (!world.isInside(cell)) return 'That footprint runs off the plot';
    const unowned = unownedLandMessage(world, cell);
    if (unowned !== null) return unowned;
    const blocker = world.objectAt(cell);
    if (blocker) return `Blocked by ${BUILD_BY_ID.get(blocker.definitionId)?.name ?? 'a building'}`;
    if (world.paths.has(`${cell.x},${cell.y}`)) return 'Blocked by a path';
    const obstacle = obstacleMessage(world, cell);
    if (obstacle !== null) return obstacle;
  }
  return 'That footprint is blocked';
};

/**
 * The same reason, plus what to do about it where there is something to do. The toast is the only
 * one of the two that may add guidance, and it always opens with the reason itself.
 */
export const placementBlockToast = (
  world: GameWorld,
  reason: ObjectBuildBlockReason,
  definition: BuildDefinition,
  anchor: Cell,
  rotation: Rotation,
  lock?: BuildLock | null,
): string => {
  const explanation = placementBlockReason(world, reason, definition, anchor, rotation, lock);
  // Inspecting is the pointer tool's job now, so a click that lands on a building says where it went.
  return reason === 'blocked' && world.objectAt(anchor)
    ? `${explanation} — press Esc to inspect it`
    : explanation;
};

/**
 * Phase 11 (PA-015): the bulldozer's two-click rule for a coaster. One track cell removes the whole coaster, so the
 * first press only arms it; the toast and the hover readout say what the second press will do.
 * "Click again to demolish Comet Coaster (the whole coaster) · refund $340".
 */
export const coasterArmedText = (name: string, refund: number): string =>
  `Click again to demolish ${name} (the whole coaster) · refund $${Math.round(refund).toLocaleString()}`;

/** The bulldozer's headline over a coaster that is not armed: "Comet Coaster · click twice to demolish the whole coaster". */
export const coasterHoverText = (name: string): string => `${name} · click twice to demolish the whole coaster`;

/** Why the inspector's Demolish is refused while a coaster layout is open (undo would rewind the layout away). */
export const DEMOLISH_DURING_DRAFT_MESSAGE = 'Finish or clear the coaster layout before demolishing';
