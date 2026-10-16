import {
  FIXED_KEYS,
  KEY_ACTIONS,
  KEY_ACTION_BY_ID,
  KEY_GROUP_ORDER,
  KEY_GROUP_TITLES,
  effectiveToken,
  formatToken,
  isPhysicalLetter,
  resetBinding,
  setBinding,
  eventCode,
  tokenFromEvent,
  type ActionId,
  type FixedKeyDef,
  type KeyEventLike,
  type KeyGroup,
  type KeybindingOverrides,
} from '../settings/keybindings';

/**
 * What the Keyboard section of the settings panel shows and how a key capture behaves, as plain
 * data and a pure reducer. No DOM, no store: the component owns the listener and the focus.
 */
export interface KeyRowView {
  id: ActionId;
  label: string;
  description: string;
  /** "G", "Shift+G" or "—" when unbound. */
  keyText: string;
  /** The key is a physical position (a `c:` letter): the label is the US keycap. */
  physical: boolean;
  isDefault: boolean;
  bound: boolean;
  defaultText: string;
}

export interface KeyGroupView {
  group: KeyGroup;
  title: string;
  note: string | null;
  rows: KeyRowView[];
}

const GROUP_NOTES: Partial<Record<KeyGroup, string>> = {
  camera: 'Arrow keys always pan as well. These follow the physical key, so they stay put on any keyboard layout.',
  speed: 'Number keys follow the physical key; the numpad works too.',
  designer: 'Only while the coaster designer is open.',
};

export const keyboardGroups = (overrides: KeybindingOverrides): KeyGroupView[] => (
  KEY_GROUP_ORDER.map((group) => ({
    group,
    title: KEY_GROUP_TITLES[group],
    note: GROUP_NOTES[group] ?? null,
    rows: KEY_ACTIONS.filter((def) => def.group === group).map((def): KeyRowView => {
      const token = effectiveToken(def.id, overrides);
      return {
        id: def.id,
        label: def.label,
        description: def.description,
        keyText: formatToken(token),
        physical: isPhysicalLetter(token),
        isDefault: token === def.defaultKey,
        bound: token !== null,
        defaultText: formatToken(def.defaultKey),
      };
    }),
  })).filter((group) => group.rows.length > 0)
);

export const fixedKeys = (): readonly FixedKeyDef[] => FIXED_KEYS;

/** How many actions differ from their default. */
export const customBindingCount = (overrides: KeybindingOverrides): number => Object.keys(overrides).length;

export type CaptureState =
  | { mode: 'idle' }
  | { mode: 'capturing'; id: ActionId }
  | { mode: 'refused'; id: ActionId; message: string };

export const isCapturing = (state: CaptureState): boolean => state.mode !== 'idle';

export type CaptureAction =
  | { type: 'start'; id: ActionId }
  | { type: 'cancel' }
  | { type: 'key'; event: KeyEventLike }
  | { type: 'clear'; id: ActionId }
  | { type: 'reset'; id: ActionId }
  | { type: 'resetAll' };

export interface CaptureOutcome {
  state: CaptureState;
  overrides: KeybindingOverrides;
  /** Said through the polite live region; null = nothing new to say. */
  status: string | null;
  /** True when `overrides` differ and must be written to settings. */
  changed: boolean;
}

const labelOf = (id: ActionId): string => KEY_ACTION_BY_ID.get(id)?.label ?? id;

/** One step of the capture: pure, so Esc-cancels-without-closing and every refusal are unit tests. */
export const captureStep = (state: CaptureState, action: CaptureAction, overrides: KeybindingOverrides): CaptureOutcome => {
  const same = (status: string | null, next: CaptureState = { mode: 'idle' }): CaptureOutcome => (
    { state: next, overrides, status, changed: false }
  );
  switch (action.type) {
    case 'start':
      return same(`Press a key for ${labelOf(action.id)}. Esc cancels.`, { mode: 'capturing', id: action.id });
    case 'cancel': {
      if (state.mode === 'idle') return same(null);
      return same(`Cancelled. ${labelOf(state.id)} is still ${formatToken(effectiveToken(state.id, overrides))}.`);
    }
    case 'key': {
      if (state.mode === 'idle') return same(null);
      const { event } = action;
      if (event.key === 'Escape') return captureStep(state, { type: 'cancel' }, overrides);
      const def = KEY_ACTION_BY_ID.get(state.id);
      if (def === undefined) return same(null);
      const token = tokenFromEvent(event, def);
      if (!token.ok) {
        if (token.refusal === 'ignore') return same(null, state);
        const message = token.refusal.message;
        return same(message, { mode: 'refused', id: state.id, message });
      }
      const result = setBinding(overrides, state.id, token.token, { key: event.key, code: eventCode(event) });
      if (!result.ok) {
        const message = result.refusal.message;
        return same(message, { mode: 'refused', id: state.id, message });
      }
      return {
        state: { mode: 'idle' },
        overrides: result.overrides,
        status: `${def.label} is now ${formatToken(token.token)}.`,
        changed: true,
      };
    }
    case 'clear': {
      const result = setBinding(overrides, action.id, null);
      if (!result.ok) return same(result.refusal.message);
      return { state: { mode: 'idle' }, overrides: result.overrides, status: `${labelOf(action.id)} has no key now.`, changed: true };
    }
    case 'reset': {
      const def = KEY_ACTION_BY_ID.get(action.id);
      if (def === undefined) return same(null);
      // Going back to the default can clash with a key that was given to another action since.
      const result = setBinding(overrides, action.id, def.defaultKey);
      if (!result.ok) return same(result.refusal.message);
      return {
        state: { mode: 'idle' },
        overrides: resetBinding(result.overrides, action.id),
        status: `${def.label} is back to ${formatToken(def.defaultKey)}.`,
        changed: true,
      };
    }
    case 'resetAll': {
      const count = customBindingCount(overrides);
      if (count === 0) return same('All keyboard shortcuts are already the defaults.');
      return { state: { mode: 'idle' }, overrides: {}, status: `All keyboard shortcuts reset to the defaults (${count} changed back).`, changed: true };
    }
  }
};
