import { arrivalCurveAt } from '../calendar/arrivalCurve';
import { UNITS_PER_DAY, clockFractionOf, isScheduleOpen } from '../calendar/calendarMath';
import type { ParkCalendar } from '../calendar/ParkCalendar';
import { GAME_CONFIG } from '../config';
import { MAXIMUM_SAVED_COUNTER } from '../save/ranges';
import type { Serializable } from '../save/state';
import { invalidState } from '../save/version';
import { drawDay, firstDayOf } from './chain';
import { NEUTRAL_CLIMATE, applyClimate, type ClimateInput } from './climate';
import { applyWeatherEffects } from './effects';
import { WeatherRandom, hash32, mixSeed } from './random';
import {
  WEATHER_KINDS,
  WEATHER_SEVERITIES,
  neutralConditions,
  type ParkConditions,
  type WeatherDayState,
  type WeatherForecastEntry,
  type WeatherKind,
  type WeatherSeverity,
  type WeatherSlotIndex,
  type WeatherSlotState,
  type WeatherState,
  type WeatherView,
} from './types';

const OWNER = 'WeatherSimulation';

/** The ruleset keys the weather reads (all multipliers, 1 = neutral). */
export interface WeatherRules {
  /** Scales the share of rain and storm in the days drawn after the first. */
  wetWeatherMultiplier: number;
  /** Scales the effective intensity of hot, rain and storm (sunny is exempt: its effect is a bonus). */
  weatherEffectMultiplier: number;
  /** Scales the organic arrival rate at night (`hour >= nightStart || hour < dawnStart`). */
  nightArrivalMultiplier: number;
}

/** A bare number is the wet-weather multiplier with the Phase 25 keys at 1 (the pre-Phase-25 signature). */
const weatherRulesOf = (rules: number | WeatherRules): WeatherRules => (
  typeof rules === 'number'
    ? { wetWeatherMultiplier: rules, weatherEffectMultiplier: 1, nightArrivalMultiplier: 1 }
    : {
      wetWeatherMultiplier: rules.wetWeatherMultiplier,
      weatherEffectMultiplier: rules.weatherEffectMultiplier,
      nightArrivalMultiplier: rules.nightArrivalMultiplier,
    }
);

const { nightStart: NIGHT_START_HOUR, dawnStart: DAWN_START_HOUR } = GAME_CONFIG.calendar.phaseHours;

/** Night for the arrival rule: 21:30 to 05:00 (the calendar's night phase). */
const isNightHour = (hour: number): boolean => hour >= NIGHT_START_HOUR || hour < DAWN_START_HOUR;
const SLOTS = GAME_CONFIG.weather.slotsPerDay;
const UNITS_PER_SLOT = UNITS_PER_DAY / SLOTS;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isKind = (value: unknown): value is WeatherKind => (
  typeof value === 'string' && (WEATHER_KINDS as readonly string[]).includes(value)
);

const readSlot = (value: unknown, path: string): WeatherSlotState => {
  if (!isRecord(value)) throw invalidState(OWNER, path, 'must be an object');
  if (!isKind(value.kind)) throw invalidState(OWNER, `${path}.kind`, `must be one of ${WEATHER_KINDS.join(', ')}`);
  const intensity = value.intensity;
  if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
    throw invalidState(OWNER, `${path}.intensity`, 'must be a finite number in 0..1');
  }
  return { kind: value.kind, intensity };
};

const readDay = (value: unknown, path: string): WeatherDayState => {
  if (!isRecord(value)) throw invalidState(OWNER, path, 'must be an object');
  if (!isKind(value.kind)) throw invalidState(OWNER, `${path}.kind`, `must be one of ${WEATHER_KINDS.join(', ')}`);
  const slots = value.slots;
  if (!Array.isArray(slots) || slots.length !== SLOTS) throw invalidState(OWNER, `${path}.slots`, `must hold exactly ${SLOTS} slots`);
  return {
    kind: value.kind,
    slots: [readSlot(slots[0], `${path}.slots[0]`), readSlot(slots[1], `${path}.slots[1]`), readSlot(slots[2], `${path}.slots[2]`), readSlot(slots[3], `${path}.slots[3]`)],
  };
};

/**
 * Weather and the per-tick park conditions. The weather itself is saved data (the days already
 * drawn, so the forecast is the future); the conditions are derived from it, the calendar and the
 * rules once per tick, in place and in O(1). Nothing here reads a clock: the stream is seeded from
 * the park's seed and every draw happens when a day first comes into view.
 */
