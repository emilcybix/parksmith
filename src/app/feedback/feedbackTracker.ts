import type { WorldEffect, WorldEffectKind } from '../../rendering/RendererPort';
import type { ParkSession } from '../../game/session/ParkSession';
import { CROWDED_THOUGHT } from '../../game/guests/GuestSimulation';
import { GAME_CONFIG } from '../../game/config';

/**
 * Phase 15: turns what the park did since the last look into feedback cues, by DIFFING the simulations' monotonic
 * counters (the simulation has no event bus and gets none: presentation must never reach it). Pure presentation: it
 * reads the live maps and writes nothing back, so a park plays bit-identically with or without it.
 *
 * - A ride cycle, a breakdown and a repair: `completedCycles`, `breakdownCount`, `repairsCompleted` per ride.
 * - A sale: `customersServed` per stall, at most one cue per stall every SALE_GAP_SECONDS.
 * - A guest's strong reaction: once a second of simulated time a rotating window of guests is sampled and at most
 *   REACTIONS_PER_SAMPLE guests whose thought is a delight or a real complaint (and not the one they last showed) get a
 *   bubble, so a thousand guests never produce a thousand bubbles.
 *
 * Every cue counts against a budget of CUES_PER_SECOND (the rest are dropped, never queued). Cues go to `emit` through
 * ONE reused WorldEffect.
 */

export const SALE_GAP_SECONDS = 3;
export const REACTIONS_PER_SAMPLE = 2;
export const REACTION_WINDOW = 120;
export const CUES_PER_SECOND = 6;

/** Thoughts that read as delight. */
const DELIGHT = new Set(['That was fantastic!', 'What a lovely spot.', 'That was refreshing!', 'That snack hit the spot!']);
/** Thoughts that read as a real complaint (not a passing need). */
const COMPLAINT = new Set([
  "I'm not paying that much.", "I can't afford that anymore.", 'This queue is taking forever.', 'That queue is completely full.',
  'That service queue is completely full.', 'That was not for me.', CROWDED_THOUGHT, "I can't reach the exit.",
  'That facility could be better.',
]);

/** 'happy', 'unhappy' or null for a thought. */
export const reactionOf = (thought: string): 'happy' | 'unhappy' | null => (
  DELIGHT.has(thought) ? 'happy' : COMPLAINT.has(thought) ? 'unhappy' : null
);

interface RideMark { cycles: number; breakdowns: number; repairs: number }
interface ShopMark { served: number; lastCueSeconds: number }

export type FeedbackSink = (effect: Readonly<WorldEffect>) => void;

export class FeedbackTracker {
  private session: ParkSession | null = null;
  private readonly rides = new Map<number, RideMark>();
  private readonly shops = new Map<number, ShopMark>();
  private readonly shown = new Map<number, string>();
  private readonly effect: WorldEffect = { kind: 'build', x: 0, y: 0, objectId: null, amount: 0 };
  private lastTick = -1;
  private nextSampleSeconds = 0;
  private sampleOffset = 0;
  private budgetSecond = -1;
  private budget = 0;
  /** How many cues each kind produced (tests and the audio mix read it). */
  readonly counts: Record<WorldEffectKind, number> = {
    'money-gain': 0, 'money-spend': 0, 'ride-cycle': 0, sale: 0, breakdown: 0, repair: 0, build: 0, happy: 0, unhappy: 0,
  };

  constructor(private readonly emit: FeedbackSink) {}

  /** A new park (or a load, or a rewind): the counters are read afresh, so nothing that already happened is cued. */
  attach(session: ParkSession): void {
    this.session = session;
    this.rides.clear();
    this.shops.clear();
    this.shown.clear();
    this.lastTick = session.world.tick;
    const seconds = this.secondsOf(session);
    this.nextSampleSeconds = seconds + 1;
    session.rides.rides.forEach((ride) => {
      this.rides.set(ride.objectId, { cycles: ride.completedCycles, breakdowns: ride.breakdownCount, repairs: ride.repairsCompleted });
    });
    session.shops.services.forEach((service) => {
      this.shops.set(service.objectId, { served: service.customersServed, lastCueSeconds: -SALE_GAP_SECONDS });
    });
  }

