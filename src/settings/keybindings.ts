/**
 * The keyboard shortcut registry: the ONE list of every rebindable game shortcut, plus the pure
 * rules around it (token grammar, matching, capture, validation, labels, the generated doc).
 *
 * Pure: no DOM, no store, no import from `src/ui` (schema.ts imports this file). The input-context
 * table lives in src/ui/inputContext.ts, so the scopes here are a local vocabulary that a test in
 * inputContext.test.ts keeps in step with the real capability table.
 *
 * Layout independence, decided and justified:
 * - Letters match on `event.key` (lowercased). The keycap the player reads in the help hint is the
 *   letter that must work, whatever their layout (AZERTY, Dvorak, QWERTZ).
 * - Digits, punctuation and every key that is not a plain ASCII letter match on `event.code`. On
 *   AZERTY the unshifted digit row types `& e " '`, so `event.key === '1'` is unreachable.
 * - Camera pan (WASD) is `code` based for every layout, so AZERTY players keep the physical WASD
 *   cluster (their ZQSD) and Dvorak players do not lose it.
 * - Shift: tokens match Shift exactly first; letter tokens without `shift+` also match with Shift
 *   held when nothing else claimed the press (Shift+G has always toggled the grid).
 * - Ctrl, Cmd and Alt are never game bindings: those belong to the browser and the OS.
 */

export type KeyScope = 'view' | 'build' | 'build-not-designer' | 'designer';

/**
 * Whether two scopes can be active at the same time, so the same key in both would be ambiguous.
 * Only the coaster designer and "build, but not the designer" exclude each other.
 */
export const scopesOverlap = (a: KeyScope, b: KeyScope): boolean => (
  !((a === 'designer' && b === 'build-not-designer') || (a === 'build-not-designer' && b === 'designer'))
);

export type KeyGroup = 'camera' | 'speed' | 'view' | 'sound' | 'tools' | 'designer';

export type ActionId =
  | 'toggleGrid' | 'toggleCleanView' | 'peek' | 'rotateViewLeft' | 'rotateViewRight' | 'recentreView'
  | 'toggleCrowdHeatmap' | 'toggleMute' | 'staffWindow' | 'buildingsWindow'
  | 'toggleBuildMenu' | 'togglePulse' | 'openFinances' | 'openResearch'
  | 'speedPause' | 'speed1' | 'speed2' | 'speed4'
  | 'bulldozer' | 'pathTool' | 'rotate' | 'paintTool' | 'eyedropper' | 'landTool'
  | 'coasterRaise' | 'coasterLower' | 'coasterToggleLift'
  | 'panLeft' | 'panRight' | 'panUp' | 'panDown';

/** `[shift+](k|c):<value>`; `k:` = a lowercase letter matched on event.key, `c:` = an event.code. */
export type KeyToken = string;

/** Sparse overrides: only what differs from the defaults. `null` = deliberately unbound. */
export type KeybindingOverrides = Readonly<Partial<Record<ActionId, KeyToken | null>>>;

export interface KeyActionDef {
  id: ActionId;
  /** "Toggle grid" */
  label: string;
  /** One sentence for the doc and the settings panel. */
  description: string;
  group: KeyGroup;
  scope: KeyScope;
  defaultKey: KeyToken;
  /** 'code' = physical key (pan); 'auto' = letters by character, everything else by code. */
  match: 'auto' | 'code';
  /** Press and release semantics (peek). */
  hold?: boolean;
  /** Always-on extra keys that cannot be rebound (the pan arrows). */
  fixedAliases?: readonly KeyToken[];
  /**
   * A default added after players could already store bindings (Phase 26's Q/E). When a stored
   * binding of another action sits on this default key, the player's binding wins on load and this
   * action loads unbound (null) instead of the older binding being dropped.
   */
  yieldsDefault?: boolean;
}

export const KEY_GROUP_ORDER: readonly KeyGroup[] = ['camera', 'speed', 'view', 'sound', 'tools', 'designer'];

export const KEY_GROUP_TITLES: Readonly<Record<KeyGroup, string>> = {
  camera: 'Camera',
  speed: 'Speed',
  view: 'View',
  sound: 'Sound',
  tools: 'Tools',
  designer: 'Coaster designer',
};

