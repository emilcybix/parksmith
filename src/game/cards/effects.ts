import { GAME_CONFIG } from '../config';
import { scaledResearchPoints } from '../progression/content';
import type { TransactionCategory } from '../types';
import { formatCountdown, formatDollars, numberWord, oneShotTransactions } from './copy';
import type { OneShotEffect } from './types';

/**
 * One-shot effects (Phase 25, design 2.3): what playing a one-shot card does, against a STRUCTURAL host so this module
 * never imports the session. The session (ParkSession.playCard) adapts its owners to `OneShotHost`; the mutating names
 * are the owner primitives (RideSimulation.repairBroken/serviceAll, OperationsSimulation.sweepLitter/emptyBins,
 * WeatherSimulation.rewriteForecast, GuestSimulation.spawnGuests/adjustHappiness, ProgressionSimulation
 * .grantResearchPoints, World.postTransaction). Every money movement goes through `postTransaction` (never
 * `world.addMoney`, which bumps `world.version`), and at most one cost is deferred: the caller schedules it in the park's
 * `plays` ledger.
 */
export interface OneShotHost {
  /** The level is still running (a card cannot be played once it is won or lost). */
  levelRunning(): boolean;
  cash(): number;
  /** The current simulation tick. */
  tick(): number;
  postTransaction(amount: number, label: string, category: TransactionCategory): void;
  grantResearchPoints(points: number): number;
  /** The park's research cost scale (Phase 16; 1 = base costs). A research card's points are base RP, scaled by it. */
  researchCostScale(): number;
  /** Rides `repairBroken` would repair now (broken, no maintenance started, not running). */
  brokenRideCount(): number;
  /** Rides `serviceAll` would service now (idle and below full condition, or broken). */
  serviceableRideCount(): number;
  /** Repairs every eligible broken ride at once; returns their ids. */
  repairBroken(): number[];
  /** Services every eligible ride to full condition (their queues are released); returns their ids. */
  serviceAll(): number[];
  /** Litter piles on the ground. */
  litterCount(): number;
  /** Bins holding anything. */
  usedBinCount(): number;
  /** Clears every litter pile; returns how many. */
  sweepLitter(): number;
  /** Empties every bin; returns how many held something. */
  emptyBins(): number;
  /** Writes `count` future weather slots; returns how many were written. */
  rewriteForecast(kind: 'sunny', count: number, intensity: number): number;
  guestCount(): number;
  guestMaximum(): number;
  /** Spawns up to `count` guests at the gate (the guest RNG, like organic arrivals); returns how many. */
  spawnGuests(count: number): number;
  /** Moves every guest's happiness by `delta` (clamped 0..100); returns how many guests. */
  adjustHappiness(delta: number): number;
}

export type CanPlay = { ok: true } | { ok: false; hint: string };

/** A cost the caller schedules in the `plays` ledger (amount negative, integer dollars). */
export interface DeferredCost {
  amount: number;
  dueTick: number;
  label: string;
  category: 'other' | 'maintenance';
}

export interface OneShotOutcome {
  /** The toast line: "+$2,000 now · $2,400 due in 4:00". */
  summary: string;
  deferred: DeferredCost | null;
}

const TICKS_PER_SECOND = 1000 / GAME_CONFIG.fixedStepMs;

/** The cash a play costs right now (0 when everything is deferred or it pays out). */
export const costNowOf = (effect: OneShotEffect, host: Pick<OneShotHost, 'brokenRideCount' | 'serviceableRideCount'>): number => {
  switch (effect.kind) {
    case 'research':
    case 'sweep':
    case 'forecast':
      return effect.fee;
    case 'cheer':
      return Math.max(0, effect.fee);
    case 'repair':
      if (effect.afterSeconds !== null) return 0;
      return effect.perRide * (effect.scope === 'broken' ? host.brokenRideCount() : host.serviceableRideCount());
    default:
      return 0;
  }
};

/** Whether a one-shot can be played now, and why not (the HUD chip's hint). */
export const canPlay = (effect: OneShotEffect, host: OneShotHost): CanPlay => {
  if (!host.levelRunning()) return { ok: false, hint: 'The level is over' };
  switch (effect.kind) {
    case 'repair':
      if (effect.scope === 'broken' && host.brokenRideCount() === 0) return { ok: false, hint: 'No ride is broken' };
      if (effect.scope === 'all' && host.serviceableRideCount() === 0) return { ok: false, hint: 'Every ride is in top shape' };
      break;
    case 'sweep':
      if (host.litterCount() === 0 && host.usedBinCount() === 0) return { ok: false, hint: 'The park is clean' };
      break;
    case 'surge':
      if (host.guestCount() >= host.guestMaximum()) return { ok: false, hint: 'The park is full' };
      break;
    case 'cheer':
      if (host.guestCount() === 0) return { ok: false, hint: 'No guests yet' };
      break;
    default:
      break;
  }
  const cost = costNowOf(effect, host);
  if (cost > 0 && host.cash() < cost) return { ok: false, hint: `Not enough cash (${formatDollars(cost)})` };
  return { ok: true };
};