export class WeatherSimulation implements Serializable<WeatherState> {
  enabled = true;
  severity: WeatherSeverity = 'normal';
  chainKind: WeatherKind = GAME_CONFIG.weather.firstDay.kind;
  firstDay = 1;
  days: WeatherDayState[] = [];
  /** Overwritten in place every tick; the same object for the whole life of the session. */
  readonly conditions: ParkConditions = neutralConditions();
  private readonly random: WeatherRandom;
  private readonly rules: WeatherRules;

  constructor(
    private readonly seed: number,
    private readonly calendar: ParkCalendar,
    rules: number | WeatherRules,
    private readonly getTick: () => number,
    /**
     * The biome's weather mix and temperature (Phase 24). Config, NOT saved: the drawn days ARE the saved
     * future, so a later retune of a biome never rewrites a park's forecast (the biome id is in the save's `map`).
     */
    private readonly climate: ClimateInput = NEUTRAL_CLIMATE,
  ) {
    this.random = new WeatherRandom(mixSeed(seed));
    this.rules = weatherRulesOf(rules);
    this.refresh();
  }

  /** The stream state, for tests that compare a restored stream with the saved one. */
  rngStateForTest(): number {
    return this.random.getState();
  }

  /** Sandbox switches (the session refuses them in a scenario park before calling these). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.refresh();
  }

  setSeverity(severity: WeatherSeverity): void {
    this.severity = severity;
    this.refresh();
  }

  /**
   * Developer tool: overwrites the CURRENT six hour slot with `kind` (the drawn days around it stay).
   * It is ordinary saved state afterwards. Returns false when no day is drawn for the tick.
   */
  forceCurrentSlot(kind: WeatherKind, intensity: number, tick: number = this.getTick()): boolean {
    const units = this.calendar.positionUnits(tick);
    const day = Math.floor(units / UNITS_PER_DAY) + 1;
    const index = day - this.firstDay;
    if (index < 0 || index >= this.days.length) return false;
    const slot = Math.min(SLOTS - 1, Math.floor((units % UNITS_PER_DAY) / UNITS_PER_SLOT));
    this.days[index].slots[slot] = { kind, intensity: Math.min(1, Math.max(0, Math.round(intensity * 100) / 100)) };
    this.refresh(tick);
    return true;
  }

  /**
   * One-shot card primitive (Phase 25, the forecast card): overwrites the `count` slots AFTER the current one (the walk
   * `forecast()` does) with `kind` at `intensity` (clamped to 0..1, two decimals). The horizon is drawn first, so the
   * draws and the RNG are exactly what the park would have drawn; `day.kind` (the chain) is never written, so
   * `days[last].kind === chainKind` still holds and a restore accepts the result. Returns how many slots it wrote (fewer
   * than `count` only past the drawn horizon; `forecastDays` guarantees at least four).
   */
  rewriteForecast(kind: WeatherKind, count: number, intensity: number, tick: number = this.getTick()): number {
    const units = this.calendar.positionUnits(tick);
    const day = Math.floor(units / UNITS_PER_DAY) + 1;
    if (this.needsHorizon(day)) this.ensureHorizon(day);
    const current = Math.min(SLOTS - 1, Math.floor((units % UNITS_PER_DAY) / UNITS_PER_SLOT));
    const value = Math.min(1, Math.max(0, Math.round((Number.isFinite(intensity) ? intensity : 0) * 100) / 100));
    let written = 0;
    for (let offset = 1; offset <= Math.max(0, Math.floor(count)); offset += 1) {
      const absolute = current + offset;
      const entryDay = this.days[day + Math.floor(absolute / SLOTS) - this.firstDay];
      if (!entryDay) break;
      entryDay.slots[absolute % SLOTS] = { kind, intensity: value };
      written += 1;
    }
    this.refresh(tick);
    return written;
  }

  /** Called once per tick by the session, before any owner reads the conditions. */
  step(tick: number): void {
    this.refresh(tick);
  }

