import { GAME_CONFIG } from '../game/config';
import type { CrowdView, NeighborhoodView } from '../game/crowd/types';

/**
 * Phase 14 (design Q4): which neighborhood observations Park Pulse may say, held and released in simulation time.
 *
 * The twin of `capacityNotice.ts`, app layer on purpose: a Management notification is saved state, so this tracker is
 * transient instead. It is never saved, reset on every session swap (start again from `INITIAL_CROWD_NOTICE`), and
 * driven by the session tick only, so a paused park freezes it and 2x / 4x speed hold for fewer real seconds.
 *
 * - A condition (design Q4) turns ON after it has held for `holdSeconds` (10 s: bottleneck, crowded, coverage) or
 *   `slowHoldSeconds` (20 s: unhappy, litter) without a break.
 * - Phase 49: litter in a neighborhood while the cleaners are swamped is `litterOutpaces` instead of `litter`; the
 *   switch between the two starts the new kind's hold afresh.
 * - It turns OFF after `releaseSeconds` (20 s) without the condition; a return inside that window keeps it on.
 * - A neighborhood that is gone from the view (a removed leader ride) drops its lines at once; a tick that ran
 *   backwards (a rewind with a stale tracker) restarts every stretch.
 *
 * The words are `ui/neighborhoodModel.ts` (`crowdNoticeText`); this file only decides which lines are on.
 */

export type CrowdNoticeKind = 'bottleneck' | 'crowded' | 'noToilet' | 'noFood' | 'noDrink' | 'unhappy' | 'litterOutpaces' | 'litter';

/**
 * Park Pulse priority (design Q4): bottleneck > crowded > coverage > unhappy > litter. Phase 49: `litterOutpaces` is the
 * litter line while the cleaners are swamped (`cleanerLoad.ts`), so a neighborhood has one of the two, never both.
 */
export const CROWD_NOTICE_PRIORITY: readonly CrowdNoticeKind[] = Object.freeze([
  'bottleneck', 'crowded', 'noToilet', 'noFood', 'noDrink', 'unhappy', 'litterOutpaces', 'litter',
]);

const SLOW_KINDS: ReadonlySet<CrowdNoticeKind> = new Set(['unhappy', 'litterOutpaces', 'litter']);

const TICKS_PER_SECOND = 1_000 / GAME_CONFIG.fixedStepMs;

/** Ticks a condition must hold before its line turns on. */
export const crowdHoldTicks = (kind: CrowdNoticeKind): number => {
  const pulse = GAME_CONFIG.crowd.pulse;
  return (SLOW_KINDS.has(kind) ? pulse.slowHoldSeconds : pulse.holdSeconds) * TICKS_PER_SECOND;
};

/** Ticks without the condition before a line that is on turns off. */
export const crowdReleaseTicks = (): number => GAME_CONFIG.crowd.pulse.releaseSeconds * TICKS_PER_SECOND;

interface NoticeEntry {
  readonly key: number;
  readonly kind: CrowdNoticeKind;
  /** The first tick of the current unbroken stretch with the condition; null while it is absent. */
  readonly since: number | null;
  /** The last tick the condition was seen. */
  readonly lastSeen: number;
  readonly on: boolean;
}

export interface CrowdNoticeState {
  /** The tick of the previous step (-1 before the first). */
  readonly tick: number;
  /** One entry per (neighborhood key, kind) that holds or is on, by `${key}:${kind}`. */
  readonly entries: ReadonlyMap<string, NoticeEntry>;
}

export const INITIAL_CROWD_NOTICE: CrowdNoticeState = Object.freeze({ tick: -1, entries: new Map<string, NoticeEntry>() });

/** One line that is on: the neighborhood's key and name (from the current view) and what was noticed. */
export interface CrowdNoticeLine {
  readonly key: number;
  readonly name: string;
  readonly kind: CrowdNoticeKind;
}

export interface CrowdNoticeInput {
  tick: number;
  /** The session's crowd view; null (no park yet) clears every line. */
  view: Readonly<CrowdView> | null;
  /**
   * Open services of each kind with path access anywhere in the park. Optional: defaults to the view's own
   * `openServices` (`ParkSession.crowdView()` fills it); without either, a kind counts as open somewhere when any
   * neighborhood has a share above 0 of it.
   */
  openServices?: Readonly<{ food: number; drink: number; toilet: number }> | null;
  /** Phase 49: the cleaners are swamped (`CleanerLoad.swamped`): litter lines say bins would help. Default false. */
  cleanersSwamped?: boolean;
}

