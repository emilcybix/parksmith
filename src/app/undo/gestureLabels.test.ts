import { describe, expect, it } from 'vitest';
import { cardPlayedLabel, demolitionLabel, objectBuiltLabel, pathsBuiltLabel, recolourLabel } from './gestureLabels';

describe('gesture labels', () => {
  it('names built paths and objects', () => {
    expect(pathsBuiltLabel(1)).toBe('1 path tile built');
    expect(pathsBuiltLabel(12)).toBe('12 path tiles built');
    expect(objectBuiltLabel('Ferris Wheel')).toBe('Ferris Wheel built');
  });

  it('names a recolour by the ride', () => {
    expect(recolourLabel('Aurora Wheel')).toBe('Aurora Wheel recoloured');
  });

  it('names a card play by the card (Phase 25)', () => {
    expect(cardPlayedLabel('Coach Party')).toBe('Coach Party played');
  });

  it('names a demolition by what the drag took out', () => {
    expect(demolitionLabel([])).toBe('Demolition');
    expect(demolitionLabel(['Ferris Wheel'])).toBe('Ferris Wheel demolished');
    expect(demolitionLabel(['a path tile'])).toBe('Path tile demolished');
    expect(demolitionLabel(['a path tile', 'a path tile', 'a path tile'])).toBe('3 path tiles demolished');
    expect(demolitionLabel(['a path tile', 'Ferris Wheel'])).toBe('2 things demolished');
    // Phase 24: props cleared for a price.
    expect(demolitionLabel(['Red boulder'], 1)).toBe('Red boulder cleared');
    expect(demolitionLabel(['Saguaro', 'Red boulder'], 2)).toBe('2 obstacles cleared');
    expect(demolitionLabel(['a path tile', 'Red boulder'], 1)).toBe('2 things demolished');
    expect(demolitionLabel(['Red boulder'], 0), 'a demolition that is not a clearing keeps its name').toBe('Red boulder demolished');
  });
});
