import { describe, expect, it } from 'vitest';
import {
  FIXED_KEYS,
  KEY_ACTIONS,
  KEY_ACTION_BY_ID,
  KEY_GROUP_ORDER,
  ariaKeyShortcutsFor,
  eventCode,
  formatToken,
  helpHintItemsFor,
  keyLabelFor,
  keybindingsEqual,
  matchesAction,
  panCodes,
  parseToken,
  resetBinding,
  resolveKeyAction,
  scopesOverlap,
  setBinding,
  tokenFromEvent,
  validateBinding,
  validateKeybindings,
  withKeyHintFor,
  type ActionId,
  type KeyEventLike,
  type KeyScope,
} from './keybindings';

const ev = (key: string, extra: Partial<KeyEventLike> = {}): KeyEventLike => ({ key, ...extra });
const allScopes = (): boolean => true;
const scopes = (...active: KeyScope[]) => (scope: KeyScope): boolean => active.includes(scope);
const WORLD = scopes('view', 'build', 'build-not-designer');
const DESIGNER = scopes('view', 'build', 'designer');
const VIEW_ONLY = scopes('view');
const action = (event: KeyEventLike, scope = WORLD, overrides = {}): ActionId | null => resolveKeyAction(event, scope, overrides);

describe('registry', () => {
  it('lists every action once, every default parses, and every group is known', () => {
    const ids = KEY_ACTIONS.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(25);
    for (const def of KEY_ACTIONS) {
      expect(parseToken(def.defaultKey), def.id).not.toBeNull();
      expect(KEY_GROUP_ORDER).toContain(def.group);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(KEY_ACTION_BY_ID.get(def.id)).toBe(def);
    }
  });

  it('is listed in group order', () => {
    const order = KEY_ACTIONS.map((def) => KEY_GROUP_ORDER.indexOf(def.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('reproduces the shipped defaults', () => {
    const defaults = Object.fromEntries(KEY_ACTIONS.map((def) => [def.id, def.defaultKey]));
    expect(defaults).toEqual({
      toggleGrid: 'k:g', toggleCleanView: 'k:h', rotateViewLeft: 'k:q', rotateViewRight: 'k:e', recentreView: 'k:v', peek: 'k:x', toggleCrowdHeatmap: 'k:t', toggleMute: 'k:m',
      speedPause: 'c:Digit0', speed1: 'c:Digit1', speed2: 'c:Digit2', speed4: 'c:Digit4',
      bulldozer: 'k:b', pathTool: 'k:p', paintTool: 'k:c', eyedropper: 'k:i', landTool: 'k:l', rotate: 'k:r', coasterRaise: 'k:r', coasterLower: 'k:f', coasterToggleLift: 'k:l',
      panLeft: 'c:KeyA', panRight: 'c:KeyD', panUp: 'c:KeyW', panDown: 'c:KeyS',
    });
  });

  it('has a conflict-free default set (R is shared only between rotate and the designer)', () => {
    for (const a of KEY_ACTIONS) {
      for (const b of KEY_ACTIONS) {
        if (a.id >= b.id || a.defaultKey !== b.defaultKey) continue;
        expect(scopesOverlap(a.scope, b.scope), `${a.id} vs ${b.id}`).toBe(false);
      }
    }
  });

  it('documents the fixed keys, Esc first', () => {
    expect(FIXED_KEYS[0].keys).toBe('Esc');
    expect(FIXED_KEYS.some((fixed) => fixed.keys.includes('Ctrl+S'))).toBe(true);
    // Phase 11 (PA-015): Delete and Backspace are reserved for widgets, so the inspector's demolish key is fixed.
    const demolish = FIXED_KEYS.find((fixed) => fixed.keys === 'Delete / Backspace');
    expect(demolish?.label).toBe('Demolish');
    expect(demolish?.context).toBe('With a ride or stall inspector open');
    for (const fixed of FIXED_KEYS) expect(fixed.description.length).toBeGreaterThan(10);
  });
});

describe('resolving presses with the defaults', () => {
  it('maps every shipped shortcut', () => {
    expect(action(ev('g'))).toBe('toggleGrid');
    expect(action(ev('G', { shiftKey: true }))).toBe('toggleGrid');
    expect(action(ev('h'))).toBe('toggleCleanView');
    expect(action(ev('0'))).toBe('speedPause');
    expect(action(ev('1'))).toBe('speed1');
    expect(action(ev('2'))).toBe('speed2');
    expect(action(ev('4'))).toBe('speed4');
    expect(action(ev('b'))).toBe('bulldozer');
    expect(action(ev('p'))).toBe('pathTool');
    expect(action(ev('r'))).toBe('rotate');
    expect(action(ev('x'))).toBe('peek');
    expect(action(ev('3'))).toBeNull();
  });

  it('R and F belong to the designer there, and the tool keys do not', () => {
    expect(action(ev('r'), DESIGNER)).toBe('coasterRaise');
    expect(action(ev('f'), DESIGNER)).toBe('coasterLower');
    expect(action(ev('l'), DESIGNER)).toBe('coasterToggleLift');
    expect(action(ev('b'), DESIGNER)).toBeNull();
    expect(action(ev('p'), DESIGNER)).toBeNull();
    expect(action(ev('f'))).toBeNull();
  });

  it('view-only contexts keep the view keys and lose the build keys', () => {
    expect(action(ev('g'), VIEW_ONLY)).toBe('toggleGrid');
    expect(action(ev('b'), VIEW_ONLY)).toBeNull();
    expect(action(ev('x'), VIEW_ONLY)).toBeNull();
  });

  it('never fires with Ctrl, Cmd or Alt, while composing, or for unreadable keys', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) expect(action(ev('g', { [mod]: true }))).toBeNull();
    expect(action(ev('g', { isComposing: true }))).toBeNull();
    for (const key of ['Process', 'Dead', 'Unidentified']) expect(action(ev(key, { code: 'KeyG' }))).toBeNull();
  });

  it('matches digits by physical key: AZERTY and the numpad', () => {
    expect(action(ev('&', { code: 'Digit1' }))).toBe('speed1');
    expect(action(ev('1', { code: 'Numpad1' }))).toBe('speed1');
    expect(action(ev('0', { code: 'Numpad0' }))).toBe('speedPause');
    // Shift+1 types "!" and is not the speed key.
    expect(action(ev('!', { code: 'Digit1', shiftKey: true }))).toBeNull();
  });

  it('matches letters by character: Dvorak types g on the physical KeyI', () => {
    expect(action(ev('g', { code: 'KeyI' }))).toBe('toggleGrid');
    expect(action(ev('z', { code: 'KeyG' }))).toBeNull();
    // The paint keys are letters too: Dvorak's c sits on the physical KeyJ.
    expect(action(ev('c', { code: 'KeyJ' }))).toBe('paintTool');
    expect(action(ev('j', { code: 'KeyC' }))).toBeNull();
  });

  it('matches pan by physical key and always accepts the arrows', () => {
    expect(resolveKeyAction(ev('z', { code: 'KeyW' }), allScopes, {})).toBe('panUp');
    expect(resolveKeyAction(ev('ArrowLeft', { code: 'ArrowLeft' }), allScopes, {})).toBe('panLeft');
    expect(resolveKeyAction(ev('w', { code: 'KeyZ' }), allScopes, {})).toBeNull();
  });
});

describe('overrides', () => {
  it('a rebound key works and the old key stops', () => {
    const overrides = { toggleGrid: 'k:j' };
    expect(action(ev('j'), WORLD, overrides)).toBe('toggleGrid');
    expect(action(ev('g'), WORLD, overrides)).toBeNull();
  });

  it('an unbound action does nothing', () => {
    expect(action(ev('g'), WORLD, { toggleGrid: null })).toBeNull();
  });

  it('a Shift binding is distinct from the plain key', () => {
    const overrides = { toggleGrid: 'shift+k:g', toggleCleanView: 'k:g' };
    expect(action(ev('G', { shiftKey: true }), WORLD, overrides)).toBe('toggleGrid');
    expect(action(ev('g'), WORLD, overrides)).toBe('toggleCleanView');
  });

  it('peek: press and release follow the binding, release ignores modifiers and Shift', () => {
    const overrides = { peek: 'k:v' };
    expect(matchesAction('peek', ev('v'), overrides)).toBe(true);
    expect(matchesAction('peek', ev('x'), overrides)).toBe(false);
    expect(matchesAction('peek', ev('V', { shiftKey: true, ctrlKey: true }), overrides, 'release')).toBe(true);
    expect(matchesAction('peek', ev('v', { ctrlKey: true }), overrides, 'press')).toBe(false);
  });

  it('pan codes include the effective binding and the arrows', () => {
    expect(panCodes({})).toEqual({
      left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'],
    });
    expect(panCodes({ panUp: 'c:KeyZ', panLeft: null }).up).toEqual(['KeyZ', 'ArrowUp']);
    expect(panCodes({ panLeft: null }).left).toEqual(['ArrowLeft']);
  });

  it('derives a code from the key when a synthetic event has none', () => {
    expect(eventCode(ev('A'))).toBe('KeyA');
    expect(eventCode(ev('7'))).toBe('Digit7');
    expect(eventCode(ev('ARROWRIGHT'))).toBe('ArrowRight');
    expect(eventCode(ev(' '))).toBe('Space');
    expect(eventCode(ev('x', { code: 'Numpad3' }))).toBe('Digit3');
  });
});

describe('capture', () => {
  const grid = KEY_ACTION_BY_ID.get('toggleGrid')!;
  const pan = KEY_ACTION_BY_ID.get('panUp')!;
  const refusal = (event: KeyEventLike, def = grid) => {
    const result = tokenFromEvent(event, def);
    return result.ok ? null : result.refusal;
  };

  it('turns letters into character tokens and everything else into code tokens', () => {
    expect(tokenFromEvent(ev('J', { code: 'KeyJ' }), grid)).toEqual({ ok: true, token: 'k:j' });
    expect(tokenFromEvent(ev('J', { code: 'KeyJ', shiftKey: true }), grid)).toEqual({ ok: true, token: 'shift+k:j' });
    expect(tokenFromEvent(ev('&', { code: 'Digit1' }), grid)).toEqual({ ok: true, token: 'c:Digit1' });
    expect(tokenFromEvent(ev('5', { code: 'Numpad5' }), grid)).toEqual({ ok: true, token: 'c:Digit5' });
    expect(tokenFromEvent(ev('/', { code: 'Slash' }), grid)).toEqual({ ok: true, token: 'c:Slash' });
    // A Cyrillic keycap is not an ASCII letter: it binds the physical key.
    expect(tokenFromEvent(ev('п', { code: 'KeyG' }), grid)).toEqual({ ok: true, token: 'k:g'.replace('k:g', 'c:KeyG') });
  });

  it('pan actions always bind the physical key and refuse Shift', () => {
    expect(tokenFromEvent(ev('z', { code: 'KeyW' }), pan)).toEqual({ ok: true, token: 'c:KeyW' });
    expect((refusal(ev('W', { code: 'KeyW', shiftKey: true }), pan) as { reason: string }).reason).toBe('invalid');
  });

  it('ignores bare modifiers and refuses reserved keys with a message', () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta']) expect(refusal(ev(key))).toBe('ignore');
    for (const [key, code] of [['Escape', 'Escape'], ['Tab', 'Tab'], ['Enter', 'Enter'], [' ', 'Space'], ['Backspace', 'Backspace'], ['Delete', 'Delete'], ['ArrowUp', 'ArrowUp'], ['Home', 'Home'], ['PageDown', 'PageDown'], ['F5', 'F5'], ['CapsLock', 'CapsLock']]) {
      const r = refusal(ev(key, { code }));
      expect(r, key).not.toBeNull();
      expect(r).not.toBe('ignore');
      expect((r as { reason: string }).reason).toBe('reserved');
      expect((r as { message: string }).message.length).toBeGreaterThan(10);
    }
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      expect((refusal(ev('w', { code: 'KeyW', [mod]: true })) as { reason: string }).reason).toBe('reserved');
    }
    expect((refusal(ev('Dead', { code: 'KeyE' })) as { reason: string }).reason).toBe('invalid');
    expect((refusal(ev('+', { code: 'NumpadAdd' })) as { reason: string }).reason).toBe('invalid');
  });
});