const deferredOf = (host: OneShotHost, amount: number, afterSeconds: number, label: string, category: 'other' | 'maintenance'): DeferredCost => ({
  amount,
  dueTick: host.tick() + Math.round(afterSeconds * TICKS_PER_SECOND),
  label,
  category,
});

const due = (cost: DeferredCost, host: OneShotHost): string => `${formatDollars(-cost.amount)} due in ${formatCountdown((cost.dueTick - host.tick()) / TICKS_PER_SECOND)}`;

/**
 * Plays a one-shot: calls exactly its owner methods and posts its transactions, and returns the toast summary and the
 * deferred cost the caller must schedule. `name` labels the transactions ("Bridging Loan cash"). Throws when `canPlay`
 * refuses (the caller checks first).
 */
export const applyOneShot = (effect: OneShotEffect, host: OneShotHost, name: string): OneShotOutcome => {
  const allowed = canPlay(effect, host);
  if (!allowed.ok) throw new RangeError(`one-shot ${name} cannot be played: ${allowed.hint}`);
  const [first, second] = oneShotTransactions(name, effect);
  switch (effect.kind) {
    case 'loan': {
      host.postTransaction(first.amount, first.label, first.category);
      const deferred = deferredOf(host, second.amount, effect.afterSeconds, second.label, 'other');
      return { summary: `+${formatDollars(effect.amount)} now · ${due(deferred, host)}`, deferred };
    }
    case 'research': {
      // The card's points are base RP: granted at the park's research cost scale, so the card keeps its ratio to the tree.
      const granted = host.grantResearchPoints(scaledResearchPoints(effect.points, host.researchCostScale()));
      host.postTransaction(first.amount, first.label, first.category);
      return { summary: `+${granted} research points · ${formatDollars(first.amount)}`, deferred: null };
    }
    case 'repair': {
      const ids = effect.scope === 'broken' ? host.repairBroken() : host.serviceAll();
      const total = -effect.perRide * ids.length;
      const rides = `${ids.length} ride${ids.length === 1 ? '' : 's'} ${effect.scope === 'broken' ? 'repaired' : 'serviced'}`;
      if (effect.afterSeconds === null || total === 0) {
        if (total !== 0) host.postTransaction(total, first.label, first.category);
        return { summary: `${rides} · ${formatDollars(total)}`, deferred: null };
      }
      const deferred = deferredOf(host, total, effect.afterSeconds, first.label, 'maintenance');
      return { summary: `${rides} · ${due(deferred, host)}`, deferred };
    }
    case 'sweep': {
      const piles = host.sweepLitter();
      const bins = host.emptyBins();
      host.postTransaction(first.amount, first.label, first.category);
      return { summary: `${piles} litter pile${piles === 1 ? '' : 's'} cleared, ${bins} bin${bins === 1 ? '' : 's'} emptied · ${formatDollars(first.amount)}`, deferred: null };
    }
    case 'forecast': {
      const slots = host.rewriteForecast(effect.weather, effect.slots, effect.intensity);
      host.postTransaction(first.amount, first.label, first.category);
      return { summary: `The next ${numberWord(slots)} weather slots turn ${effect.weather} · ${formatDollars(first.amount)}`, deferred: null };
    }
    case 'surge': {
      const spawned = host.spawnGuests(effect.guests);
      const deferred = deferredOf(host, first.amount, effect.afterSeconds, first.label, 'other');
      return { summary: `${spawned} guests arrive · ${due(deferred, host)}`, deferred };
    }
    case 'cheer': {
      const guests = host.adjustHappiness(effect.happiness);
      if (first) host.postTransaction(first.amount, first.label, first.category);
      const sign = effect.happiness >= 0 ? '+' : '';
      const money = first ? ` · ${first.amount > 0 ? '+' : ''}${formatDollars(first.amount)}` : '';
      return { summary: `Happiness ${sign}${effect.happiness} for ${guests} guest${guests === 1 ? '' : 's'}${money}`, deferred: null };
    }
  }
};
