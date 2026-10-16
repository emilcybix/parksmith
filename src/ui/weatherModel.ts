import { formatClock } from '../game/calendar/calendarMath';
import { GAME_CONFIG } from '../game/config';
import { BIOME_BY_ID, DEFAULT_BIOME_ID } from '../game/biomes/content';
import type { BiomeId } from '../game/biomes/types';
import type { ClimateBand } from '../game/weather/climate';
import { arrivalDeltaPercent } from '../game/weather/effects';
import type { WeatherForecastEntry, WeatherKind, WeatherSeverity, WeatherSlotIndex } from '../game/weather/types';
import { SOUVENIR_KINDS, type SouvenirKind } from '../game/types';

/**
 * Pure text for the weather chip, its forecast and the Park Pulse "Weather: why" lines. Nothing here
 * reads the simulation: GameApp builds a `WeatherUi` of primitives and the components render it.
 */

export const WEATHER_LABELS: Record<WeatherKind, string> = {
  sunny: 'Sunny',
  hot: 'Hot',
  cloudy: 'Cloudy',
  rain: 'Rain',
  storm: 'Storm',
};

/** Text-presentation glyphs (U+FE0E) so they follow the page colour and never turn into colour emoji. */
export const WEATHER_GLYPHS: Record<WeatherKind, string> = {
  sunny: '☀︎',
  hot: '♨︎',
  cloudy: '☁︎',
  rain: '☂︎',
  storm: '⚡︎',
};
export const WEATHER_OFF_GLYPH = '–';

/**
 * The weather words of a place (Phase 24): the base labels with the biome's own names laid over them (Winter's rain is
 * "Sleet", its storm a "Blizzard"). Presentation only: the kinds and their effects are the same everywhere, and Meadow
 * has no override, so its text is exactly `WEATHER_LABELS`.
 */
export const weatherLabelsFor = (biomeId: BiomeId): Record<WeatherKind, string> => {
  const overrides = BIOME_BY_ID.get(biomeId)?.weatherLabels;
  return overrides === undefined || Object.keys(overrides).length === 0 ? WEATHER_LABELS : { ...WEATHER_LABELS, ...overrides };
};

export const SEVERITY_OPTIONS: ReadonlyArray<{ id: 'off' | WeatherSeverity; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'low', label: 'Low' },
  { id: 'normal', label: 'Normal' },
  { id: 'high', label: 'High' },
];

export interface OpeningHoursUi {
  hoursEnabled: boolean;
  openHour: number;
  closeHour: number;
  /** The schedule says the gate is open (always true when hours are off). */
  scheduleOpen: boolean;
}

/** Everything the weather chip, its popover and the Pulse lines show, as primitives (no object identity). */
export interface WeatherUi extends OpeningHoursUi {
  weatherEnabled: boolean;
  weatherKind: WeatherKind;
  weatherIntensityPercent: number;
  weatherSeverity: WeatherSeverity;
  /** false in a scenario park: forecast only, no switches. */
  weatherEditable: boolean;
  /** Percent change in arrivals caused by the weather right now (negative = fewer). */
  arrivalDeltaPercent: number;
  /** Open-air rides a storm is holding closed right now. */
  stormClosedRides: number;
  /** The park toggle is on (the player's own switch). */
  parkOpen: boolean;
  /** Merged forecast rows ("Now: Rain 70%", "18:00 Cloudy", ...), at most four. */
  forecastText: string[];
  /** The map's biome (Phase 24): picks the weather words and the climate wording. Meadow: today's text. */
  biomeId: BiomeId;
  /** The biome's temperature band; 'mild' says nothing in the Pulse. */
  climate: ClimateBand;
  /** The biome's climate chip text ("Mild", "Hot and dry"), shown quietly in the clock popover. */
  climateLabel: string;
  /**
   * Phase 30: the souvenir kinds guests want right now, by the same rule the guests use (`life.ts` souvenirSellsNow:
   * umbrellas in the rain, sun hats in the heat, glow wands at night, balloons and plush toys always), in
   * SOUVENIR_KINDS order. Read by the souvenir stall inspector's "Demand now" line.
   */
  sellingSouvenirs: SouvenirKind[];
}

