import { BUILD_BY_ID } from '../../content/catalog';
import { GAME_CONFIG } from '../../config';
import { entranceFrame, type EntranceFrame } from '../../maps/frame';
import type { StaffRole } from '../../operations/types';
import { EMPTY_GRANT, ParkSession } from '../../session/ParkSession';
import type { ScenarioDefinition, ScenarioStatus } from '../types';

/**
 * Test support (not imported by the app): a scripted player for the winnability proof of Phase 22. A plan is written
 * in the ENTRANCE FRAME (lateral `l` to the right of the inward direction, depth `d` from the gate), like
 * onboarding/routeInFrame.ts, so one idea works on every map. The bot uses only what a new player has at park start:
 * no card, no unlock, no bonus, no research (`EMPTY_GRANT`, no loadout), and only catalog entries that are not gated.
 */

/** Where along the spine a building goes: flush against it, on one side, at the first depth from `fromDepth` where it fits. */
export interface BotPlacement {
  readonly definitionId: string;
  readonly side: 'left' | 'right';
  readonly fromDepth: number;
  /** Ticket or item price to set once built (a ride's `ticketPrice`, a shop's `itemPrice`). */
  readonly price?: number;
}

/** One batch of actions: what the bot does at the start, and at most three more times during the run. */
export interface BotActions {
  /** Extends the straight path spine (lateral 0) down to this depth. Props on the spine are cleared first. */
  readonly spineDepth?: number;
  /** Extra path cells in the entrance frame. */
  readonly paths?: ReadonlyArray<readonly [l: number, d: number]>;
  readonly placements?: readonly BotPlacement[];
  readonly hire?: readonly StaffRole[];
  /**
   * One-shot cards of the stage loadout to play now (Phase 25, through `ParkSession.playCard`, exactly as the HUD plays
   * them), in order. A refusal is recorded in `BotResult.cardPlays`; playing a card that was already played is a no-op
   * refusal, so a retry is a second step naming the same card.
   */
  readonly playCards?: readonly string[];
}

export interface BotStep extends BotActions {
  readonly atSeconds: number;
}

export interface BotPlan extends BotActions {
  /** Up to three later building steps (a second ride once cash allows, more staff); steps that only play cards are not counted. */
  readonly steps?: readonly BotStep[];
  /**
   * Phase 21: on an estate, once per simulated second from `fromSeconds`, buy the cheapest parcel for sale while the cash
   * left after it stays at or above `reserve` (what a player saving up for land does).
   */
  readonly buyLand?: { readonly fromSeconds: number; readonly reserve: number };
}

/** The cheapest parcel for sale now (lowest index on a tie), or null. */
const cheapestParcel = (session: ParkSession): { parcel: number; price: number } | null => {
  let best: { parcel: number; price: number } | null = null;
  for (const parcel of session.world.land.forSale()) {
    const price = session.world.parcelPrice(parcel);
    if (best === null || price < best.price) best = { parcel, price };
  }
  return best;
};

export interface BotResult {
  readonly status: ScenarioStatus;
  readonly completedAtSeconds: number | null;
  readonly minimumCash: number;
  readonly guestsPeak: number;
  /** Placements that could not be built (no room, no cash, locked): a plan should have none. */
  readonly skipped: readonly string[];
  readonly elapsedSeconds: number;
  /** Every card play the plan asked for, in order: when, and the session's answer ('ok' or the refusal reason). */
  readonly cardPlays: ReadonlyArray<{ readonly cardId: string; readonly atSeconds: number; readonly outcome: string }>;
  /** Deferred one-shot costs still unpaid when the result latched (a run stage only; 0 elsewhere). */
  readonly unpaidDebt: number;
}

export interface BotRunOptions {
  /** Called once per simulated second with the session, for exploration and tracing. */
  readonly trace?: (session: ParkSession, seconds: number) => void;
}

/** Exported for the Phase 16 strategy bots (`balance/strategyBot.ts`), which place along the same spine. */
export const placeAlongSpine = (session: ParkSession, frame: EntranceFrame, placement: BotPlacement, skipped: string[]): void => {
  const { world } = session;
  const definition = BUILD_BY_ID.get(placement.definitionId);
  if (!definition) { skipped.push(`${placement.definitionId}: unknown`); return; }
  const [w, h] = definition.footprint;
  for (let depth = placement.fromDepth; depth < 40; depth += 1) {
    const l = placement.side === 'right' ? 1 : -w;
    // The building must touch spine cells: every depth of the footprint has a path at lateral 0.
    let flush = true;
    for (let row = 0; row < h; row += 1) {
      const cell = frame.toWorld(0, depth + row);
      if (!world.paths.has(`${cell.x},${cell.y}`)) flush = false;
    }
    if (!flush) continue;
    const anchor = frame.rectToWorld(l, depth, w, h);
    // Props in the footprint are cleared for their price, like a player would (a permanent one or water refuses and the
    // bot tries the next depth).
    const check = world.checkObjectBuild(placement.definitionId, anchor, frame.rotation);
    if (!check.ok && check.reason === 'obstacle') {
      for (const cell of world.footprintCells(definition, anchor, frame.rotation)) {
        if (world.propAt(cell)) world.bulldoze(cell);
      }
    }
    const built = world.buildObject(placement.definitionId, anchor, frame.rotation);
    if (built) {
      session.syncWithWorld();
      if (placement.price !== undefined) {
        if (definition.kind === 'ride') session.rides.setTicketPrice(built.id, placement.price);
        else session.shops.setPrice(built.id, placement.price);
      }
      return;
    }
  }
  skipped.push(`${placement.definitionId}: no room (${placement.side}, from depth ${placement.fromDepth})`);
};