/** Listed in panel and doc order (grouped by KEY_GROUP_ORDER). */
export const KEY_ACTIONS: readonly KeyActionDef[] = [
  { id: 'panUp', label: 'Pan up', description: 'Move the camera up.', group: 'camera', scope: 'view', defaultKey: 'c:KeyW', match: 'code', fixedAliases: ['c:ArrowUp'] },
  { id: 'panLeft', label: 'Pan left', description: 'Move the camera left.', group: 'camera', scope: 'view', defaultKey: 'c:KeyA', match: 'code', fixedAliases: ['c:ArrowLeft'] },
  { id: 'panDown', label: 'Pan down', description: 'Move the camera down.', group: 'camera', scope: 'view', defaultKey: 'c:KeyS', match: 'code', fixedAliases: ['c:ArrowDown'] },
  { id: 'panRight', label: 'Pan right', description: 'Move the camera right.', group: 'camera', scope: 'view', defaultKey: 'c:KeyD', match: 'code', fixedAliases: ['c:ArrowRight'] },
  { id: 'speedPause', label: 'Pause', description: 'Pause the simulation.', group: 'speed', scope: 'view', defaultKey: 'c:Digit0', match: 'auto' },
  { id: 'speed1', label: 'Normal speed', description: 'Run the simulation at 1x.', group: 'speed', scope: 'view', defaultKey: 'c:Digit1', match: 'auto' },
  { id: 'speed2', label: 'Double speed', description: 'Run the simulation at 2x.', group: 'speed', scope: 'view', defaultKey: 'c:Digit2', match: 'auto' },
  { id: 'speed4', label: 'Fast forward', description: 'Run the simulation at 4x.', group: 'speed', scope: 'view', defaultKey: 'c:Digit4', match: 'auto' },
  { id: 'toggleGrid', label: 'Toggle grid', description: 'Show or hide the tile grid.', group: 'view', scope: 'view', defaultKey: 'k:g', match: 'auto' },
  { id: 'toggleCleanView', label: 'Clean view', description: 'Hide or show the menus to look at the park.', group: 'view', scope: 'view', defaultKey: 'k:h', match: 'auto' },
  { id: 'rotateViewLeft', label: 'Rotate view left', description: 'Turn the whole map a quarter turn counter-clockwise.', group: 'view', scope: 'view', defaultKey: 'k:q', match: 'auto', yieldsDefault: true },
  { id: 'rotateViewRight', label: 'Rotate view right', description: 'Turn the whole map a quarter turn clockwise.', group: 'view', scope: 'view', defaultKey: 'k:e', match: 'auto', yieldsDefault: true },
  { id: 'recentreView', label: 'Recentre view', description: 'Move the camera back to the park entrance.', group: 'view', scope: 'view', defaultKey: 'k:v', match: 'auto', yieldsDefault: true },
  // Phase 35: the rail's crowd flow toggle (voxel only; the classic renderer says why, as the button does).
  { id: 'toggleCrowdHeatmap', label: 'Crowd heatmap', description: 'Show or hide the crowd flow heatmap (the same as the ≋ button).', group: 'view', scope: 'view', defaultKey: 'k:t', match: 'auto', yieldsDefault: true },
  { id: 'staffWindow', label: 'Staff window', description: 'Open or close the Staff window: every worker, hiring and training.', group: 'view', scope: 'view', defaultKey: 'k:k', match: 'auto', yieldsDefault: true },
  { id: 'buildingsWindow', label: 'Buildings window', description: 'Open or close the Buildings window: every building, with filters, search and bulk actions.', group: 'view', scope: 'view', defaultKey: 'k:o', match: 'auto', yieldsDefault: true },
  { id: 'toggleBuildMenu', label: 'Build menu', description: 'Open or close the build menu above the menu bar.', group: 'view', scope: 'view', defaultKey: 'shift+k:b', match: 'auto', yieldsDefault: true },
  { id: 'togglePulse', label: 'Park Pulse', description: 'Show or hide the Park Pulse card.', group: 'view', scope: 'view', defaultKey: 'shift+k:p', match: 'auto', yieldsDefault: true },
  { id: 'openFinances', label: 'Finances', description: 'Open or close the Finances tab of the management dashboard.', group: 'view', scope: 'view', defaultKey: 'shift+k:f', match: 'auto', yieldsDefault: true },
  { id: 'openResearch', label: 'Research', description: 'Open or close the Research tab of the management dashboard.', group: 'view', scope: 'view', defaultKey: 'shift+k:r', match: 'auto', yieldsDefault: true },
  { id: 'peek', label: 'See through', description: 'Hold to see through buildings and scenery near the cursor.', group: 'view', scope: 'build', defaultKey: 'k:x', match: 'auto', hold: true },
  // Phase 35: master mute. Muting sets the Master volume to 0 and unmuting brings the level back, so the Sound slider
  // always shows the truth and the choice survives a reload without a new settings field.
  { id: 'toggleMute', label: 'Mute sound', description: 'Mute or unmute all sound (sets the Master volume to 0 and back).', group: 'sound', scope: 'view', defaultKey: 'k:m', match: 'auto', yieldsDefault: true },
  { id: 'bulldozer', label: 'Bulldozer', description: 'Arm the bulldozer.', group: 'tools', scope: 'build-not-designer', defaultKey: 'k:b', match: 'auto' },
  { id: 'pathTool', label: 'Path tool', description: 'Arm the path tool.', group: 'tools', scope: 'build-not-designer', defaultKey: 'k:p', match: 'auto' },
  { id: 'paintTool', label: 'Paint tool', description: 'Arm the paint tool: click or drag to recolour buildings (Shift paints every part).', group: 'tools', scope: 'build-not-designer', defaultKey: 'k:c', match: 'auto', yieldsDefault: true },
  { id: 'eyedropper', label: 'Colour picker', description: 'Arm the paint tool in pick mode: click a building to copy its colours into the paint brush.', group: 'tools', scope: 'build-not-designer', defaultKey: 'k:i', match: 'auto', yieldsDefault: true },
  { id: 'landTool', label: 'Land tool', description: 'Arm the land tool: click a parcel next to your land to buy it (estates only).', group: 'tools', scope: 'build-not-designer', defaultKey: 'k:l', match: 'auto', yieldsDefault: true },
  { id: 'rotate', label: 'Rotate building', description: 'Rotate the selected building.', group: 'tools', scope: 'build-not-designer', defaultKey: 'k:r', match: 'auto' },
  { id: 'coasterRaise', label: 'Raise track height', description: 'Raise the height the next coaster pieces climb to.', group: 'designer', scope: 'designer', defaultKey: 'k:r', match: 'auto' },
  { id: 'coasterLower', label: 'Lower track height', description: 'Lower the height the next coaster pieces climb to.', group: 'designer', scope: 'designer', defaultKey: 'k:f', match: 'auto' },
  { id: 'coasterToggleLift', label: 'Toggle chain lift', description: 'Switch the hill under the cursor (or the last one laid) between a chain lift and a free climb.', group: 'designer', scope: 'designer', defaultKey: 'k:l', match: 'auto' },
];