export const DEFAULT_WEATHER_UI: WeatherUi = {
  weatherEnabled: true,
  weatherKind: 'sunny',
  weatherIntensityPercent: 70,
  weatherSeverity: 'normal',
  weatherEditable: true,
  arrivalDeltaPercent: 0,
  stormClosedRides: 0,
  parkOpen: true,
  forecastText: ['Now: Sunny 70%'],
  biomeId: DEFAULT_BIOME_ID,
  climate: 'mild',
  climateLabel: 'Mild',
  sellingSouvenirs: ['balloon', 'plush'],
  hoursEnabled: false,
  openHour: GAME_CONFIG.calendar.hours.defaultOpen,
  closeHour: GAME_CONFIG.calendar.hours.defaultClose,
  scheduleOpen: true,
};

/** Stable string of every field, so the store is written only when something visible changed. */
export const weatherUiKey = (ui: WeatherUi): string => JSON.stringify(ui);

const slotStartHour = (slot: WeatherSlotIndex): number => (
  (GAME_CONFIG.calendar.startHour + slot * (GAME_CONFIG.calendar.hoursPerDay / GAME_CONFIG.weather.slotsPerDay))
  % GAME_CONFIG.calendar.hoursPerDay
);

const whenText = (entry: WeatherForecastEntry, currentDay: number): string => {
  const time = formatClock(slotStartHour(entry.slot), 0);
  if (entry.day <= currentDay) return time;
  return entry.day === currentDay + 1 ? `Tomorrow ${time}` : `Day ${entry.day} ${time}`;
};

const percent = (intensity: number): number => Math.round(intensity * 100);

/**
 * "Now: Rain 70%", then one row per change ("18:00 Cloudy", "Tomorrow 12:00 Storm", "Day 7 12:00 Rain"),
 * consecutive equal kinds merged, at most four rows. A forecast that never changes says so.
 */
export const forecastRows = (
  now: { kind: WeatherKind; intensity: number },
  entries: readonly WeatherForecastEntry[],
  currentDay: number,
  labels: Readonly<Record<WeatherKind, string>> = WEATHER_LABELS,
): string[] => {
  const rows = [`Now: ${labels[now.kind]} ${percent(now.intensity)}%`];
  let last = now.kind;
  for (const entry of entries) {
    if (entry.kind === last) continue;
    if (rows.length >= 4) break;
    rows.push(`${whenText(entry, currentDay)} ${labels[entry.kind]}`);
    last = entry.kind;
  }
  if (rows.length === 1) rows.push('No change in the next two days.');
  return rows;
};

export const weatherChipLabel = (ui: WeatherUi): string => (
  ui.weatherEnabled ? weatherLabelsFor(ui.biomeId)[ui.weatherKind] : 'Off'
);

export const weatherChipGlyph = (ui: WeatherUi): string => (
  ui.weatherEnabled ? WEATHER_GLYPHS[ui.weatherKind] : WEATHER_OFF_GLYPH
);

/** Accessible name and tooltip: current weather, what comes next, the whole forecast. */
export const weatherAriaLabel = (ui: WeatherUi): string => {
  const tail = ui.weatherEditable ? 'Forecast and weather settings' : 'Forecast';
  if (!ui.weatherEnabled) return `Weather: off. ${ui.weatherEditable ? 'Weather settings' : 'Forecast'}`;
  const next = ui.forecastText[1];
  return `Weather: ${weatherLabelsFor(ui.biomeId)[ui.weatherKind]}, ${ui.weatherIntensityPercent} percent. `
    + `${next ? `Next: ${next}. ` : ''}${tail}`;
};

export const weatherTooltip = (ui: WeatherUi, lifeEnabled: boolean = GAME_CONFIG.guestLife.enabled): string => {
  const base = ui.weatherEnabled ? `Weather forecast\n${ui.forecastText.join('\n')}` : 'Weather is switched off in this Sandbox';
  // Phase 33: the guest-life effects of the weather and the night follow the forecast.
  const guests = weatherGuestLines(ui, lifeEnabled);
  return guests.length === 0 ? base : `${base}\n${guests.join('\n')}`;
};

/** The park toggle's whole label while the schedule holds the gate shut: "Opens 08:00" (replaces "Park open"). */
export const scheduleClosedLabel = (ui: OpeningHoursUi & { parkOpen: boolean }): string | null => (
  ui.parkOpen && ui.hoursEnabled && !ui.scheduleOpen ? `Opens ${formatClock(ui.openHour, 0)}` : null
);

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * One short line explaining the active weather effect, or null (cloudy, weather off, nothing notable). Phase 33: with
 * guest life on, the heat line names sun hats too; the rest of the Phase 29 effects (soaked guests, umbrellas, the
 * cold night) are taught by `weatherGuestLines` in the clock popover and the weather chip's tooltip, so the Pulse keeps
 * one weather line inside its three-line budget.
 */