  /** Recomputes the conditions for `tick` (default: now). Idempotent: a pure function of saved state. */
  refresh(tick: number = this.getTick()): void {
    const units = this.calendar.positionUnits(tick);
    const day = Math.floor(units / UNITS_PER_DAY) + 1;
    if (this.needsHorizon(day)) this.ensureHorizon(day);
    const slot = this.slotAt(units, day);
    const conditions = this.conditions;
    conditions.scheduleOpen = isScheduleOpen(
      this.calendar.hoursEnabled, this.calendar.openHour, this.calendar.closeHour, clockFractionOf(units),
    );
    if (slot !== null && this.enabled) applyWeatherEffects(conditions, slot.kind, this.effectiveIntensity(slot.intensity, slot.kind));
    else applyWeatherEffects(conditions, 'sunny', 0);
    // Climate belongs to the place, not to the weather switch: it applies with the weather off too.
    applyClimate(conditions, this.climate.temperature);
    const clockHour = clockFractionOf(units) * GAME_CONFIG.calendar.hoursPerDay;
    conditions.night = isNightHour(clockHour);
    if (conditions.night) conditions.ambientWarmth += GAME_CONFIG.guestLife.warmth.nightShift;
    conditions.ambientWarmth = Math.min(100, Math.max(0, conditions.ambientWarmth));
    if (conditions.scheduleOpen) {
      const hour = clockHour;
      const rate = arrivalCurveAt(hour) * conditions.arrivalWeatherFactor;
      // The night rule multiplies only when it is not 1, so the m = 1 path is the exact pre-Phase-25 float.
      const night = this.rules.nightArrivalMultiplier;
      conditions.arrivalRate = night !== 1 && isNightHour(hour) ? rate * night : rate;
    } else {
      conditions.arrivalRate = 0;
    }
  }

  /**
   * Fills `out` (allocation-free) with the weather at `tick`, which may carry the step fraction.
   * Weather off reads as a clear sky at intensity 0.
   */
  viewInto(out: WeatherView, tick: number = this.getTick()): WeatherView {
    const units = this.calendar.positionUnits(tick);
    const day = Math.floor(units / UNITS_PER_DAY) + 1;
    const slotIndex = Math.min(SLOTS - 1, Math.floor((units % UNITS_PER_DAY) / UNITS_PER_SLOT)) as WeatherSlotIndex;
    const slot = this.slotAt(units, day);
    const inSlot = units % UNITS_PER_SLOT;
    out.enabled = this.enabled;
    out.day = day;
    out.slot = slotIndex;
    out.segmentProgress = inSlot / UNITS_PER_SLOT;
    out.secondsIntoSegment = inSlot / UNITS_PER_DAY * this.calendar.dayLengthSeconds;
    if (slot === null || !this.enabled) {
      out.kind = 'sunny';
      out.previousKind = 'sunny';
      out.intensity = 0;
      out.flashSeed = 0;
      return out;
    }
    out.kind = slot.kind;
    out.intensity = this.effectiveIntensity(slot.intensity, slot.kind);
    out.previousKind = this.previousSlotKind(day, slotIndex);
    out.flashSeed = slot.kind === 'storm' ? (hash32(this.seed, (day - 1) * SLOTS + slotIndex) || 1) : 0;
    return out;
  }

  /** The next `count` slots after the current one (allocates; the UI reads it at 4 Hz). Empty when weather is off. */
  forecast(count = 8, tick: number = this.getTick()): WeatherForecastEntry[] {
    if (!this.enabled) return [];
    const units = this.calendar.positionUnits(tick);
    const day = Math.floor(units / UNITS_PER_DAY) + 1;
    const current = Math.min(SLOTS - 1, Math.floor((units % UNITS_PER_DAY) / UNITS_PER_SLOT));
    const entries: WeatherForecastEntry[] = [];
    for (let offset = 1; offset <= count; offset += 1) {
      const absolute = current + offset;
      const entryDay = day + Math.floor(absolute / SLOTS);
      const entrySlot = (absolute % SLOTS) as WeatherSlotIndex;
      const slot = this.days[entryDay - this.firstDay]?.slots[entrySlot];
      if (!slot) break;
      entries.push({ day: entryDay, slot: entrySlot, kind: slot.kind, intensity: this.effectiveIntensity(slot.intensity, slot.kind) });
    }
    return entries;
  }

  /**
   * The drawn intensity under the severity switch and the weather-effect rule. Sunny is exempt from the rule (its
   * effect is a bonus); `x * 1` is exact, so the rule at 1 leaves every float as it was.
   */
  private effectiveIntensity(drawn: number, kind: WeatherKind): number {
    const scaled = drawn * GAME_CONFIG.weather.severityScale[this.severity];
    return Math.min(1, kind === 'sunny' ? scaled : scaled * this.rules.weatherEffectMultiplier);
  }