  /** Cues a cash movement the player caused, at a world point or above an object. Counts against the budget too. */
  money(amount: number, x: number, y: number, objectId: number | null = null): void {
    if (amount === 0 || !Number.isFinite(amount)) return;
    this.cue(amount > 0 ? 'money-gain' : 'money-spend', x, y, objectId, amount, true);
  }

  /** Cues a construction puff on a cell (or above an object). */
  build(x: number, y: number, objectId: number | null = null): void {
    this.cue('build', x, y, objectId, 0, true);
  }

  /** Looks at the park once its tick moved (call after the clock stepped). Cheap when nothing changed. */
  observe(): void {
    const session = this.session;
    if (session === null || session.world.tick === this.lastTick) return;
    this.lastTick = session.world.tick;
    const seconds = this.secondsOf(session);
    session.rides.rides.forEach((ride) => {
      let mark = this.rides.get(ride.objectId);
      if (mark === undefined) {
        mark = { cycles: ride.completedCycles, breakdowns: ride.breakdownCount, repairs: ride.repairsCompleted };
        this.rides.set(ride.objectId, mark);
        return;
      }
      if (ride.breakdownCount > mark.breakdowns) this.cue('breakdown', 0, 0, ride.objectId, 0, true);
      else if (ride.repairsCompleted > mark.repairs) this.cue('repair', 0, 0, ride.objectId, 0, false);
      else if (ride.completedCycles > mark.cycles) this.cue('ride-cycle', 0, 0, ride.objectId, 0, false);
      mark.cycles = ride.completedCycles;
      mark.breakdowns = ride.breakdownCount;
      mark.repairs = ride.repairsCompleted;
    });
    session.shops.services.forEach((service) => {
      let mark = this.shops.get(service.objectId);
      if (mark === undefined) {
        mark = { served: service.customersServed, lastCueSeconds: -SALE_GAP_SECONDS };
        this.shops.set(service.objectId, mark);
        return;
      }
      if (service.customersServed > mark.served && seconds - mark.lastCueSeconds >= SALE_GAP_SECONDS) {
        if (this.cue('sale', 0, 0, service.objectId, 0, false)) mark.lastCueSeconds = seconds;
      }
      mark.served = service.customersServed;
    });
    if (seconds >= this.nextSampleSeconds) {
      this.nextSampleSeconds = seconds + 1;
      this.sampleReactions(session);
    }
  }

  private sampleReactions(session: ParkSession): void {
    const guests = session.guests.guests;
    if (guests.size === 0) return;
    if (this.shown.size > 4 * Math.max(64, guests.size)) this.shown.clear();
    const start = this.sampleOffset % guests.size;
    this.sampleOffset = start + REACTION_WINDOW;
    let index = 0;
    let shown = 0;
    for (const guest of guests.values()) {
      if (index++ < start) continue;
      if (index > start + REACTION_WINDOW || shown >= REACTIONS_PER_SAMPLE) break;
      const reaction = reactionOf(guest.currentThought);
      if (reaction === null || this.shown.get(guest.id) === guest.currentThought) continue;
      this.shown.set(guest.id, guest.currentThought);
      if (this.cue(reaction, guest.position.x, guest.position.y, null, 0, false)) shown += 1;
    }
  }

  /** Emits through the reused effect when the per-second budget allows (`always` cues spend it but are never dropped). */
  private cue(kind: WorldEffectKind, x: number, y: number, objectId: number | null, amount: number, always: boolean): boolean {
    const second = this.session === null ? 0 : Math.floor(this.secondsOf(this.session));
    if (second !== this.budgetSecond) {
      this.budgetSecond = second;
      this.budget = CUES_PER_SECOND;
    }
    if (!always && this.budget <= 0) return false;
    this.budget -= 1;
    this.counts[kind] += 1;
    const effect = this.effect;
    effect.kind = kind;
    effect.x = x;
    effect.y = y;
    effect.objectId = objectId;
    effect.amount = amount;
    this.emit(effect);
    return true;
  }

  private secondsOf(session: ParkSession): number {
    return (session.world.tick * GAME_CONFIG.fixedStepMs) / 1_000;
  }
}
