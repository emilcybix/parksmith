import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../game/config';
import { WEATHER_KINDS, type WeatherForecastEntry, type WeatherKind } from '../game/weather/types';
import {
  climateText,
  DEFAULT_WEATHER_UI,
  describeClimateLine,
  describeScheduleLine,
  describeWeatherEffects,
  forecastRows,
  pulseWeatherLines,
  scheduleClosedLabel,
  souvenirDemandLine,
  type WeatherUi,
  WEATHER_GLYPHS,
  WEATHER_LABELS,
  weatherAriaLabel,
  weatherChipGlyph,
  weatherChipLabel,
  weatherLabelsFor,
  weatherTooltip,
  weatherUiKey,
  weatherGuestLines,
  weatherUiOf,
} from './weatherModel';

const ui = (overrides: Partial<WeatherUi> = {}): WeatherUi => ({ ...DEFAULT_WEATHER_UI, ...overrides });
const entry = (day: number, slot: 0 | 1 | 2 | 3, kind: WeatherKind): WeatherForecastEntry => ({ day, slot, kind, intensity: 0.5 });

describe('weather chip text', () => {
  it('has a label and a glyph for every kind, and a dash when the weather is off', () => {
    for (const kind of WEATHER_KINDS) {
      const state = ui({ weatherKind: kind });
      expect(weatherChipLabel(state)).toBe(WEATHER_LABELS[kind]);
      expect(weatherChipGlyph(state)).toBe(WEATHER_GLYPHS[kind]);
      expect(WEATHER_GLYPHS[kind]).toContain('︎');
    }
    const off = ui({ weatherEnabled: false });
    expect(weatherChipLabel(off)).toBe('Off');
    expect(weatherChipGlyph(off)).toBe('–');
  });

  it('the accessible name says the weather, the intensity, what comes next and that it opens settings', () => {
    const state = ui({ weatherKind: 'rain', weatherIntensityPercent: 70, forecastText: ['Now: Rain 70%', '18:00 Cloudy'] });
    expect(weatherAriaLabel(state)).toBe('Weather: Rain, 70 percent. Next: 18:00 Cloudy. Forecast and weather settings');
    expect(weatherAriaLabel(ui({ weatherEnabled: false }))).toBe('Weather: off. Weather settings');
    const scenario = weatherAriaLabel({ ...state, weatherEditable: false });
    expect(scenario).toBe('Weather: Rain, 70 percent. Next: 18:00 Cloudy. Forecast');
    expect(weatherAriaLabel(ui({ weatherEnabled: false, weatherEditable: false }))).toBe('Weather: off. Forecast');
    expect(weatherTooltip(state)).toBe('Weather forecast\nNow: Rain 70%\n18:00 Cloudy');
    expect(weatherTooltip(ui({ weatherEnabled: false }))).toMatch(/switched off/);
  });
});

describe('forecast rows', () => {
  const now = { kind: 'rain' as const, intensity: 0.7 };

  it('starts with "Now" and lists each change with its time, "Tomorrow" and "Day N"', () => {
    const rows = forecastRows(now, [
      entry(3, 2, 'rain'), entry(3, 3, 'cloudy'), entry(4, 0, 'cloudy'), entry(4, 1, 'storm'), entry(4, 2, 'rain'), entry(5, 0, 'sunny'),
    ], 3);
    expect(rows).toEqual(['Now: Rain 70%', '00:00 Cloudy', 'Tomorrow 12:00 Storm', 'Tomorrow 18:00 Rain']);
  });

  it('merges consecutive equal kinds, and at most four rows are shown', () => {
    const many = [entry(1, 1, 'sunny'), entry(1, 2, 'cloudy'), entry(1, 3, 'hot'), entry(2, 0, 'storm'), entry(2, 1, 'rain'), entry(2, 2, 'sunny')];
    expect(forecastRows(now, many, 1)).toHaveLength(4);
    expect(forecastRows({ kind: 'sunny', intensity: 1 }, [entry(1, 1, 'sunny'), entry(1, 2, 'sunny')], 1)).toEqual(['Now: Sunny 100%', 'No change in the next two days.']);
  });

  it('labels days after tomorrow with the day number and the slot start time', () => {
    expect(forecastRows({ kind: 'sunny', intensity: 0.5 }, [entry(7, 1, 'rain')], 5)).toEqual(['Now: Sunny 50%', 'Day 7 12:00 Rain']);
    expect(forecastRows({ kind: 'sunny', intensity: 0.5 }, [entry(6, 0, 'cloudy')], 5)).toEqual(['Now: Sunny 50%', 'Tomorrow 06:00 Cloudy']);
  });
});