describe('validation and conflicts', () => {
  it('refuses a key another overlapping action uses, naming it', () => {
    const result = validateBinding('toggleGrid', 'k:h', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toMatchObject({ reason: 'conflict', with: 'toggleCleanView' });
      expect(result.refusal.message).toBe('H is already used by Clean view. Pick another key or reset that one first.');
    }
  });

  it('treats a letter token and the same physical letter token as the same key, and numpad as digits', () => {
    expect(validateBinding('toggleGrid', 'c:KeyW', {}).ok).toBe(false); // pan up
    expect(validateBinding('panUp', 'k:g', {}).ok).toBe(false); // grid
    expect(validateBinding('toggleGrid', 'c:Digit1', {}).ok).toBe(false);
  });

  it('allows R in the designer and for rotate, but not R against G', () => {
    expect(validateBinding('coasterRaise', 'k:r', {}).ok).toBe(true);
    expect(validateBinding('rotate', 'k:g', {}).ok).toBe(false);
    expect(validateBinding('coasterLower', 'k:b', {}).ok).toBe(true);
    // Overlapping scopes: peek (build) and rotate (build-not-designer) share the build set.
    expect(validateBinding('peek', 'k:r', {}).ok).toBe(false);
  });

  it('a freed key can be taken, and the old holder is not auto-swapped', () => {
    const first = setBinding({}, 'toggleCleanView', 'k:j');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = setBinding(first.overrides, 'toggleGrid', 'k:h');
    expect(second.ok).toBe(true);
  });

  it('refuses reserved and malformed tokens', () => {
    for (const token of ['c:Escape', 'c:Tab', 'c:Space', 'c:ArrowUp', 'k:G', 'k:gg', 'x:g', 'shift+c:F5', '', 'g']) {
      expect(validateBinding('toggleGrid', token, {}).ok, token).toBe(false);
    }
    expect(validateBinding('panUp', 'shift+c:KeyQ', {}).ok).toBe(false);
  });

  it('setBinding returns a new object, drops entries equal to the default, and null unbinds', () => {
    const base = {};
    const set = setBinding(base, 'toggleGrid', 'k:j');
    expect(set).toEqual({ ok: true, overrides: { toggleGrid: 'k:j' } });
    expect(base).toEqual({});
    if (!set.ok) return;
    expect(setBinding(set.overrides, 'toggleGrid', 'k:g')).toEqual({ ok: true, overrides: {} });
    expect(setBinding(set.overrides, 'toggleGrid', null)).toEqual({ ok: true, overrides: { toggleGrid: null } });
    expect(resetBinding(set.overrides, 'toggleGrid')).toEqual({});
  });
});

