/**
 * Plain weather types shared by the simulation, the save format and the presentation seam.
 * Everything here is data: no class, no function, nothing that reads a clock.
 */

export const WEATHER_KINDS = ['sunny', 'hot', 'cloudy', 'rain', 'storm'] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];

export const WEATHER_SEVERITIES = ['low', 'normal', 'high'] as const;
export type WeatherSeverity = (typeof WEATHER_SEVERITIES)[number];

/** Six hour quarter of the calendar day: 0 = 06-12, 1 = 12-18, 2 = 18-24, 3 = 00-06. */
export type WeatherSlotIndex = 0 | 1 | 2 | 3;

/**
 * The per-tick numbers every owner reads, overwritten IN PLACE once per tick by WeatherSimulation
 * (O(1), no allocation). It is derived data: a pure function of the saved tick, calendar, weather
 * and rules, so it is never saved and refreshing it twice changes nothing.
 */
export interface ParkConditions {
  /** Opening hours say the gate is open (always true when hours are off). */
  scheduleOpen: boolean;
  /** Arrival curve at the clock hour times the weather factor; 0 while the schedule is closed. */
  arrivalRate: number;
  /** The weather that is effective now ('sunny' at intensity 0 when weather is off). */
  weatherKind: WeatherKind;
  /** Effective intensity 0..1 (sandbox severity applied), 0 when weather is off. */
  weatherIntensity: number;
  /** Weather part of arrivalRate (1 = neutral). */
  arrivalWeatherFactor: number;
  /** An effective storm: open-air rides are closed for it. */
  stormActive: boolean;
  /** Multiplies thirst growth. */
  thirstFactor: number;
  /** Multiplies guest walking speed. */
  walkSpeedFactor: number;
  /** Ride utility points for covered and for open-air rides. */
  coveredRideBonus: number;
  openAirRideBonus: number;
  /** Service utility points for warm food and for cold treats and drinks. */
  warmFoodBonus: number;
  coldTreatBonus: number;
  /**
   * Phase 29: how warm the park feels to a guest, 0..100 (50 = comfortable): the weather, the biome's temperature and
   * the night. Guests' own warmth drifts toward it.
   */
  ambientWarmth: number;
  /** Phase 29: the clock is in the night hours. */
  night: boolean;
}

export const neutralConditions = (): ParkConditions => ({
  scheduleOpen: true,
  arrivalRate: 1,
  weatherKind: 'sunny',
  weatherIntensity: 0,
  arrivalWeatherFactor: 1,
  stormActive: false,
  thirstFactor: 1,
  walkSpeedFactor: 1,
  coveredRideBonus: 0,
  openAirRideBonus: 0,
  warmFoodBonus: 0,
  coldTreatBonus: 0,
  ambientWarmth: 50,
  night: false,
});

/**
 * The read-only weather picture for the presentation layer. Filled in place per frame by
 * `WeatherSimulation.viewInto`; nothing flows back. Weather off reads as a clear sky.
 */
export interface WeatherView {
  enabled: boolean;
  kind: WeatherKind;
  /** 0..1, effective (sandbox severity applied), 0 when disabled. */
  intensity: number;
  /** The kind of the previous slot, for blending the look across a slot edge. */
  previousKind: WeatherKind;
  day: number;
  slot: WeatherSlotIndex;
  /** 0..1 through the six hour slot. Continuous across slot edges (it wraps from 1 to 0). */
  segmentProgress: number;
  /** Simulation seconds since the slot began; frozen while paused (it follows the tick fraction). */
  secondsIntoSegment: number;
  /** uint32 identifying this slot's storm; 0 unless the kind is 'storm'. Feed it to stormFlashAt. */
  flashSeed: number;
}

export const createWeatherView = (): WeatherView => ({
  enabled: true,
  kind: 'sunny',
  intensity: 0,
  previousKind: 'sunny',
  day: 1,
  slot: 0,
  segmentProgress: 0,
  secondsIntoSegment: 0,
  flashSeed: 0,
});

export interface WeatherForecastEntry {
  day: number;
  slot: WeatherSlotIndex;
  kind: WeatherKind;
  /** Effective intensity 0..1. */
  intensity: number;
}

// Saved shape (the owner key in the save is `weather`).

export interface WeatherSlotState {
  kind: WeatherKind;
  /** 0..1, two decimals, as drawn (before the sandbox severity scale). */
  intensity: number;
}

export interface WeatherDayState {
  /** The kind the Markov chain drew for the day; the slots follow its arc. */
  kind: WeatherKind;
  slots: [WeatherSlotState, WeatherSlotState, WeatherSlotState, WeatherSlotState];
}

export interface WeatherState {
  /** Sandbox switch; effects and the view are off when false, the chain keeps advancing. */
  enabled: boolean;
  /** Sandbox switch: scales the effective intensity only, never the drawn kinds. */
  severity: WeatherSeverity;
  /** uint32 state of the weather-only random stream. */
  rngState: number;
  /** Markov state: the kind of the last drawn day (the first-day kind while `days` is empty). */
  chainKind: WeatherKind;
  /** Integer >= 1: the day number of days[0]. */
  firstDay: number;
  /**
   * Already drawn days, contiguous: the forecast IS the saved future. Empty only in a migrated,
   * never stepped save; the restore draws them from the saved stream.
   */
  days: WeatherDayState[];
}
