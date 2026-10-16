import { GAME_CONFIG } from '../game/config';

/**
 * Phase 11 (PA-009): the "park at capacity" flag and its one-off toast.
 *
 * App layer on purpose. A Management notification is saved state (`pendingNotifications`, `lastNotificationAt`), so a
 * new kind would change the saved state of any park that reaches it. This tracker is transient: never saved, reset on
 * every session swap, and driven by world ticks only, so a paused park freezes it.
 *
 * - On: the guest count has been at or above the ceiling (and the ceiling is above 0) for `ON_TICKS` (10 simulated s).
 * - Off: the count falls to `ceiling - max(2, ceil(ceiling × 0.1))` or below, the ceiling rises above the count (a new
 *   ride, a better rating), or the ceiling drops to 0 (the gate is shut: the park is closed, not full).
 * - Fire: once, when the flag has held for `FIRE_TICKS` (60 simulated s). It re-arms only after the flag turned off.
 *   The toast's words are `capacityToast` in `ui/capacityModel.ts`.
 */

const TICKS_PER_SECOND = 1_000 / GAME_CONFIG.fixedStepMs;
export const CAPACITY_ON_TICKS = 10 * TICKS_PER_SECOND;
export const CAPACITY_FIRE_TICKS = 60 * TICKS_PER_SECOND;

export interface CapacityNoticeState {
  /** The tick the count first reached the ceiling in the current stretch; null while below it. */
  readonly fullSinceTick: number | null;
  /** The tick the flag turned on; null while it is off. */
  readonly atCapacitySinceTick: number | null;
  /** The toast already fired for this stretch at capacity. */
  readonly fired: boolean;
  /** The ceiling of the previous step, so a rising ceiling can turn the flag off. */
  readonly ceiling: number;
}

export const INITIAL_CAPACITY_NOTICE: CapacityNoticeState = {
  fullSinceTick: null,
  atCapacitySinceTick: null,
  fired: false,
  ceiling: 0,
};

export interface CapacityNoticeInput {
  tick: number;
  guestCount: number;
  ceiling: number;
}

export interface CapacityNoticeStep {
  state: CapacityNoticeState;
  atCapacity: boolean;
  /** True on exactly one step per stretch at capacity: show the toast. */
  fire: boolean;
}

/** How far below the ceiling the count must fall before the flag turns off (hysteresis against one guest leaving). */
export const capacityReleaseMargin = (ceiling: number): number => Math.max(2, Math.ceil(ceiling * 0.1));

export const stepCapacityNotice = (state: CapacityNoticeState, input: CapacityNoticeInput): CapacityNoticeStep => {
  const { tick, guestCount, ceiling } = input;
  const full = ceiling > 0 && guestCount >= ceiling;
  // A tick that ran backwards (a stale state across a rewind) restarts the stretch instead of counting negative time.
  const fullSince = full ? (state.fullSinceTick !== null && state.fullSinceTick <= tick ? state.fullSinceTick : tick) : null;

  let since = state.atCapacitySinceTick !== null && state.atCapacitySinceTick <= tick ? state.atCapacitySinceTick : null;
  let fired = since === null ? false : state.fired;
  if (since !== null) {
    const released = ceiling <= 0
      || guestCount <= ceiling - capacityReleaseMargin(ceiling)
      || (ceiling > state.ceiling && ceiling > guestCount);
    if (released) {
      since = null;
      fired = false;
    }
  } else if (fullSince !== null && tick - fullSince >= CAPACITY_ON_TICKS) {
    since = tick;
  }

  const fire = since !== null && !fired && tick - since >= CAPACITY_FIRE_TICKS;
  if (fire) fired = true;
  const next: CapacityNoticeState = { fullSinceTick: fullSince, atCapacitySinceTick: since, fired, ceiling };
  return { state: next, atCapacity: since !== null, fire };
};