export const KEY_ACTION_BY_ID: ReadonlyMap<ActionId, KeyActionDef> = new Map(KEY_ACTIONS.map((def) => [def.id, def]));

export interface FixedKeyDef {
  keys: string;
  label: string;
  description: string;
  context: string;
}

/** Keys that are deliberately NOT rebindable, each with its reason. */
export const FIXED_KEYS: readonly FixedKeyDef[] = [
  {
    keys: 'Esc',
    label: 'Back out',
    description: 'Closes the topmost layer and nothing else: a focused text field, Save / Load, Settings, the scenario result, the loadout, the leave-run question, the screens of The Map (a drawer first, then the offer and the loadout step back to the run map and the run map closes; the cleared-level and run-over screens are answered with their buttons), the menu panel, the clock popover, the management dashboard, the inspector, then disarms the tool. With nothing open it opens the pause menu. The recovery prompt only closes through its buttons, and a reward draft refuses Esc until a card is picked. Esc always gets you out, so it cannot be changed.',
    context: 'Everywhere',
  },
  {
    keys: 'Ctrl+Z / Cmd+Z',
    label: 'Undo',
    description: 'Undoes the last construction action. Modifier combinations belong to the browser and the OS, and undo needs context-dependent default handling, so it is fixed.',
    context: 'While building',
  },
  {
    keys: 'Ctrl+S / Cmd+S',
    label: 'Quick save',
    description: 'Saves the park (or opens Save / Load when every slot is taken). The browser Save Page dialog must never open over the game, so it is fixed.',
    context: 'Everywhere',
  },
  {
    keys: 'Delete / Backspace',
    label: 'Demolish',
    description: 'Asks to demolish the ride or stall in the open inspector; Keep it has the focus, so a second key press cannot demolish by accident. Delete and Backspace belong to text fields, so they are fixed.',
    context: 'With a ride or stall inspector open',
  },
  {
    keys: 'Arrow keys',
    label: 'Pan and menus',
    description: 'Always pan the camera in addition to the pan keys, and move between options inside menus, tabs and grids.',
    context: 'Park view, widgets',
  },
  {
    keys: 'Tab / Shift+Tab',
    label: 'Move focus',
    description: 'Moves between buttons and fields. Reserved so the game can always be operated from the keyboard.',
    context: 'Everywhere',
  },
  {
    keys: 'Enter / Space',
    label: 'Activate',
    description: 'Presses the focused button or toggles the focused option.',
    context: 'Widgets',
  },
  {
    keys: 'Home / End',
    label: 'First and last',
    description: 'Jump to the first or last tab, option or card in a widget.',
    context: 'Widgets',
  },
  {
    keys: 'Mouse and touch gestures',
    label: 'Construction gestures',
    description: 'Dragging to build paths and rides, click or drag (Shift for every part) with the paint tool, right-click to cancel and middle-drag to pan are pointer gestures. This is the documented exception to keyboard operation; the keyboard can arm tools, rotate, cancel and pan, and recolour a ride or stall from its inspector or a preset for the whole park from the paint panel.',
    context: 'Park view',
  },
];

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

