import { describe, expect, it } from 'vitest';
import { KEY_ACTIONS, type KeyEventLike } from '../settings/keybindings';
import {
  captureStep,
  customBindingCount,
  fixedKeys,
  isCapturing,
  keyboardGroups,
  type CaptureState,
} from './keyboardSettingsModel';

const key = (k: string, extra: Partial<KeyEventLike> = {}): { type: 'key'; event: KeyEventLike } => ({ type: 'key', event: { key: k, ...extra } });
const capturing = (id: 'toggleGrid' | 'panUp' = 'toggleGrid'): CaptureState => ({ mode: 'capturing', id });

describe('keyboardGroups', () => {
  it('lists every action exactly once, grouped, with headings', () => {
    const groups = keyboardGroups({});
    expect(groups.map((group) => group.title)).toEqual(['Camera', 'Speed', 'View', 'Sound', 'Tools', 'Coaster designer']);
    expect(groups.flatMap((group) => group.rows.map((row) => row.id)).sort()).toEqual(KEY_ACTIONS.map((def) => def.id).sort());
  });

  it('shows defaults, marks overrides and unbound keys, and flags physical letters', () => {
    const rows = Object.fromEntries(keyboardGroups({ toggleGrid: 'shift+k:j', peek: null }).flatMap((group) => group.rows).map((row) => [row.id, row]));
    expect(rows.speed1).toMatchObject({ keyText: '1', isDefault: true, bound: true, physical: false });
    expect(rows.toggleGrid).toMatchObject({ keyText: 'Shift+J', isDefault: false, defaultText: 'G' });
    expect(rows.peek).toMatchObject({ keyText: '—', bound: false, isDefault: false });
    expect(rows.panUp).toMatchObject({ keyText: 'W', physical: true });
  });

  it('notes that arrows always pan, and lists the fixed keys including Esc', () => {
    expect(keyboardGroups({})[0].note).toContain('Arrow keys');
    expect(fixedKeys()[0].keys).toBe('Esc');
  });
});

describe('captureStep', () => {
  it('start enters capture and says how to leave it', () => {
    const out = captureStep({ mode: 'idle' }, { type: 'start', id: 'toggleGrid' }, {});
    expect(out.state).toEqual(capturing());
    expect(out.status).toBe('Press a key for Toggle grid. Esc cancels.');
    expect(isCapturing(out.state)).toBe(true);
  });

  it('a valid key commits, returns to idle and reports the change', () => {
    const out = captureStep(capturing(), key('j', { code: 'KeyJ' }), {});
    expect(out).toMatchObject({ state: { mode: 'idle' }, overrides: { toggleGrid: 'k:j' }, changed: true, status: 'Toggle grid is now J.' });
  });

  it('Shift is part of the binding', () => {
    expect(captureStep(capturing(), key('J', { code: 'KeyJ', shiftKey: true }), {}).overrides).toEqual({ toggleGrid: 'shift+k:j' });
  });

  it('Esc cancels and changes nothing', () => {
    const out = captureStep(capturing(), key('Escape', { code: 'Escape' }), { toggleGrid: 'k:j' });
    expect(out).toMatchObject({ state: { mode: 'idle' }, overrides: { toggleGrid: 'k:j' }, changed: false });
    expect(out.status).toBe('Cancelled. Toggle grid is still J.');
  });

  it('a conflict keeps capturing and names the other action', () => {
    const out = captureStep(capturing(), key('h', { code: 'KeyH' }), {});
    expect(out.changed).toBe(false);
    expect(out.state).toEqual({ mode: 'refused', id: 'toggleGrid', message: 'H is already used by Clean view. Pick another key or reset that one first.' });
    expect(out.status).toBe('H is already used by Clean view. Pick another key or reset that one first.');
    // Still capturing: the next key can succeed.
    expect(isCapturing(out.state)).toBe(true);
    expect(captureStep(out.state, key('j', { code: 'KeyJ' }), {}).changed).toBe(true);
  });

  it('reserved keys are refused with a message and capture stays open', () => {
    for (const [k, code] of [['Tab', 'Tab'], ['Enter', 'Enter'], [' ', 'Space'], ['ArrowUp', 'ArrowUp']]) {
      const out = captureStep(capturing(), key(k, { code }), {});
      expect(out.state.mode, k).toBe('refused');
      expect(out.changed).toBe(false);
    }
    const ctrl = captureStep(capturing(), key('s', { code: 'KeyS', ctrlKey: true }), {});
    expect(ctrl.status).toContain('browser');
  });

  it('a bare modifier is ignored without any message', () => {
    const out = captureStep(capturing(), key('Shift', { code: 'ShiftLeft', shiftKey: true }), {});
    expect(out).toMatchObject({ state: capturing(), status: null, changed: false });
  });

  it('camera keys capture the physical key', () => {
    const out = captureStep(capturing('panUp'), key('z', { code: 'KeyW' }), {});
    // KeyW is the default for panUp: no override is stored.
    expect(out.overrides).toEqual({});
    const moved = captureStep(capturing('panUp'), key('n', { code: 'KeyN' }), {});
    expect(moved.overrides).toEqual({ panUp: 'c:KeyN' });
  });

  it('keys while idle do nothing', () => {
    expect(captureStep({ mode: 'idle' }, key('j'), {})).toMatchObject({ changed: false, status: null });
    expect(captureStep({ mode: 'idle' }, { type: 'cancel' }, {}).status).toBeNull();
  });

  it('clear unbinds, reset restores, and a reset that now clashes is refused', () => {
    const cleared = captureStep({ mode: 'idle' }, { type: 'clear', id: 'toggleGrid' }, {});
    expect(cleared).toMatchObject({ overrides: { toggleGrid: null }, changed: true, status: 'Toggle grid has no key now.' });
    const reset = captureStep({ mode: 'idle' }, { type: 'reset', id: 'toggleGrid' }, cleared.overrides);
    expect(reset).toMatchObject({ overrides: {}, changed: true, status: 'Toggle grid is back to G.' });
    // Clean view took G, so the grid cannot go back to it.
    const clash = captureStep({ mode: 'idle' }, { type: 'reset', id: 'toggleGrid' }, { toggleGrid: 'k:j', toggleCleanView: 'k:g' });
    expect(clash.changed).toBe(false);
    expect(clash.status).toContain('already used by Clean view');
  });

  it('reset all clears everything and counts, or says nothing changed', () => {
    const overrides = { toggleGrid: 'k:j', peek: null };
    expect(customBindingCount(overrides)).toBe(2);
    const out = captureStep({ mode: 'idle' }, { type: 'resetAll' }, overrides);
    expect(out).toMatchObject({ overrides: {}, changed: true });
    expect(out.status).toContain('2 changed back');
    expect(captureStep({ mode: 'idle' }, { type: 'resetAll' }, {})).toMatchObject({ changed: false });
  });
});