describe('validateKeybindings', () => {
  it('drops unknown ids, wrong types, bad and reserved tokens, keeps null', () => {
    expect(validateKeybindings({
      nope: 'k:q', toggleGrid: 5, toggleCleanView: 'c:Escape', speed1: 'bogus', peek: null, bulldozer: 'k:j',
    })).toEqual({ peek: null, bulldozer: 'k:j' });
  });

  it('is never fooled by non-objects', () => {
    for (const raw of [null, undefined, 5, 'x', [], true]) expect(validateKeybindings(raw)).toEqual({});
  });

  it('drops the clashing entry, so the loaded set is conflict-free', () => {
    const result = validateKeybindings({ bulldozer: 'k:j', pathTool: 'k:j' });
    expect(result).toEqual({ bulldozer: 'k:j' });
  });

  it('keeps a legitimate swap of two keys', () => {
    expect(validateKeybindings({ toggleGrid: 'k:h', toggleCleanView: 'k:g' })).toEqual({ toggleGrid: 'k:h', toggleCleanView: 'k:g' });
  });

  it('drops an entry whose partner reverted to its default key', () => {
    // Clean view moves to a reserved key (dropped, back on H), so grid = H would clash.
    expect(validateKeybindings({ toggleGrid: 'k:h', toggleCleanView: 'c:Tab' })).toEqual({});
  });

  it('ignores entries equal to their default', () => {
    expect(validateKeybindings({ toggleGrid: 'k:g' })).toEqual({});
  });

  it('compares overrides entry by entry', () => {
    expect(keybindingsEqual({}, {})).toBe(true);
    expect(keybindingsEqual({ toggleGrid: 'k:j' }, { toggleGrid: 'k:j' })).toBe(true);
    expect(keybindingsEqual({ toggleGrid: 'k:j' }, {})).toBe(false);
    expect(keybindingsEqual({ toggleGrid: null }, {})).toBe(false);
  });
});