export const describeWeatherEffects = (ui: WeatherUi, lifeEnabled: boolean = GAME_CONFIG.guestLife.enabled): string | null => {
  if (!ui.weatherEnabled) return null;
  const delta = ui.arrivalDeltaPercent;
  const down = Math.abs(delta);
  // The biome's own word for the weather ("sleet", "blizzard"); the effects below are the same everywhere.
  const word = weatherLabelsFor(ui.biomeId)[ui.weatherKind].toLowerCase();
  switch (ui.weatherKind) {
    case 'storm':
      return ui.stormClosedRides >= 1
        ? `Weather: ${word}. ${plural(ui.stormClosedRides, 'open-air ride')} closed until it passes.`
        : `Weather: ${word}. Arrivals down ${down}%; covered rides draw the crowd.`;
    case 'rain':
      return `Weather: ${word}. Arrivals down ${down}%; guests favour covered rides and warm food.`;
    case 'hot':
      return lifeEnabled
        ? 'Weather: heat. Thirstier guests walk slower; cold drinks and sun hats sell best.'
        : 'Weather: heat. Thirstier guests walk slower; cold drinks sell best.';
    case 'sunny':
      if (delta < GAME_CONFIG.weather.effects.pulseMinArrivalDeltaPercent) return null;
      // Cold treats are not in demand in a cold place: the climate line says what is.
      return ui.climate === 'cold' || ui.climate === 'cool'
        ? `Weather: sunny. Arrivals up ${delta}%.`
        : `Weather: sunny. Arrivals up ${delta}%; cold treats are in demand.`;
    default:
      return null;
  }
};

/**
 * Phase 33: what the weather and the night do to the guests right now (the Phase 29 guest-life effects), one line
 * each, for the clock popover and the weather chip's tooltip; never Park Pulse lines. Rain and night come from
 * `sellingSouvenirs`, which follows the guests' own rule (umbrellas while it rains, glow wands at night), so the
 * text can never claim a rain or a night the guests do not feel. Empty with guest life off.
 */
export const weatherGuestLines = (ui: WeatherUi, lifeEnabled: boolean = GAME_CONFIG.guestLife.enabled): string[] => {
  if (!lifeEnabled) return [];
  const lines: string[] = [];
  const labels = weatherLabelsFor(ui.biomeId);
  if (ui.weatherEnabled && ui.sellingSouvenirs.includes('umbrella')) {
    lines.push(`${labels[ui.weatherKind]}: guests without an umbrella get soaked and unhappy; umbrellas sell.`);
  }
  if (ui.weatherEnabled && ui.weatherKind === 'hot') {
    lines.push(`${labels.hot}: guests get hot and thirsty; sun hats and cold drinks sell.`);
  }
  if (ui.sellingSouvenirs.includes('glowWand')) {
    lines.push('Night: guests get cold; warm drinks and glow wands sell.');
  }
  return lines;
};

/** The place's climate in one line (Phase 24), or null for a mild one. Wording follows the cold effect's numbers. */
export const describeClimateLine = (ui: WeatherUi): PulseLine | null => {
  switch (ui.climate) {
    case 'cold': return { glyph: '❄︎', text: 'Cold climate: warm food draws guests; cold drinks sell slowly.' };
    case 'cool': return { glyph: '❄︎', text: 'Cool climate: warm food sells a little better.' };
    case 'warm': return { glyph: '☀︎', text: 'Warm climate: cold drinks sell a little better.' };
    case 'hot': return { glyph: '♨︎', text: 'Hot climate: guests get thirsty fast; cold drinks sell best.' };
    default: return null;
  }
};

/** "Closed by opening hours until 08:00." while hours hold a manually open gate shut. */
export const describeScheduleLine = (ui: OpeningHoursUi & { parkOpen: boolean }): string | null => (
  ui.parkOpen && ui.hoursEnabled && !ui.scheduleOpen ? `Closed by opening hours until ${formatClock(ui.openHour, 0)}.` : null
);