describe('weatherUiOf and its key', () => {
  const input = (overrides: Record<string, unknown> = {}) => weatherUiOf({
    enabled: true, kind: 'storm', intensity: 0.84, severity: 'high', editable: true, stormClosedRides: 2, parkOpen: true,
    forecast: [entry(1, 2, 'rain')], day: 1,
    hours: { hoursEnabled: false, openHour: 8, closeHour: 21, scheduleOpen: true },
    ...overrides,
  } as Parameters<typeof weatherUiOf>[0]);

  it('joins the simulation values into primitives and rounds the percentages', () => {
    expect(input()).toMatchObject({
      weatherEnabled: true, weatherKind: 'storm', weatherIntensityPercent: 84, weatherSeverity: 'high', weatherEditable: true,
      stormClosedRides: 2, arrivalDeltaPercent: -50, forecastText: ['Now: Storm 84%', '18:00 Rain'],
    });
  });

  it('weather off reads as a calm sunny zero, with no forecast and no arrival effect', () => {
    expect(input({ enabled: false })).toMatchObject({ weatherEnabled: false, weatherKind: 'sunny', weatherIntensityPercent: 0, arrivalDeltaPercent: 0, forecastText: [] });
  });

  it('the key changes when anything visible changes and is stable otherwise', () => {
    expect(weatherUiKey(input())).toBe(weatherUiKey(input()));
    expect(weatherUiKey(input())).not.toBe(weatherUiKey(input({ intensity: 0.85 })));
    expect(weatherUiKey(input())).not.toBe(weatherUiKey(input({ stormClosedRides: 3 })));
    expect(weatherUiKey(input())).not.toBe(weatherUiKey(input({ hours: { hoursEnabled: true, openHour: 8, closeHour: 21, scheduleOpen: false } })));
  });
});

describe('Park Pulse weather lines', () => {
  const lineFor = (overrides: Partial<WeatherUi>): string | null => describeWeatherEffects(ui(overrides));

  it('explains each active effect in one short line', () => {
    expect(lineFor({ weatherKind: 'storm', stormClosedRides: 3, arrivalDeltaPercent: -55 })).toBe('Weather: storm. 3 open-air rides closed until it passes.');
    expect(lineFor({ weatherKind: 'storm', stormClosedRides: 1 })).toBe('Weather: storm. 1 open-air ride closed until it passes.');
    expect(lineFor({ weatherKind: 'storm', stormClosedRides: 0, arrivalDeltaPercent: -55 })).toBe('Weather: storm. Arrivals down 55%; covered rides draw the crowd.');
    expect(lineFor({ weatherKind: 'rain', arrivalDeltaPercent: -30 })).toBe('Weather: rain. Arrivals down 30%; guests favour covered rides and warm food.');
    expect(lineFor({ weatherKind: 'hot' })).toBe('Weather: heat. Thirstier guests walk slower; cold drinks and sun hats sell best.');
    // Phase 33: with guest life off there are no sun hats to sell.
    expect(describeWeatherEffects(ui({ weatherKind: 'hot' }), false)).toBe('Weather: heat. Thirstier guests walk slower; cold drinks sell best.');
    expect(lineFor({ weatherKind: 'sunny', arrivalDeltaPercent: 8 })).toBe('Weather: sunny. Arrivals up 8%; cold treats are in demand.');
  });

  it('shows nothing for cloudy, for a weak sunny day and when the weather is off', () => {
    expect(lineFor({ weatherKind: 'cloudy' })).toBeNull();
    expect(lineFor({ weatherKind: 'sunny', arrivalDeltaPercent: GAME_CONFIG.weather.effects.pulseMinArrivalDeltaPercent - 1 })).toBeNull();
    expect(lineFor({ weatherKind: 'sunny', arrivalDeltaPercent: GAME_CONFIG.weather.effects.pulseMinArrivalDeltaPercent })).not.toBeNull();
    expect(lineFor({ weatherEnabled: false, weatherKind: 'storm', stormClosedRides: 4 })).toBeNull();
  });

  it('every line is at most 90 characters for every kind, intensity, count and percentage', () => {
    for (const kind of WEATHER_KINDS) {
      for (const stormClosedRides of [0, 1, 2, 12, 99]) {
        for (const arrivalDeltaPercent of [-100, -65, -5, 0, 8, 40]) {
          const line = lineFor({ weatherKind: kind, stormClosedRides, arrivalDeltaPercent });
          if (line !== null) expect(line.length, line).toBeLessThanOrEqual(90);
        }
      }
    }
  });

  it('the opening hours line shows only while hours hold a manually open gate shut', () => {
    const closed = ui({ hoursEnabled: true, scheduleOpen: false, openHour: 8, parkOpen: true });
    expect(describeScheduleLine(closed)).toBe('Closed by opening hours until 08:00.');
    expect(describeScheduleLine({ ...closed, parkOpen: false })).toBeNull();
    expect(describeScheduleLine({ ...closed, scheduleOpen: true })).toBeNull();
    expect(describeScheduleLine({ ...closed, hoursEnabled: false })).toBeNull();
    expect(scheduleClosedLabel(closed)).toBe('Opens 08:00');
    expect(scheduleClosedLabel({ ...closed, openHour: 6 })).toBe('Opens 06:00');
    expect(scheduleClosedLabel({ ...closed, scheduleOpen: true })).toBeNull();
  });

  it('puts the hours line before the weather line and carries a glyph for each', () => {
    const lines = pulseWeatherLines(ui({ weatherKind: 'rain', arrivalDeltaPercent: -30, hoursEnabled: true, scheduleOpen: false }));
    expect(lines.map((line) => line.text)).toEqual([
      'Closed by opening hours until 08:00.',
      'Weather: rain. Arrivals down 30%; guests favour covered rides and warm food.',
    ]);
    expect(lines[1].glyph).toBe(WEATHER_GLYPHS.rain);
    expect(pulseWeatherLines(ui({ weatherKind: 'cloudy' }))).toEqual([]);
  });
});