describe('labels', () => {
  it('formats tokens', () => {
    expect(formatToken('k:g')).toBe('G');
    expect(formatToken('shift+k:g')).toBe('Shift+G');
    expect(formatToken('c:Digit1')).toBe('1');
    expect(formatToken('c:KeyW')).toBe('W');
    expect(formatToken('c:Slash')).toBe('/');
    expect(formatToken('c:ArrowUp')).toBe('Up arrow');
    expect(formatToken(null)).toBe('—');
  });

  it('builds tooltips that follow a rebind and drop the hint when unbound', () => {
    expect(withKeyHintFor('Toggle grid', 'toggleGrid', {})).toBe('Toggle grid (G)');
    expect(withKeyHintFor('Toggle grid', 'toggleGrid', { toggleGrid: 'shift+k:j' })).toBe('Toggle grid (Shift+J)');
    expect(withKeyHintFor('Toggle grid', 'toggleGrid', { toggleGrid: null })).toBe('Toggle grid');
    expect(keyLabelFor('speed4', {})).toBe('4');
  });

  it('builds aria-keyshortcuts', () => {
    expect(ariaKeyShortcutsFor('toggleGrid', {})).toBe('g');
    expect(ariaKeyShortcutsFor('toggleGrid', { toggleGrid: 'shift+k:j' })).toBe('Shift+j');
    expect(ariaKeyShortcutsFor('toggleGrid', { toggleGrid: null })).toBeUndefined();
  });

  it('derives the help hint, reproducing the shipped text by default', () => {
    expect(helpHintItemsFor({})).toEqual([
      'Drag to build', 'R to rotate', 'Hold X to see through', 'Wheel to zoom', 'Middle-drag · WASD to pan', 'Esc to put the tool down',
    ]);
    expect(helpHintItemsFor({ rotate: 'k:t', peek: null })).toContain('T to rotate');
    expect(helpHintItemsFor({ peek: null }).some((item) => item.includes('see through'))).toBe(false);
    expect(helpHintItemsFor({ panUp: 'c:KeyZ' })).toContain('Middle-drag · ZASD to pan');
    expect(helpHintItemsFor({ panUp: null })).toContain('Middle-drag · Arrow keys to pan');
  });
});
