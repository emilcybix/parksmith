import { describe, expect, it } from 'vitest';
import { recolourCharge } from '../content/colourCost';
import { GAME_MODES, GAME_MODE_LABELS, colourCostModeOf, isGameMode, legacyModeOf, modeHasCards } from './types';

describe('game modes', () => {
  it('are sandbox, scenario and run, labelled for the player (run is The Map)', () => {
    expect(GAME_MODES).toEqual(['sandbox', 'scenario', 'run']);
    expect(GAME_MODE_LABELS).toEqual({ sandbox: 'Sandbox', scenario: 'Scenario', run: 'The Map' });
  });

  it('isGameMode accepts exactly the three', () => {
    for (const mode of GAME_MODES) expect(isGameMode(mode)).toBe(true);
    for (const value of ['Sandbox', 'map', '', null, undefined, 1, {}, [], '__proto__']) expect(isGameMode(value), String(value)).toBe(false);
  });

  it('legacyModeOf maps old saves by scenarioId only', () => {
    expect(legacyModeOf(null)).toBe('sandbox');
    expect(legacyModeOf('sunny-start')).toBe('scenario');
    expect(legacyModeOf('anything')).toBe('scenario');
  });

  it('only Scenario and The Map have cards', () => {
    expect(GAME_MODES.map(modeHasCards)).toEqual([false, true, true]);
  });

  it('the recolour cost column follows the mode (run -> map) and stays free everywhere by default', () => {
    expect(colourCostModeOf('sandbox')).toBe('sandbox');
    expect(colourCostModeOf('scenario')).toBe('scenario');
    expect(colourCostModeOf('run')).toBe('map');
    for (const mode of GAME_MODES) expect(recolourCharge(colourCostModeOf(mode), 5, 1), mode).toBe(0);
  });
});