export interface CrowdNoticeStep {
  state: CrowdNoticeState;
  /** Lines that are on, in Park Pulse priority, then dashboard order (gate first, then key). The first is Pulse's. */
  active: CrowdNoticeLine[];
}

const COVERAGE_KINDS = [
  ['noToilet', 'toilet'],
  ['noFood', 'food'],
  ['noDrink', 'drink'],
] as const;

/** The conditions that hold right now for one neighborhood (design Q4 thresholds, `GAME_CONFIG.crowd.pulse`). */
export const crowdConditionsOf = (
  neighborhood: Readonly<NeighborhoodView>,
  view: Readonly<CrowdView>,
  openElsewhere: Readonly<{ food: boolean; drink: boolean; toilet: boolean }>,
  cleanersSwamped = false,
): CrowdNoticeKind[] => {
  const pulse = GAME_CONFIG.crowd.pulse;
  const { metrics } = neighborhood;
  const kinds: CrowdNoticeKind[] = [];
  const bottleneck = neighborhood.worst?.bottleneck === true
    || view.bottlenecks.some((tile) => tile.neighborhoodKey === neighborhood.key);
  if (bottleneck) kinds.push('bottleneck');
  const busyTiles = metrics.bands[2] + metrics.bands[3];
  if (neighborhood.tileCount > 0 && busyTiles / neighborhood.tileCount >= pulse.crowdedShare) kinds.push('crowded');
  if (metrics.guests >= pulse.minimumGuests) {
    for (const [kind, service] of COVERAGE_KINDS) {
      if (metrics.coverage[service] === 0 && openElsewhere[service]) kinds.push(kind);
    }
  }
  if (metrics.happiness !== null && metrics.happiness < pulse.unhappyBelow && metrics.guests >= pulse.unhappyGuests) kinds.push('unhappy');
  if (metrics.litter >= pulse.litterItems) kinds.push(cleanersSwamped ? 'litterOutpaces' : 'litter');
  return kinds;
};

const openElsewhereOf = (view: Readonly<CrowdView>, open: CrowdNoticeInput['openServices']): { food: boolean; drink: boolean; toilet: boolean } => {
  if (open) return { food: open.food > 0, drink: open.drink > 0, toilet: open.toilet > 0 };
  const some = (service: 'food' | 'drink' | 'toilet'): boolean => view.neighborhoods.some((n) => n.metrics.coverage[service] > 0);
  return { food: some('food'), drink: some('drink'), toilet: some('toilet') };
};

export const stepCrowdNotice = (state: CrowdNoticeState, input: CrowdNoticeInput): CrowdNoticeStep => {
  const { tick, view } = input;
  if (view === null) return { state: { tick, entries: new Map() }, active: [] };
  // A rewind (or a stale tracker) restarts every stretch instead of counting negative time.
  const previous = tick < state.tick ? INITIAL_CROWD_NOTICE.entries : state.entries;
  const openElsewhere = openElsewhereOf(view, input.openServices ?? view.openServices);
  const release = crowdReleaseTicks();
  const entries = new Map<string, NoticeEntry>();
  const order = new Map<number, number>();
  view.neighborhoods.forEach((neighborhood, index) => {
    order.set(neighborhood.key, index);
    const now = new Set(crowdConditionsOf(neighborhood, view, openElsewhere, input.cleanersSwamped === true));
    for (const kind of CROWD_NOTICE_PRIORITY) {
      const id = `${neighborhood.key}:${kind}`;
      const old = previous.get(id);
      if (now.has(kind)) {
        const since = old?.since ?? tick;
        const on = old?.on === true || tick - since >= crowdHoldTicks(kind);
        entries.set(id, { key: neighborhood.key, kind, since, lastSeen: tick, on });
      } else if (old?.on === true && tick - old.lastSeen < release) {
        entries.set(id, { ...old, since: null });
      }
    }
  });
  const names = new Map(view.neighborhoods.map((neighborhood) => [neighborhood.key, neighborhood.name]));
  const active: CrowdNoticeLine[] = [...entries.values()]
    .filter((entry) => entry.on)
    .sort((a, b) => (
      CROWD_NOTICE_PRIORITY.indexOf(a.kind) - CROWD_NOTICE_PRIORITY.indexOf(b.kind)
      || (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0)
    ))
    .map((entry) => ({ key: entry.key, name: names.get(entry.key) ?? '', kind: entry.kind }));
  return { state: { tick, entries }, active };
};