describe('biome weather text (Phase 24)', () => {
  const winter = { biomeId: 'winter' as const, climate: 'cold' as const, climateLabel: 'Cold' };

  it('Meadow says exactly what it said before: the base labels, no climate line', () => {
    expect(weatherLabelsFor('meadow')).toBe(WEATHER_LABELS);
    expect(weatherLabelsFor('seaside')).toBe(WEATHER_LABELS);
    expect(DEFAULT_WEATHER_UI).toMatchObject({ biomeId: 'meadow', climate: 'mild', climateLabel: 'Mild' });
    for (const kind of WEATHER_KINDS) {
      expect(pulseWeatherLines(ui({ weatherKind: kind, weatherIntensityPercent: 70, arrivalDeltaPercent: -15 })).map((line) => line.text)
        .filter((text) => /climate/i.test(text))).toEqual([]);
    }
    expect(describeClimateLine(ui())).toBeNull();
    expect(describeClimateLine(ui({ climate: 'mild' }))).toBeNull();
  });

  it('Winter calls rain sleet and storm a blizzard in the chip, the aria label, the forecast and the Pulse', () => {
    expect(weatherLabelsFor('winter')).toMatchObject({ rain: 'Sleet', storm: 'Blizzard', sunny: 'Sunny', cloudy: 'Cloudy' });
    const sleet = ui({ ...winter, weatherKind: 'rain', weatherIntensityPercent: 70, arrivalDeltaPercent: -12, forecastText: ['Now: Sleet 70%', '18:00 Cloudy'] });
    expect(weatherChipLabel(sleet)).toBe('Sleet');
    expect(weatherAriaLabel(sleet)).toBe('Weather: Sleet, 70 percent. Next: 18:00 Cloudy. Forecast and weather settings');
    expect(describeWeatherEffects(sleet)).toBe('Weather: sleet. Arrivals down 12%; guests favour covered rides and warm food.');
    const blizzard = ui({ ...winter, weatherKind: 'storm', arrivalDeltaPercent: -30, stormClosedRides: 0 });
    expect(describeWeatherEffects(blizzard)).toBe('Weather: blizzard. Arrivals down 30%; covered rides draw the crowd.');
    expect(describeWeatherEffects({ ...blizzard, stormClosedRides: 2 })).toBe('Weather: blizzard. 2 open-air rides closed until it passes.');
    const rows = forecastRows({ kind: 'rain', intensity: 0.5 }, [entry(3, 2, 'storm')], 3, weatherLabelsFor('winter'));
    expect(rows).toEqual(['Now: Sleet 50%', '18:00 Blizzard']);
  });

  it('the climate line says how the place plays, in the words of the cold effect, even with the weather off', () => {
    expect(describeClimateLine(ui({ climate: 'cold' }))).toEqual({ glyph: '❄︎', text: 'Cold climate: warm food draws guests; cold drinks sell slowly.' });
    expect(describeClimateLine(ui({ climate: 'cool' }))).toEqual({ glyph: '❄︎', text: 'Cool climate: warm food sells a little better.' });
    expect(describeClimateLine(ui({ climate: 'warm' }))?.text).toBe('Warm climate: cold drinks sell a little better.');
    expect(describeClimateLine(ui({ climate: 'hot' }))).toEqual({ glyph: '♨︎', text: 'Hot climate: guests get thirsty fast; cold drinks sell best.' });
    for (const text of ['Cold', 'Cool', 'Warm', 'Hot'].map((band) => describeClimateLine(ui({ climate: band.toLowerCase() as never }))!.text)) {
      expect(text.length, 'short enough for a Pulse line').toBeLessThan(80);
    }
    // Phase 30 (revising PA-009): the climate line no longer takes a Pulse slot; the clock popover keeps it (climateText).
    const lines = pulseWeatherLines(ui({ ...winter, weatherEnabled: false }));
    expect(lines).toEqual([]);
    expect(climateText(ui({ ...winter, weatherEnabled: false }))).toMatch(/^Climate: Cold/);
  });

  it('a sunny day in a cold or cool place drops the cold-treats clause', () => {
    const sunny = ui({ weatherKind: 'sunny', arrivalDeltaPercent: GAME_CONFIG.weather.effects.pulseMinArrivalDeltaPercent + 2 });
    expect(describeWeatherEffects(sunny)).toMatch(/cold treats are in demand/);
    for (const climate of ['cold', 'cool'] as const) {
      expect(describeWeatherEffects({ ...sunny, climate })).toBe(`Weather: sunny. Arrivals up ${sunny.arrivalDeltaPercent}%.`);
    }
    expect(describeWeatherEffects({ ...sunny, climate: 'hot' })).toMatch(/cold treats are in demand/);
  });

  it('orders the Pulse lines: opening hours, then weather; the climate line stays out of the Pulse (Phase 30)', () => {
    const state = ui({
      ...winter, weatherKind: 'rain', arrivalDeltaPercent: -10, parkOpen: true, hoursEnabled: true, scheduleOpen: false, openHour: 8,
    });
    const lines = pulseWeatherLines(state).map((line) => line.text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Closed by opening hours/);
    expect(lines[1]).toMatch(/^Weather: sleet/);
    expect(lines.some((line) => /climate/i.test(line))).toBe(false);
    // The place still speaks: the popover line is unchanged.
    expect(climateText(state)).toBe('Climate: Cold');
  });

  it('Phase 30: souvenir demand lines follow the guests\' rule (sellingSouvenirs) and weatherUiOf carries it', () => {
    const dry = ui({ sellingSouvenirs: ['balloon', 'plush'] });
    expect(souvenirDemandLine('umbrella', dry)).toBe('Umbrellas sell in the rain · dry now');
    expect(souvenirDemandLine('hat', dry)).toBe('Sun hats sell in the heat · cool now');
    expect(souvenirDemandLine('glowWand', dry)).toBe('Glow wands sell at night · daylight now');
    expect(souvenirDemandLine('balloon', dry)).toBe('Balloons sell all day · selling now');
    expect(souvenirDemandLine('plush', dry)).toBe('Plush toys sell all day · selling now');
    const rainyNight = ui({ sellingSouvenirs: ['umbrella', 'hat', 'balloon', 'plush', 'glowWand'] });
    expect(souvenirDemandLine('umbrella', rainyNight)).toBe('Umbrellas sell in the rain · selling now');
    expect(souvenirDemandLine('hat', rainyNight)).toBe('Sun hats sell in the heat · selling now');
    expect(souvenirDemandLine('glowWand', rainyNight)).toBe('Glow wands sell at night · selling now');
    expect(DEFAULT_WEATHER_UI.sellingSouvenirs).toEqual(['balloon', 'plush']);
    const base = {
      enabled: true, kind: 'rain' as const, intensity: 0.5, severity: 'normal' as const, editable: true, stormClosedRides: 0, parkOpen: true,
      forecast: [], day: 1, hours: { hoursEnabled: false, openHour: 8, closeHour: 22, scheduleOpen: true },
    };
    expect(weatherUiOf(base).sellingSouvenirs, 'absent: the always-selling pair').toEqual(['balloon', 'plush']);
    // Kept in SOUVENIR_KINDS order whatever order the caller passes, and the key changes with it.
    const carried = weatherUiOf({ ...base, sellingSouvenirs: ['glowWand', 'umbrella', 'balloon', 'plush'] });
    expect(carried.sellingSouvenirs).toEqual(['umbrella', 'balloon', 'plush', 'glowWand']);
    expect(weatherUiKey(carried)).not.toBe(weatherUiKey(weatherUiOf(base)));
  });

  it('weatherUiOf carries the biome, uses its words in the forecast and defaults to Meadow', () => {
    const input = {
      enabled: true, kind: 'storm' as const, intensity: 0.5, severity: 'normal' as const, editable: true, stormClosedRides: 0, parkOpen: true,
      forecast: [entry(2, 1, 'rain')], day: 2, hours: { hoursEnabled: false, openHour: 8, closeHour: 20, scheduleOpen: true },
    };
    const meadow = weatherUiOf(input);
    expect(meadow).toMatchObject({ biomeId: 'meadow', climate: 'mild', climateLabel: 'Mild' });
    expect(meadow.forecastText[0]).toBe('Now: Storm 50%');
    const cold = weatherUiOf({ ...input, ...winter });
    expect(cold.forecastText[0]).toBe('Now: Blizzard 50%');
    expect(cold.forecastText[1]).toMatch(/Sleet$/);
    expect(weatherUiKey(cold)).not.toBe(weatherUiKey(meadow));
  });

  it('the popover line names the climate and says it still applies when the weather is off', () => {
    expect(climateText(ui())).toBe('Climate: Mild');
    expect(climateText(ui({ ...winter }))).toBe('Climate: Cold');
    expect(climateText(ui({ ...winter, weatherEnabled: false }))).toBe('Climate: Cold (still applies with the weather off)');
  });
});