export interface ParsedToken {
  shift: boolean;
  by: 'k' | 'c';
  value: string;
}

/** The event.code values a binding may use (letters and digits are matched by pattern). */
const PUNCTUATION_CODES: Readonly<Record<string, string>> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
};

const ARROW_CODES: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const isBindableCode = (code: string): boolean => (
  /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || Object.hasOwn(PUNCTUATION_CODES, code)
);

export const parseToken = (token: unknown): ParsedToken | null => {
  if (typeof token !== 'string') return null;
  const match = /^(shift\+)?(k|c):(.+)$/.exec(token);
  if (match === null) return null;
  const by = match[2] as 'k' | 'c';
  const value = match[3];
  if (by === 'k') {
    if (!/^[a-z]$/.test(value)) return null;
  } else if (!isBindableCode(value) && !ARROW_CODES.has(value)) {
    return null;
  }
  return { shift: match[1] !== undefined, by, value };
};

/** One identity per physical-or-letter key, so `k:g` and `c:KeyG` compare equal for conflicts. */
const canonicalCode = (parsed: ParsedToken): string => (
  parsed.by === 'k' ? `Key${parsed.value.toUpperCase()}` : parsed.value
);

/**
 * What the capturing key press said about the layout: `key` is what it types, `code` where it sits.
 * A `k:` token (typed letter) and a `c:` token (physical position) only name the same key when the
 * layout is known, so cross-kind conflicts are judged from this hint and never from a QWERTY guess.
 */
export interface LayoutHint {
  key?: string;
  code?: string;
}

/** Numpad digits count as the matching digit-row key. */
const normalizeCode = (code: string): string => {
  const numpad = /^Numpad([0-9])$/.exec(code);
  return numpad ? `Digit${numpad[1]}` : code;
};

export interface KeyEventLike {
  key: string;
  /** Absent in synthetic events: derived from `key` then. */
  code?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

/** `event.code`, or a best-effort derivation from `event.key` for synthetic events that lack it. */
export const eventCode = (event: Pick<KeyEventLike, 'key' | 'code'>): string => {
  if (event.code) return normalizeCode(event.code);
  const key = event.key ?? '';
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === ' ') return 'Space';
  const arrow = /^arrow(left|right|up|down)$/i.exec(key);
  if (arrow) return `Arrow${arrow[1][0].toUpperCase()}${arrow[1].slice(1).toLowerCase()}`;
  return key;
};

const UNREADABLE_KEYS: ReadonlySet<string> = new Set(['Process', 'Dead', 'Unidentified']);

const tokenMatchesEvent = (parsed: ParsedToken, event: KeyEventLike, ignoreShift: boolean): boolean => {
  if (!ignoreShift && parsed.shift !== (event.shiftKey === true)) return false;
  if (parsed.by === 'k') return (event.key ?? '').toLowerCase() === parsed.value;
  return eventCode(event) === parsed.value;
};

export const effectiveToken = (id: ActionId, overrides: KeybindingOverrides): KeyToken | null => {
  const override = overrides[id];
  if (override === null) return null;
  if (override !== undefined) return override;
  return KEY_ACTION_BY_ID.get(id)?.defaultKey ?? null;
};

const allTokens = (def: KeyActionDef, overrides: KeybindingOverrides): ParsedToken[] => {
  const tokens: ParsedToken[] = [];
  const own = effectiveToken(def.id, overrides);
  const parsed = own === null ? null : parseToken(own);
  if (parsed !== null) tokens.push(parsed);
  for (const alias of def.fixedAliases ?? []) {
    const aliasParsed = parseToken(alias);
    if (aliasParsed !== null) tokens.push(aliasParsed);
  }
  return tokens;
};

const modifierHeld = (event: KeyEventLike): boolean => event.ctrlKey === true || event.metaKey === true || event.altKey === true;

/**
 * The action a key PRESS means in the active scopes, or null. Two passes: exact Shift first, then
 * letter tokens ignoring Shift (so Shift+G still toggles the grid, as it always did).
 */