/** The quiet line in the clock popover: where the park is and whether the climate still applies with the weather off. */
export const climateText = (ui: WeatherUi): string => (
  ui.weatherEnabled ? `Climate: ${ui.climateLabel}` : `Climate: ${ui.climateLabel} (still applies with the weather off)`
);

export interface PulseLine {
  glyph: string;
  text: string;
}

/**
 * The lines Park Pulse shows above the guests' thoughts: opening hours first, then the weather. Phase 30 revises
 * PA-009: the climate line (Phase 24) no longer takes a Pulse slot, because with the weather line it filled the whole
 * budget and no guest thought could show; it stays in the clock popover (`climateText`, told even with the weather off).
 */
export const pulseWeatherLines = (ui: WeatherUi): PulseLine[] => {
  const lines: PulseLine[] = [];
  const schedule = describeScheduleLine(ui);
  if (schedule) lines.push({ glyph: '◷', text: schedule });
  const weather = describeWeatherEffects(ui);
  if (weather) lines.push({ glyph: WEATHER_GLYPHS[ui.weatherKind], text: weather });
  return lines;
};

/** Phase 30: when each keepsake sells, for the stall inspector ("Umbrellas sell in the rain"). */
export const SOUVENIR_DEMAND_RULE: Readonly<Record<SouvenirKind, string>> = {
  umbrella: 'Umbrellas sell in the rain',
  hat: 'Sun hats sell in the heat',
  balloon: 'Balloons sell all day',
  plush: 'Plush toys sell all day',
  glowWand: 'Glow wands sell at night',
};

/** Phase 30: what the stall misses right now, when its keepsake is not wanted. */
const SOUVENIR_IDLE_REASON: Readonly<Record<SouvenirKind, string>> = {
  umbrella: 'dry now',
  hat: 'cool now',
  balloon: 'nobody buying',
  plush: 'nobody buying',
  glowWand: 'daylight now',
};

/**
 * Phase 30: the souvenir stall inspector's "Demand now" line, from the same desire rule the guests use (the kinds in
 * `sellingSouvenirs`): "Umbrellas sell in the rain · dry now" or "… · selling now".
 */
export const souvenirDemandLine = (kind: SouvenirKind, ui: Pick<WeatherUi, 'sellingSouvenirs'>): string => (
  `${SOUVENIR_DEMAND_RULE[kind]} · ${ui.sellingSouvenirs.includes(kind) ? 'selling now' : SOUVENIR_IDLE_REASON[kind]}`
);

/** Builds the primitives from simulation values; the only place that joins them. */
export const weatherUiOf = (input: {
  enabled: boolean;
  kind: WeatherKind;
  intensity: number;
  severity: WeatherSeverity;
  editable: boolean;
  stormClosedRides: number;
  parkOpen: boolean;
  forecast: readonly WeatherForecastEntry[];
  day: number;
  hours: OpeningHoursUi;
  /** The park's biome and its band (absent: Meadow). */
  biomeId?: BiomeId;
  climate?: ClimateBand;
  climateLabel?: string;
  /** Phase 30: which keepsakes sell right now (absent: the always-selling balloons and plush toys). */
  sellingSouvenirs?: readonly SouvenirKind[];
}): WeatherUi => ({
  weatherEnabled: input.enabled,
  weatherKind: input.enabled ? input.kind : 'sunny',
  weatherIntensityPercent: input.enabled ? percent(input.intensity) : 0,
  weatherSeverity: input.severity,
  weatherEditable: input.editable,
  arrivalDeltaPercent: input.enabled ? arrivalDeltaPercent(input.kind, input.intensity) : 0,
  stormClosedRides: input.stormClosedRides,
  parkOpen: input.parkOpen,
  forecastText: input.enabled
    ? forecastRows({ kind: input.kind, intensity: input.intensity }, input.forecast, input.day, weatherLabelsFor(input.biomeId ?? DEFAULT_BIOME_ID))
    : [],
  biomeId: input.biomeId ?? DEFAULT_BIOME_ID,
  climate: input.climate ?? 'mild',
  climateLabel: input.climateLabel ?? 'Mild',
  sellingSouvenirs: SOUVENIR_KINDS.filter((kind) => (input.sellingSouvenirs ?? DEFAULT_WEATHER_UI.sellingSouvenirs).includes(kind)),
  ...input.hours,
});
