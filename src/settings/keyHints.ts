import {
  ariaKeyShortcutsFor,
  helpHintItemsFor,
  keyLabelFor,
  withKeyHintFor,
  type ActionId,
  type KeybindingOverrides,
} from './keybindings';
import { getSettings } from './settingsStore';

/**
 * Label helpers for tooltips, aria-keyshortcuts and the help hint. The overrides default to the
 * live settings, so a label can never go stale; pass `useKeybindings()` from a component so a
 * rebind re-renders it.
 */
const current = (overrides?: KeybindingOverrides): KeybindingOverrides => overrides ?? getSettings().keybindings;

/** "G", "Shift+G", "—" when unbound. */
export const keyLabel = (id: ActionId, overrides?: KeybindingOverrides): string => keyLabelFor(id, current(overrides));

/** "Toggle grid (G)"; just "Toggle grid" when the action has no key. */
export const withKeyHint = (text: string, id: ActionId, overrides?: KeybindingOverrides): string => (
  withKeyHintFor(text, id, current(overrides))
);

/** For `aria-keyshortcuts`; undefined when unbound. */
export const ariaKeyShortcuts = (id: ActionId, overrides?: KeybindingOverrides): string | undefined => (
  ariaKeyShortcutsFor(id, current(overrides))
);

export const helpHintItems = (overrides?: KeybindingOverrides): string[] => helpHintItemsFor(current(overrides));
