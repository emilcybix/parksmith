import { CARD_BY_ID } from '../game/cards/content';
import type { PulseCardId } from '../game/cards/types';
import { BUILD_BY_ID } from '../game/content/catalog';
import { getSettings } from '../settings/settingsStore';
import { matchesAction, type KeybindingOverrides, type KeyScope } from '../settings/keybindings';
import type { RecoveryPhase, RecoverySnapshot } from '../app/saves/recoveryTypes';
import type { UiState } from './store';

/**
 * Which layer of the interface owns the keyboard right now.
 *
 * Three separate bugs — game shortcuts firing behind a full-screen modal, Escape closing the
 * whole Parks overlay instead of one layer, and the coaster designer's `R`/`F` colliding with
 * rotate `R` — were all the same missing concept: nothing decided which layer input belonged to.
 * This is that decision, in one place. Contexts are listed from the top of the stack down;
 * exactly one is active, `Escape` pops it, and shortcuts are filtered by its capabilities.
 */
export type InputContext =
  | 'textInput'
  | 'saveLoad'
  | 'recovery'
  | 'settings'
  | 'leaveRun'
  | 'rewardDraft'
  | 'scenarioResult'
  | 'loadout'
  | 'runMap'
  | 'menu'
  | 'clockPopover'
  | 'management'
  | 'inspector'
  | 'coasterDesigner'
  | 'build'
  | 'world';

export interface InputContextCapabilities {
  /** Tool and construction keys: bulldozer, path, rotate, coaster track height. */
  readonly build: boolean;
  /** Keys that only change what you are looking at: game speed, grid, camera panning. */
  readonly view: boolean;
}

/**
 * The full-screen overlays take everything, because their backdrop already takes the mouse and a
 * keyboard that disagrees with the mouse is exactly how PA-005 happened. The management dashboard
 * is a side panel, not an overlay: the park stays visible and pannable, but the build dock is
 * hidden behind it, so arming a tool you cannot see is not allowed either.
 */
export const INPUT_CONTEXT_CAPABILITIES: Readonly<Record<InputContext, InputContextCapabilities>> = {
  textInput: { build: false, view: false },
  saveLoad: { build: false, view: false },
  recovery: { build: false, view: false },
  // The settings panel is docked and the park stays visible behind it, but nothing may build or pan
  // while a radio group owns the arrow keys.
  settings: { build: false, view: false },
  // "Leave the run?" is a question over the menu or the run map: nothing behind it may act.
  leaveRun: { build: false, view: false },
  rewardDraft: { build: false, view: false },
  scenarioResult: { build: false, view: false },
  loadout: { build: false, view: false },
  // The Map's overlay (the run map, the offer, the loadout, the cleared-level and run-over screens): a full-screen layer.
  runMap: { build: false, view: false },
  // The start screen and the pause menu: the park is only a backdrop (or paused), so no tool key, camera key or speed key may act behind it.
  menu: { build: false, view: false },
  // Non-modal: it only floats over the park, so the world keys keep working while it is open.
  clockPopover: { build: true, view: true },
  management: { build: false, view: true },
  inspector: { build: true, view: true },
  coasterDesigner: { build: true, view: true },
  build: { build: true, view: true },
  world: { build: true, view: true },
};

/** The slice of UI state the stack is derived from — no separate source of truth to drift. */
export type InputContextSource = {
  /** Only the phase matters, so a test (or a caller) need not build a whole snapshot. */
  recovery: Pick<RecoverySnapshot, 'phase'>;
} & Pick<
  UiState,
  | 'savesDialogOpen'
  | 'settingsOpen'
  | 'rewardDraft'
  | 'scenario'
  | 'scenarioResultDismissed'
  | 'loadoutScenarioId'
  | 'scenarioPickerOpen'
  | 'managementOpen'
  | 'clockPopoverOpen'
  | 'selectedRide'
  | 'selectedService'
  | 'tool'
  | 'selectedDefinitionId'
> & {
  /** Optional so a state without the menu layer (older callers, tests) reads as "no menu". */
  menuKind?: UiState['menuKind'];
  /** Phase 30, optional for the same reason: the guest inspector shares the inspector layer. */
  selectedGuest?: UiState['selectedGuest'];
  /** Phase 23, optional for the same reason: the run overlay, the leave-run question and the park's mode. */
  runView?: UiState['runView'];
  leaveRunPrompt?: UiState['leaveRunPrompt'];
  sessionMode?: UiState['sessionMode'];
};

/**
 * Whether the "resume your last park?" prompt owns the screen. In flight counts as open: the
 * player already pressed a button and the answer has not come back, so the layer below must stay
 * inert until it does. Lives here (not in recoveryModel) because this file is below it in the
 * import graph.
 */
export const isRecoveryPromptOpen = (phase: RecoveryPhase): boolean => (
  phase === 'offered' || phase === 'resuming' || phase === 'dismissing'
);

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(['', 'text', 'search', 'number', 'email', 'url', 'password', 'tel']);

/** True when keystrokes in this element are text, not game input (inputs, textareas, rich text). */
export const isTextInputTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (element === null) return false;
  if (element.tagName === 'TEXTAREA' || element.isContentEditable) return true;
  if (element.tagName !== 'INPUT') return false;
  // Radios, checkboxes, ranges and buttons never take typed text, so Escape must still reach the layer.
  const type = ((element as HTMLInputElement).type ?? element.getAttribute?.('type') ?? 'text').toLowerCase();
  return TEXT_INPUT_TYPES.has(type);
};

/**
 * Derived, never stored: every layer below already has state that says whether it is on screen,
 * and duplicating that into a stack array is how the two would eventually disagree.
 */