export const resolveKeyAction = (
  event: KeyEventLike,
  scopeOk: (scope: KeyScope) => boolean,
  overrides: KeybindingOverrides,
): ActionId | null => {
  if (modifierHeld(event) || event.isComposing === true || UNREADABLE_KEYS.has(event.key)) return null;
  const candidates = KEY_ACTIONS.filter((def) => scopeOk(def.scope));
  // Typed-letter bindings win over position bindings: on a layout where both name the pressed key
  // the user chose that letter on purpose, and the registry never ships such a pair.
  for (const by of ['k', 'c'] as const) {
    for (const def of candidates) {
      if (allTokens(def, overrides).some((token) => token.by === by && tokenMatchesEvent(token, event, false))) return def.id;
    }
  }
  for (const def of candidates) {
    if (allTokens(def, overrides).some((token) => token.by === 'k' && !token.shift && tokenMatchesEvent(token, event, true))) return def.id;
  }
  return null;
};

/**
 * Whether one action's key is this event, ignoring scope. `release` also ignores modifiers and
 * Shift, so a hold (peek) can never stick because Shift or Ctrl changed while the key was down.
 */
export const matchesAction = (
  id: ActionId,
  event: KeyEventLike,
  overrides: KeybindingOverrides,
  phase: 'press' | 'release' = 'press',
): boolean => {
  const def = KEY_ACTION_BY_ID.get(id);
  if (def === undefined) return false;
  if (phase === 'release') {
    return allTokens(def, overrides).some((token) => tokenMatchesEvent(token, event, true));
  }
  if (modifierHeld(event) || event.isComposing === true || UNREADABLE_KEYS.has(event.key)) return false;
  return allTokens(def, overrides).some((token) => (
    tokenMatchesEvent(token, event, false) || (token.by === 'k' && !token.shift && tokenMatchesEvent(token, event, true))
  ));
};

/** Every event.code that pans in this direction: the effective binding plus the fixed arrow. */
export const panCodes = (
  overrides: KeybindingOverrides,
): { left: readonly string[]; right: readonly string[]; up: readonly string[]; down: readonly string[] } => {
  const codesOf = (id: ActionId): string[] => (
    allTokens(KEY_ACTION_BY_ID.get(id) as KeyActionDef, overrides).map((token) => canonicalCode(token))
  );
  return { left: codesOf('panLeft'), right: codesOf('panRight'), up: codesOf('panUp'), down: codesOf('panDown') };
};

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

const baseLabel = (parsed: ParsedToken): string => {
  if (parsed.by === 'k') return parsed.value.toUpperCase();
  const code = parsed.value;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  const arrow = /^Arrow(Up|Down|Left|Right)$/.exec(code);
  if (arrow) return `${arrow[1]} arrow`;
  return PUNCTUATION_CODES[code] ?? code;
};

export const formatToken = (token: KeyToken | null): string => {
  if (token === null) return '—';
  const parsed = parseToken(token);
  if (parsed === null) return '—';
  return `${parsed.shift ? 'Shift+' : ''}${baseLabel(parsed)}`;
};

/** True when the label names a physical position (a `c:` letter), which differs by layout. */
export const isPhysicalLetter = (token: KeyToken | null): boolean => {
  const parsed = token === null ? null : parseToken(token);
  return parsed !== null && parsed.by === 'c' && /^Key[A-Z]$/.test(parsed.value);
};

export const keyLabelFor = (id: ActionId, overrides: KeybindingOverrides): string => (
  formatToken(effectiveToken(id, overrides))
);

export const withKeyHintFor = (text: string, id: ActionId, overrides: KeybindingOverrides): string => {
  const token = effectiveToken(id, overrides);
  return token === null ? text : `${text} (${formatToken(token)})`;
};

export const ariaKeyShortcutsFor = (id: ActionId, overrides: KeybindingOverrides): string | undefined => {
  const token = effectiveToken(id, overrides);
  const parsed = token === null ? null : parseToken(token);
  if (parsed === null) return undefined;
  const base = baseLabel(parsed);
  return `${parsed.shift ? 'Shift+' : ''}${base.length === 1 ? base.toLowerCase() : base}`;
};

/** The six help-hint phrases with the live key labels; an unbound action drops its phrase. */
export const helpHintItemsFor = (overrides: KeybindingOverrides): string[] => {
  const items = ['Drag to build'];
  const rotate = effectiveToken('rotate', overrides);
  if (rotate !== null) items.push(`${formatToken(rotate)} to rotate`);
  const peek = effectiveToken('peek', overrides);
  if (peek !== null) items.push(`Hold ${formatToken(peek)} to see through`);
  items.push('Wheel to zoom');
  const pan = (['panUp', 'panLeft', 'panDown', 'panRight'] as const).map((id) => effectiveToken(id, overrides));
  const labels = pan.map((token) => formatToken(token));
  let keys: string;
  if (pan.some((token) => token === null)) keys = 'Arrow keys';
  else keys = labels.every((label) => label.length === 1) ? labels.join('') : labels.join('/');
  items.push(`Middle-drag · ${keys} to pan`);
  items.push('Esc to put the tool down');
  return items;
};