  private slotAt(units: number, day: number): WeatherSlotState | null {
    const index = day - this.firstDay;
    if (index < 0 || index >= this.days.length) return null;
    return this.days[index].slots[Math.min(SLOTS - 1, Math.floor((units % UNITS_PER_DAY) / UNITS_PER_SLOT))];
  }

  private previousSlotKind(day: number, slot: number): WeatherKind {
    if (slot > 0) return this.days[day - this.firstDay]?.slots[slot - 1].kind ?? 'sunny';
    return this.days[day - 1 - this.firstDay]?.slots[SLOTS - 1].kind ?? 'sunny';
  }

  private needsHorizon(day: number): boolean {
    return this.days.length === 0
      || this.firstDay + this.days.length - 1 < day + GAME_CONFIG.weather.forecastDays
      || this.firstDay < day - 1;
  }

  /**
   * Draws whole days until the saved ones cover `day` and the forecast after it, and drops days
   * older than yesterday (kept for the blend into slot 0). Runs when the day changes, so at most
   * once per game day; each drawn day costs exactly five draws.
   */
  private ensureHorizon(day: number): void {
    if (this.days.length === 0) this.firstDay = Math.max(1, day - 1);
    const last = day + GAME_CONFIG.weather.forecastDays;
    while (this.firstDay + this.days.length - 1 < last) {
      const number = this.firstDay + this.days.length;
      const drawn = number === 1 ? firstDayOf() : drawDay(this.chainKind, this.rules.wetWeatherMultiplier, this.random, this.climate.mix);
      this.days.push(drawn);
      this.chainKind = drawn.kind;
      // Dropping while drawing keeps a long jump (a very old migrated park) from holding every day.
      while (this.firstDay < day - 1 && this.days.length > 1) {
        this.days.shift();
        this.firstDay += 1;
      }
    }
    while (this.firstDay < day - 1 && this.days.length > 1) {
      this.days.shift();
      this.firstDay += 1;
    }
  }

  serialize(): WeatherState {
    return {
      enabled: this.enabled,
      severity: this.severity,
      rngState: this.random.getState(),
      chainKind: this.chainKind,
      firstDay: this.firstDay,
      days: this.days.map((day) => ({
        kind: day.kind,
        slots: day.slots.map((slot) => ({ kind: slot.kind, intensity: slot.intensity })) as WeatherDayState['slots'],
      })),
    };
  }

  restore(state: WeatherState): void {
    if (!isRecord(state)) throw invalidState(OWNER, 'weather', 'must be an object');
    if (typeof state.enabled !== 'boolean') throw invalidState(OWNER, 'enabled', 'must be a boolean');
    if (typeof state.severity !== 'string' || !(WEATHER_SEVERITIES as readonly string[]).includes(state.severity)) {
      throw invalidState(OWNER, 'severity', `must be one of ${WEATHER_SEVERITIES.join(', ')}`);
    }
    const rng: unknown = state.rngState;
    if (typeof rng !== 'number' || !Number.isInteger(rng) || rng < 0 || rng >= 0x1_0000_0000) {
      throw invalidState(OWNER, 'rngState', 'must be a uint32');
    }
    if (!isKind(state.chainKind)) throw invalidState(OWNER, 'chainKind', `must be one of ${WEATHER_KINDS.join(', ')}`);
    const firstDay: unknown = state.firstDay;
    if (typeof firstDay !== 'number' || !Number.isInteger(firstDay) || firstDay < 1 || firstDay > MAXIMUM_SAVED_COUNTER) {
      throw invalidState(OWNER, 'firstDay', 'must be an integer >= 1');
    }
    const days: unknown = state.days;
    if (!Array.isArray(days) || days.length > GAME_CONFIG.weather.maxSavedDays) {
      throw invalidState(OWNER, 'days', `must be an array of at most ${GAME_CONFIG.weather.maxSavedDays} days`);
    }
    const read = days.map((day, index) => readDay(day, `days[${index}]`));
    if (read.length > 0 && read[read.length - 1].kind !== state.chainKind) {
      throw invalidState(OWNER, 'chainKind', 'must equal the kind of the last drawn day');
    }
    this.enabled = state.enabled;
    this.severity = state.severity;
    this.random.setState(rng);
    this.chainKind = state.chainKind;
    this.firstDay = firstDay;
    this.days = read;
    // Only a migrated, never stepped save has no days: draw them from the saved stream.
    this.refresh();
  }
}