/** Phase 33: the Phase 29 guest-life effects of the weather and the night, taught outside the Pulse. */
describe('weather guest lines', () => {
  const rain = ui({ weatherKind: 'rain', sellingSouvenirs: ['umbrella', 'balloon', 'plush'] });
  const heat = ui({ weatherKind: 'hot', sellingSouvenirs: ['hat', 'balloon', 'plush'] });
  const night = ui({ weatherKind: 'cloudy', sellingSouvenirs: ['balloon', 'plush', 'glowWand'] });

  it('rain says guests without umbrellas get soaked and that umbrellas sell', () => {
    expect(weatherGuestLines(rain)).toEqual(['Rain: guests without an umbrella get soaked and unhappy; umbrellas sell.']);
    // The storm rains too, and a biome's own word is used (Winter's rain is sleet).
    expect(weatherGuestLines(ui({ weatherKind: 'storm', sellingSouvenirs: ['umbrella'] }))[0]).toMatch(/^Storm: guests without an umbrella get soaked/);
    expect(weatherGuestLines({ ...rain, biomeId: 'winter' })[0]).toMatch(/^Sleet: /);
  });

  it('heat names sun hats and cold drinks', () => {
    expect(weatherGuestLines(heat)).toEqual(['Hot: guests get hot and thirsty; sun hats and cold drinks sell.']);
  });

  it('night makes guests cold and sells warm drinks and glow wands, read from the souvenirs that sell now', () => {
    expect(weatherGuestLines(night)).toEqual(['Night: guests get cold; warm drinks and glow wands sell.']);
    // A rainy night says both, rain first.
    expect(weatherGuestLines({ ...rain, sellingSouvenirs: ['umbrella', 'balloon', 'plush', 'glowWand'] })).toHaveLength(2);
    // The night is felt with the weather switched off too; the rain is not.
    expect(weatherGuestLines({ ...night, weatherEnabled: false })).toHaveLength(1);
    expect(weatherGuestLines({ ...rain, weatherEnabled: false })).toEqual([]);
  });

  it('says nothing on a plain day or with guest life off', () => {
    expect(weatherGuestLines(ui())).toEqual([]);
    expect(weatherGuestLines(ui({ weatherKind: 'sunny', sellingSouvenirs: ['hat', 'balloon', 'plush'] }))).toEqual([]);
    for (const state of [rain, heat, night]) expect(weatherGuestLines(state, false)).toEqual([]);
  });

  it('follows the forecast in the weather chip tooltip, and never adds a Pulse line', () => {
    expect(weatherTooltip({ ...rain, forecastText: ['Now: Rain 70%'] })).toBe(
      'Weather forecast\nNow: Rain 70%\nRain: guests without an umbrella get soaked and unhappy; umbrellas sell.',
    );
    expect(weatherTooltip({ ...rain, forecastText: ['Now: Rain 70%'] }, false)).toBe('Weather forecast\nNow: Rain 70%');
    expect(pulseWeatherLines({ ...night, arrivalDeltaPercent: 0 })).toEqual([]);
    expect(pulseWeatherLines({ ...rain, arrivalDeltaPercent: -30 })).toHaveLength(1);
  });
});