// ---------------------------------------------------------------------------------------------
// Capture, validation, conflicts
// ---------------------------------------------------------------------------------------------

export type BindingRefusal =
  | { reason: 'reserved'; message: string }
  | { reason: 'conflict'; message: string; with: ActionId }
  | { reason: 'invalid'; message: string };

const MSG_BROWSER = 'Shortcuts with Ctrl, Cmd or Alt belong to the browser. Pick a plain key.';
const MSG_ESC = 'Esc always backs out and cannot be changed.';
const MSG_WIDGET = 'That key is used to operate buttons and menus. Pick another key.';
const MSG_ARROWS = 'Arrow keys already pan the camera and move inside menus. Pick another key.';
const MSG_SYSTEM = 'That key is reserved by the browser or the system. Pick another key.';
const MSG_UNREADABLE = 'That key could not be read. Pick another key.';
const MSG_UNSUPPORTED = 'That key cannot be used. Use a letter, a digit or one of - = [ ] ; \' , . / \\ `.';
const MSG_NO_SHIFT_CAMERA = 'Camera keys cannot use Shift. Pick a plain key.';

export const RESERVED_MESSAGES = {
  browser: MSG_BROWSER,
  escape: MSG_ESC,
  widget: MSG_WIDGET,
  arrows: MSG_ARROWS,
  system: MSG_SYSTEM,
} as const;

const refusalForCode = (code: string): BindingRefusal | null => {
  if (code === 'Escape') return { reason: 'reserved', message: MSG_ESC };
  if (['Tab', 'Enter', 'NumpadEnter', 'Space', 'Backspace', 'Delete'].includes(code)) return { reason: 'reserved', message: MSG_WIDGET };
  if (ARROW_CODES.has(code) || ['Home', 'End', 'PageUp', 'PageDown', 'Insert'].includes(code)) return { reason: 'reserved', message: MSG_ARROWS };
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code) || ['ContextMenu', 'CapsLock', 'NumLock', 'ScrollLock', 'Pause', 'PrintScreen'].includes(code)) {
    return { reason: 'reserved', message: MSG_SYSTEM };
  }
  return null;
};

const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS']);

export type TokenFromEvent =
  | { ok: true; token: KeyToken }
  | { ok: false; refusal: BindingRefusal | 'ignore' };

/** Turns a captured key press into a token for this action, or says why not. */
export const tokenFromEvent = (event: KeyEventLike, action: KeyActionDef): TokenFromEvent => {
  if (MODIFIER_KEYS.has(event.key)) return { ok: false, refusal: 'ignore' };
  if (event.isComposing === true || UNREADABLE_KEYS.has(event.key)) return { ok: false, refusal: { reason: 'invalid', message: MSG_UNREADABLE } };
  if (modifierHeld(event)) return { ok: false, refusal: { reason: 'reserved', message: MSG_BROWSER } };
  const code = eventCode(event);
  const refusal = refusalForCode(code);
  if (refusal !== null) return { ok: false, refusal };
  const shift = event.shiftKey === true;
  if (shift && action.match === 'code') return { ok: false, refusal: { reason: 'invalid', message: MSG_NO_SHIFT_CAMERA } };
  const prefix = shift ? 'shift+' : '';
  if (action.match === 'auto' && /^[a-zA-Z]$/.test(event.key)) return { ok: true, token: `${prefix}k:${event.key.toLowerCase()}` };
  if (!isBindableCode(code)) return { ok: false, refusal: { reason: 'invalid', message: MSG_UNSUPPORTED } };
  return { ok: true, token: `${prefix}c:${code}` };
};

/** Static check of one token for one action: grammar, reserved keys, Shift on camera keys. */
const checkToken = (def: KeyActionDef, token: KeyToken): BindingRefusal | null => {
  const parsed = parseToken(token);
  if (parsed === null) return { reason: 'invalid', message: MSG_UNSUPPORTED };
  if (parsed.by === 'c') {
    const refusal = refusalForCode(parsed.value);
    if (refusal !== null) return refusal;
  }
  if (!isBindableCode(canonicalCode(parsed))) return { reason: 'invalid', message: MSG_UNSUPPORTED };
  if (def.match === 'code' && parsed.shift) return { reason: 'invalid', message: MSG_NO_SHIFT_CAMERA };
  return null;
};

/** Whether two tokens are the same key: typed letters by letter, positions by code, mixed by the layout hint. */
const sameKey = (a: ParsedToken, b: ParsedToken, hint: LayoutHint | undefined): boolean => {
  if (a.shift !== b.shift) return false;
  if (a.by === b.by) return a.value === b.value;
  // Mixed: `a` is the new token the hint describes, `b` an existing one. Without a hint the layout is unknown.
  if (hint === undefined) return false;
  if (a.by === 'k') return hint.code !== undefined && hint.code === b.value;
  return hint.key !== undefined && hint.key.toLowerCase() === b.value;
};