export const activeInputContext = (
  state: InputContextSource,
  textInputFocused = false,
): InputContext => {
  if (textInputFocused) return 'textInput';
  // The Save / Load dialog is reachable from the run map, the result overlay and the menu, so it sits
  // above every other layer: whatever it was opened over stays inert until it closes.
  if (state.savesDialogOpen) return 'saveLoad';
  // The recovery prompt is the first decision of a session and sits above the run map, the
  // loadout and the result overlay. It sits below the Save / Load dialog only because its own
  // "no free slot" message sends the player there, and it hides while that dialog is open.
  if (isRecoveryPromptOpen(state.recovery.phase)) return 'recovery';
  // The settings panel opens over the run map, the loadout and the result overlay (the start
  // screen calls `openSettings()` over them) and below Save / Load and the recovery prompt.
  if (state.settingsOpen) return 'settings';
  // Leaving an unfinished run is asked over whatever raised it (the setup panel, the menu, the run map). Save / Load, the
  // recovery prompt and Settings open from it or above it, so they outrank it.
  if (state.leaveRunPrompt != null) return 'leaveRun';
  // The start screen's sweep may be a finished scenario park; its result overlay waits for Continue. A run's stage
  // result is not this overlay: The Map has its own screens (the `runMap` layer), so a run park never shows it.
  const resultOpen = state.scenario !== null
    && state.scenario.status !== 'running'
    && !state.scenarioResultDismissed
    && state.menuKind !== 'start'
    && state.sessionMode !== 'run';
  if (resultOpen) {
    // `rewardDraft` is the one layer Escape refuses to pop, so it may only claim the keyboard
    // when the overlay can actually render a card to pick. An unrenderable draft would be a
    // dead end with no exit.
    const drafting = state.scenario?.status === 'succeeded'
      && (state.rewardDraft ?? []).some((cardId) => CARD_BY_ID.has(cardId as PulseCardId));
    return drafting ? 'rewardDraft' : 'scenarioResult';
  }
  // The Scenario browser's loadout, then The Map's overlay (it opens from the menu, so it sits above it).
  if (state.scenarioPickerOpen && state.loadoutScenarioId !== null) return 'loadout';
  if (state.runView != null) return 'runMap';
  // The menu layer (start screen, pause menu) sits above every in-game layer and below everything it
  // can open itself: Settings, Save / Load, the run map and the Scenario loadout all open FROM it and
  // must be above it, and the recovery prompt outranks the whole menu.
  if (state.menuKind != null) return 'menu';
  // The popover is a small floating layer over the park and the top bar, above the side panels,
  // so Escape closes it first and leaves the armed tool or the open panel alone.
  if (state.clockPopoverOpen) return 'clockPopover';
  if (state.managementOpen) return 'management';
  if (state.selectedRide !== null || state.selectedService !== null || state.selectedGuest != null) return 'inspector';
  if (state.tool === 'build' && state.selectedDefinitionId !== null) {
    return BUILD_BY_ID.get(state.selectedDefinitionId)?.custom === 'coaster'
      ? 'coasterDesigner'
      : 'build';
  }
  // The pointer is the resting tool: it is the world layer, not an armed one.
  return state.tool === 'pointer' ? 'world' : 'build';
};

/**
 * The context set each registry scope covers, derived from the capability table. The registry
 * (src/settings/keybindings.ts) cannot import this file, so a test asserts its `scopesOverlap`
 * agrees with these sets.
 */
export const contextsForScope = (scope: KeyScope): InputContext[] => (
  (Object.keys(INPUT_CONTEXT_CAPABILITIES) as InputContext[]).filter((context) => {
    const caps = INPUT_CONTEXT_CAPABILITIES[context];
    switch (scope) {
      case 'view': return caps.view;
      case 'build': return caps.build;
      case 'build-not-designer': return caps.build && context !== 'coasterDesigner';
      case 'designer': return context === 'coasterDesigner';
    }
  })
);

/** Whether a registry scope is live in this input context. */
export const scopeActiveIn = (scope: KeyScope, context: InputContext): boolean => {
  const caps = INPUT_CONTEXT_CAPABILITIES[context];
  switch (scope) {
    case 'view': return caps.view;
    case 'build': return caps.build;
    case 'build-not-designer': return caps.build && context !== 'coasterDesigner';
    case 'designer': return context === 'coasterDesigner';
  }
};

/** The slice of a keyboard event the peek decision reads. */
export interface PeekKeyEvent {
  readonly type: string;
  readonly key: string;
  readonly code?: string;
  readonly shiftKey?: boolean;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

export type PeekKeyPlan = 'press' | 'release' | 'ignore';

/**
 * Hold the peek key (X by default, rebindable) to see through everything near the cursor. A press
 * only counts on the first keydown, with no Ctrl/Cmd/Alt, in a context with the build capability
 * (never in a text field or behind a modal). A release counts from ANY keyup of the key, in any
 * context and with any modifier, so the peek can never stick when the layer changed while the key
 * was down.
 */
export const planPeekKey = (
  event: PeekKeyEvent,
  context: InputContext,
  overrides: KeybindingOverrides = getSettings().keybindings,
): PeekKeyPlan => {
  if (event.type === 'keyup') return matchesAction('peek', event, overrides, 'release') ? 'release' : 'ignore';
  if (event.type !== 'keydown') return 'ignore';
  if (!matchesAction('peek', event, overrides, 'press')) return 'ignore';
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return 'ignore';
  return INPUT_CONTEXT_CAPABILITIES[context].build ? 'press' : 'ignore';
};