const playCards = (session: ParkSession, actions: BotActions, seconds: number, plays: Array<BotResult['cardPlays'][number]>): void => {
  for (const cardId of actions.playCards ?? []) {
    const played = session.playCard(cardId);
    plays.push({ cardId, atSeconds: seconds, outcome: played.ok ? 'ok' : played.reason });
  }
};

/** True when a step builds, hires or lays path (the three-step budget counts these only). */
const builds = (actions: BotActions): boolean => (
  actions.spineDepth !== undefined || (actions.paths?.length ?? 0) > 0 || (actions.placements?.length ?? 0) > 0 || (actions.hire?.length ?? 0) > 0
);

const act = (session: ParkSession, frame: EntranceFrame, actions: BotActions, skipped: string[]): void => {
  const { world } = session;
  if (actions.spineDepth !== undefined) {
    const cells = [];
    for (let depth = 1; depth <= actions.spineDepth; depth += 1) {
      const cell = frame.toWorld(0, depth);
      if (world.propAt(cell)) world.bulldoze(cell);
      cells.push(cell);
    }
    world.buildPaths(cells);
  }
  if (actions.paths) {
    for (const [l, d] of actions.paths) {
      const cell = frame.toWorld(l, d);
      if (world.propAt(cell)) world.bulldoze(cell);
      world.buildPaths([cell]);
    }
  }
  session.syncWithWorld();
  for (const placement of actions.placements ?? []) placeAlongSpine(session, frame, placement, skipped);
  for (const role of actions.hire ?? []) session.operations.hireStaff(role);
};

/** Runs a plan on a fresh Scenario-mode park (no cards, empty grant) until the result latches. */
export const runBot = (definition: ScenarioDefinition, plan: BotPlan, options: BotRunOptions = {}): BotResult => (
  runBotOnSession(new ParkSession(definition, [], { mode: 'scenario', grant: EMPTY_GRANT }), plan, options)
);

/** Runs a plan on a ready session (a Scenario park, or a stage of The Map built exactly as the app builds it) until the result latches. */
export const runBotOnSession = (session: ParkSession, plan: BotPlan, options: BotRunOptions = {}): BotResult => {
  const definition = session.scenarioDefinition!;
  const frame = entranceFrame({ ...session.world.entrance, facing: session.world.entranceFacing });
  const skipped: string[] = [];
  const cardPlays: Array<BotResult['cardPlays'][number]> = [];
  act(session, frame, plan, skipped);
  playCards(session, plan, 0, cardPlays);
  const sorted = [...(plan.steps ?? [])].sort((left, right) => left.atSeconds - right.atSeconds);
  const buildingSteps = sorted.filter(builds).slice(0, 3);
  const steps = sorted.filter((step) => !builds(step) || buildingSteps.includes(step));
  let minimumCash = session.world.cash;
  let guestsPeak = 0;
  const totalTicks = Math.ceil((definition.timeLimitSeconds * 1000) / GAME_CONFIG.fixedStepMs) + 5;
  const ticksPerSecond = Math.round(1000 / GAME_CONFIG.fixedStepMs);
  let nextStep = 0;
  for (let tick = 0; tick < totalTicks; tick += 1) {
    const seconds = tick / ticksPerSecond;
    while (nextStep < steps.length && steps[nextStep].atSeconds <= seconds) {
      act(session, frame, steps[nextStep], skipped);
      playCards(session, steps[nextStep], seconds, cardPlays);
      nextStep += 1;
    }
    if (plan.buyLand && tick % ticksPerSecond === 0 && seconds >= plan.buyLand.fromSeconds) {
      for (let offer = cheapestParcel(session); offer !== null && session.world.cash - offer.price >= plan.buyLand.reserve; offer = cheapestParcel(session)) {
        if (!session.world.buyParcel(offer.parcel).ok) break;
      }
    }
    session.step(GAME_CONFIG.fixedStepMs);
    minimumCash = Math.min(minimumCash, session.world.cash);
    guestsPeak = Math.max(guestsPeak, session.guests.guests.size);
    if (options.trace && tick % ticksPerSecond === 0) options.trace(session, seconds);
    if (session.scenario!.currentStatus !== 'running') break;
  }
  const snapshot = session.scenarioSnapshot()!;
  return {
    status: snapshot.status,
    completedAtSeconds: snapshot.completedAtSeconds,
    minimumCash,
    guestsPeak,
    skipped,
    elapsedSeconds: snapshot.elapsedSeconds,
    cardPlays,
    unpaidDebt: session.plays?.unpaidTotal() ?? 0,
  };
};