/** The other action using this token in an overlapping scope, or null. */
const findConflict = (
  def: KeyActionDef,
  parsed: ParsedToken,
  overrides: KeybindingOverrides,
  hint?: LayoutHint,
): KeyActionDef | null => {
  for (const other of KEY_ACTIONS) {
    if (other.id === def.id || !scopesOverlap(other.scope, def.scope)) continue;
    if (allTokens(other, overrides).some((token) => sameKey(parsed, token, hint))) return other;
  }
  return null;
};

export const validateBinding = (
  id: ActionId,
  token: KeyToken | null,
  overrides: KeybindingOverrides,
  hint?: LayoutHint,
): { ok: true } | { ok: false; refusal: BindingRefusal } => {
  const def = KEY_ACTION_BY_ID.get(id);
  if (def === undefined) return { ok: false, refusal: { reason: 'invalid', message: 'Unknown action.' } };
  if (token === null) return { ok: true };
  const bad = checkToken(def, token);
  if (bad !== null) return { ok: false, refusal: bad };
  const parsed = parseToken(token) as ParsedToken;
  const other = findConflict(def, parsed, overrides, hint);
  if (other !== null) {
    return {
      ok: false,
      refusal: {
        reason: 'conflict',
        with: other.id,
        message: `${formatToken(token)} is already used by ${other.label}. Pick another key or reset that one first.`,
      },
    };
  }
  return { ok: true };
};

/** Pure: a new overrides object with the binding set, or a refusal. Equal-to-default drops the entry. */
export const setBinding = (
  overrides: KeybindingOverrides,
  id: ActionId,
  token: KeyToken | null,
  hint?: LayoutHint,
): { ok: true; overrides: KeybindingOverrides } | { ok: false; refusal: BindingRefusal } => {
  const result = validateBinding(id, token, overrides, hint);
  if (!result.ok) return result;
  const next: Partial<Record<ActionId, KeyToken | null>> = { ...overrides };
  const def = KEY_ACTION_BY_ID.get(id) as KeyActionDef;
  if (token === def.defaultKey) delete next[id];
  else next[id] = token;
  return { ok: true, overrides: next };
};

export const resetBinding = (overrides: KeybindingOverrides, id: ActionId): KeybindingOverrides => {
  const next: Partial<Record<ActionId, KeyToken | null>> = { ...overrides };
  delete next[id];
  return next;
};

/**
 * Per-entry validation of stored data: drops unknown ids, bad types, bad or reserved tokens and,
 * in registry order, any entry that conflicts with one already accepted, so a loaded set is always
 * conflict-free. A dropped entry silently reverts to its default, except that an action marked
 * `yieldsDefault` loads unbound when a stored binding of another action holds its default key. Never throws.
 */
export const validateKeybindings = (raw: unknown): KeybindingOverrides => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  // Pass 1: entries that are well-formed on their own. An entry equal to its default is no override.
  const candidate: Partial<Record<ActionId, KeyToken | null>> = {};
  for (const def of KEY_ACTIONS) {
    if (!Object.hasOwn(input, def.id)) continue;
    const value = input[def.id];
    if (value === null) candidate[def.id] = null;
    else if (typeof value === 'string' && value !== def.defaultKey && checkToken(def, value) === null) candidate[def.id] = value;
  }
  // Pass 1b: a default added after players could store bindings yields to a stored binding of another
  // action on that key, so an update never silently takes a key the player chose (Phase 26: Q/E).
  for (const def of KEY_ACTIONS) {
    if (def.yieldsDefault !== true || Object.hasOwn(candidate, def.id)) continue;
    const parsed = parseToken(def.defaultKey) as ParsedToken;
    const claimed = KEY_ACTIONS.some((other) => {
      const token = candidate[other.id];
      return other.id !== def.id && typeof token === 'string' && scopesOverlap(other.scope, def.scope)
        && sameKey(parsed, parseToken(token) as ParsedToken, undefined);
    });
    if (claimed) candidate[def.id] = null;
  }
  // Pass 2: in registry order, drop an entry that clashes with another action's effective key
  // (judged against the whole candidate, so a legitimate swap of two keys survives).
  // Repeated until stable: dropping an entry puts its action back on its default key, which may
  // itself clash with an entry that was kept earlier.
  for (let changed = true; changed;) {
    changed = false;
    // Reverse order: of two entries that clash, the earlier one in the registry wins.
    for (const def of [...KEY_ACTIONS].reverse()) {
      const token = candidate[def.id];
      if (typeof token !== 'string') continue;
      if (findConflict(def, parseToken(token) as ParsedToken, candidate) !== null) {
        delete candidate[def.id];
        changed = true;
      }
    }
  }
  return candidate;
};

