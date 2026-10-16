import { describe, expect, it } from 'vitest';
import { resolveKeyAction, setBinding } from './keybindings';

const all = (): boolean => true;

describe('keybindings review (adversarial)', () => {
  // On AZERTY the physical QWERTY-W key types "z". Binding Grid to the letter z is accepted,
  // yet the press also pans (code-based pan matches first) and the grid action never runs.
  it('refuses a letter that types on a pan key position on another layout, or the binding works', () => {
    const bound = setBinding({}, 'toggleGrid', 'k:z');
    if (!bound.ok) return;
    const action = resolveKeyAction({ key: 'z', code: 'KeyW' }, all, bound.overrides);
    expect(action).toBe('toggleGrid');
  });

  // Dvorak: physical KeyD types "e". Binding Grid to "d" (physical KeyE) is flagged as clashing with
  // pan D although it is a different physical key: a false conflict from mixing key/code identities.
  it('does not flag a false conflict between a letter token and a code token on another layout', () => {
    const bound = setBinding({}, 'toggleGrid', 'k:d');
    expect(bound.ok).toBe(true);
  });

  // AZERTY: Shift+& types "1" and used to select 1x speed via event.key; digit tokens no longer match it.
  it.fails('keeps the typed digit working on AZERTY with Shift held', () => {
    expect(resolveKeyAction({ key: '1', code: 'Digit1', shiftKey: true }, all, {})).toBe('speed1');
  });

  it('refuses a typed letter that sits on a pan position, judged from the captured layout', () => {
    // AZERTY: the physical W key types z.
    const bound = setBinding({}, 'toggleGrid', 'k:z', { key: 'z', code: 'KeyW' });
    expect(bound.ok).toBe(false);
    // QWERTY: d on KeyD clashes with pan D; Dvorak: d on KeyE does not.
    expect(setBinding({}, 'toggleGrid', 'k:d', { key: 'd', code: 'KeyD' }).ok).toBe(false);
    expect(setBinding({}, 'toggleGrid', 'k:d', { key: 'd', code: 'KeyE' }).ok).toBe(true);
  });

  it('refuses a position binding whose typed letter is already a letter binding', () => {
    // Pan up on the key that types g clashes with Grid (k:g).
    expect(setBinding({}, 'panUp', 'c:KeyG', { key: 'g', code: 'KeyG' }).ok).toBe(false);
  });
});
