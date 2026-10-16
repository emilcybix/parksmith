import { describe, expect, it } from 'vitest';
import { parseStartMenuFlag, START_MENU_DEFAULT } from './menuFlag';

describe('start menu flag', () => {
  it('is on unless &menu=0 (also false and off), and ?dev=1 does not change it', () => {
    expect(parseStartMenuFlag('')).toBe(true);
    expect(parseStartMenuFlag('?dev=1')).toBe(true);
    expect(parseStartMenuFlag('?dev=1&menu=1')).toBe(true);
    expect(parseStartMenuFlag('?menu=0')).toBe(false);
    expect(parseStartMenuFlag('?dev=1&menu=0')).toBe(false);
    expect(parseStartMenuFlag('?menu=false')).toBe(false);
    expect(parseStartMenuFlag('?menu=off')).toBe(false);
  });

  it('defaults to off outside a browser, so tests that do not ask for the menu are not behind one', () => {
    expect(START_MENU_DEFAULT).toBe(false);
  });
});