export const keybindingsEqual = (a: KeybindingOverrides, b: KeybindingOverrides): boolean => {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------------------------
// The generated documentation (KEYBINDINGS.md)
// ---------------------------------------------------------------------------------------------

const SCOPE_TEXT: Readonly<Record<KeyScope, string>> = {
  view: 'Park view: everywhere except overlays, dialogs and menus',
  build: 'While building: not behind the management dashboard, overlays, dialogs or menus',
  'build-not-designer': 'While building, except in the coaster designer',
  designer: 'Only while the coaster designer is open',
};

export const KEYBINDINGS_DOC_PATH = 'KEYBINDINGS.md';

const escapeCell = (text: string): string => text.replaceAll('|', '\\|');

export const renderKeybindingsMarkdown = (): string => {
  const lines: string[] = [
    '# Keyboard shortcuts',
    '',
    '<!-- Generated from src/settings/keybindings.ts by src/settings/keybindings.doc.test.ts. Do not edit by hand. -->',
    '',
    'This file is generated from the shortcut registry, so it cannot drift from the game. To change it, edit the registry and run `UPDATE_KEYBINDINGS_DOC=1 npx vitest run src/settings/keybindings.doc.test.ts`.',
    '',
    'Every shortcut below can be changed in Settings, in the Keyboard section. Esc and the fixed keys cannot.',
  ];
  for (const group of KEY_GROUP_ORDER) {
    const actions = KEY_ACTIONS.filter((def) => def.group === group);
    if (actions.length === 0) continue;
    lines.push('', `## ${KEY_GROUP_TITLES[group]}`, '', '| Action | Default key | Works | Description |', '| --- | --- | --- | --- |');
    for (const def of actions) {
      const parsed = parseToken(def.defaultKey) as ParsedToken;
      const aliases = (def.fixedAliases ?? []).map((alias) => formatToken(alias));
      const keyText = [formatToken(def.defaultKey), ...aliases].join(' or ');
      const extra = def.hold ? ' Hold the key; release to stop.' : '';
      const physical = parsed.by === 'c' && /^Key[A-Z]$/.test(parsed.value) ? ' The letter names the physical key position, so it follows the same keys on other layouts.' : '';
      lines.push(`| ${escapeCell(def.label)} | ${escapeCell(keyText)} | ${escapeCell(SCOPE_TEXT[def.scope])} | ${escapeCell(def.description + extra + physical)} |`);
    }
  }
  lines.push('', '## Fixed keys', '', 'These cannot be rebound.', '', '| Keys | What | Where | Description |', '| --- | --- | --- | --- |');
  for (const fixed of FIXED_KEYS) {
    lines.push(`| ${escapeCell(fixed.keys)} | ${escapeCell(fixed.label)} | ${escapeCell(fixed.context)} | ${escapeCell(fixed.description)} |`);
  }
  lines.push(
    '',
    '## Rebinding rules',
    '',
    '- One key or none per action. Clear leaves an action without a key; Reset restores the default.',
    '- Plain keys are allowed, with or without Shift: letters, digits, and the punctuation keys minus, equals, brackets, semicolon, quote, comma, period, slash, backslash and backquote. Camera keys cannot use Shift.',
    '- Refused with a message: Esc, Tab, Enter, Space, Backspace, Delete, arrow keys, Home, End, Page Up/Down, F1 to F12, and anything with Ctrl, Cmd or Alt.',
    '- Two actions cannot share a key when both can be active at once. The coaster designer reuses R and F because its keys replace the tool keys while it is open.',
    '',
    '## Keyboard layouts',
    '',
    '- A typed letter and a physical position only name the same key once the layout is known, so the conflict check for a new binding uses the key press that captured it (what it types and where it sits). A letter that types on a camera key position of your layout is refused, and a different letter on a Dvorak or AZERTY keyboard is not flagged just because it shares a QWERTY label.',
    '- Letters are matched by the character on the keycap, so a rebound letter works on AZERTY, QWERTZ and Dvorak as printed.',
    '- Digits and punctuation are matched by physical key position (`event.code`), so the speed keys work on AZERTY, where the unshifted digit row types symbols. The numpad digits work as the matching digit.',
    '- Camera keys are matched by physical position on every layout, so the WASD cluster stays where the hand expects it.',
    '',
    '## Mouse gestures',
    '',
    'Construction gestures (drag to build, right-click to cancel, middle-drag to pan, wheel to zoom) are pointer-based by design. Everything else can be operated from the keyboard; the keyboard can arm tools, rotate, cancel and pan.',
    '',
  );
  return lines.join('\n');
};
