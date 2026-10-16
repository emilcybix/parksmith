import { describe, expect, it } from 'vitest';
import { KEY_ACTION_BY_ID, KEY_ACTIONS, scopesOverlap, type KeyScope } from '../settings/keybindings';
import type { ScenarioSnapshot } from '../game/scenarios/types';
import {
  activeInputContext,
  INPUT_CONTEXT_CAPABILITIES,
  contextsForScope,
  scopeActiveIn,
  isRecoveryPromptOpen,
  isTextInputTarget,
  planPeekKey,
  type PeekKeyEvent,
  type InputContext,
  type InputContextSource,
} from './inputContext';

const base: InputContextSource = {
  savesDialogOpen: false,
  settingsOpen: false,
  recovery: { phase: 'idle' },
  rewardDraft: null,
  scenario: null,
  scenarioResultDismissed: false,
  loadoutScenarioId: null,
  scenarioPickerOpen: false,
  managementOpen: false,
  clockPopoverOpen: false,
  selectedRide: null,
  selectedService: null,
  tool: 'pointer',
  selectedDefinitionId: null,
};

const state = (overrides: Partial<InputContextSource>): InputContextSource => ({ ...base, ...overrides });

const scenario = (status: ScenarioSnapshot['status']): ScenarioSnapshot =>
  ({ status } as ScenarioSnapshot);

/** The stack, top first. Every layer below is also true in these states. */
const LAYERS: { context: InputContext; state: InputContextSource }[] = [
  {
    context: 'saveLoad',
    state: state({ savesDialogOpen: true, scenario: scenario('succeeded'), rewardDraft: ['grand-opening'], scenarioPickerOpen: true, managementOpen: true, tool: 'build', selectedDefinitionId: 'sunstone-path' }),
  },
  {
    context: 'recovery',
    state: state({ recovery: { phase: 'offered' }, scenario: scenario('succeeded'), rewardDraft: ['grand-opening'], scenarioPickerOpen: true, loadoutScenarioId: 'garden-gate', managementOpen: true, tool: 'build', selectedDefinitionId: 'sunstone-path' }),
  },
  {
    context: 'settings',
    state: state({ settingsOpen: true, scenario: scenario('succeeded'), rewardDraft: ['grand-opening'], scenarioPickerOpen: true, loadoutScenarioId: 'garden-gate', managementOpen: true, clockPopoverOpen: true, tool: 'build', selectedDefinitionId: 'sunstone-path' }),
  },
  {
    context: 'leaveRun',
    state: state({ leaveRunPrompt: { reason: 'new-run' }, runView: 'map', scenario: scenario('succeeded'), rewardDraft: ['grand-opening'], managementOpen: true, tool: 'build', selectedDefinitionId: 'sunstone-path' }),
  },
  {
    context: 'rewardDraft',
    state: state({ scenario: scenario('succeeded'), rewardDraft: ['grand-opening'], scenarioPickerOpen: true, managementOpen: true, tool: 'build', selectedDefinitionId: 'sunstone-path' }),
  },
  {
    context: 'scenarioResult',
    state: state({ scenario: scenario('failed'), scenarioPickerOpen: true, managementOpen: true, tool: 'build', selectedDefinitionId: 'sunstone-path' }),
  },
  {
    context: 'loadout',
    state: state({ scenarioPickerOpen: true, loadoutScenarioId: 'garden-gate', managementOpen: true, tool: 'build', selectedDefinitionId: 'sunstone-path' }),
  },
  {
    context: 'runMap',
    state: state({ runView: 'map', managementOpen: true, tool: 'build', selectedDefinitionId: 'sunstone-path' }),
  },
  {
    context: 'menu',
    state: state({ menuKind: 'pause', clockPopoverOpen: true, managementOpen: true, selectedRide: {} as never, tool: 'build', selectedDefinitionId: 'sunstone-path' }),
  },
  {
    context: 'management',
    state: state({ managementOpen: true, selectedRide: {} as never, tool: 'build', selectedDefinitionId: 'sunstone-path' }),
  },
  {
    context: 'inspector',
    state: state({ selectedRide: {} as never, tool: 'build', selectedDefinitionId: 'sunstone-path' }),
  },
  {
    context: 'coasterDesigner',
    state: state({ tool: 'build', selectedDefinitionId: 'comet-trail' }),
  },
  {
    context: 'build',
    state: state({ tool: 'build', selectedDefinitionId: 'sunstone-path' }),
  },
  { context: 'world', state: base },
];

describe('input context stack', () => {
  it('gives the keyboard to the topmost layer that is on screen', () => {
    for (const layer of LAYERS) {
      expect(activeInputContext(layer.state), `expected ${layer.context}`).toBe(layer.context);
    }
  });

  it('lets a focused text field win over every game layer', () => {
    for (const layer of LAYERS) {
      expect(activeInputContext(layer.state, true)).toBe('textInput');
    }
  });

  it('blocks every game shortcut behind a full-screen overlay', () => {
    for (const context of ['saveLoad', 'recovery', 'rewardDraft', 'scenarioResult', 'leaveRun', 'loadout', 'runMap', 'textInput'] as const) {
      expect(INPUT_CONTEXT_CAPABILITIES[context], context).toEqual({ build: false, view: false });
    }
  });

  it('keeps the recovery prompt above The Map but below the dialog its error points to', () => {
    const over = state({ recovery: { phase: 'offered' }, runView: 'map' });
    expect(activeInputContext(over)).toBe('recovery');
    expect(activeInputContext({ ...over, savesDialogOpen: true }), 'the full-slots message opens Save / Load over the prompt').toBe('saveLoad');
  });

  it('holds the layer while a resume or keep is in flight, and releases it when idle or still checking', () => {
    for (const phase of ['offered', 'resuming', 'dismissing'] as const) {
      expect(activeInputContext(state({ recovery: { phase } })), phase).toBe('recovery');
      expect(isRecoveryPromptOpen(phase)).toBe(true);
    }
    for (const phase of ['idle', 'checking'] as const) {
      expect(activeInputContext(state({ recovery: { phase } })), phase).toBe('world');
      expect(isRecoveryPromptOpen(phase)).toBe(false);
    }
  });

  it('refuses Ctrl+Z build input behind the prompt, so a stray undo cannot rewind the park under it', () => {
    expect(INPUT_CONTEXT_CAPABILITIES.recovery.build).toBe(false);
  });

  it('keeps the park watchable behind the management panel but arms no hidden tool', () => {
    // The dashboard hides the build dock, so tool keys are refused; the world is still visible,
    // so speed, grid and camera keys are not.
    expect(INPUT_CONTEXT_CAPABILITIES.management).toEqual({ build: false, view: true });
  });

  it('separates the coaster designer from ordinary building, so R never means two things', () => {
    expect(activeInputContext(state({ tool: 'build', selectedDefinitionId: 'comet-trail' })))
      .toBe('coasterDesigner');
    expect(activeInputContext(state({ tool: 'build', selectedDefinitionId: 'petal-roundabout' })))
      .toBe('build');
    expect(INPUT_CONTEXT_CAPABILITIES.coasterDesigner.build).toBe(true);
  });

  describe('menu layer', () => {
    const over = (extra: Partial<InputContextSource>): InputContext => activeInputContext(state({ menuKind: 'start', ...extra }));

    it('sits above every in-game layer, so the park, panels and armed tools are inert behind it', () => {
      expect(over({ managementOpen: true, selectedRide: {} as never, tool: 'build', selectedDefinitionId: 'sunstone-path', clockPopoverOpen: true })).toBe('menu');
      expect(activeInputContext(state({ menuKind: 'pause' }))).toBe('menu');
      expect(activeInputContext(state({ menuKind: null }))).toBe('world');
      expect(INPUT_CONTEXT_CAPABILITIES.menu, 'no tool key, camera key or speed key behind a menu').toEqual({ build: false, view: false });
    });

    it('sits below everything that opens FROM it: The Map, the loadout, Settings, Save / Load, in that order', () => {
      expect(over({ runView: 'map' })).toBe('runMap');
      expect(over({ scenarioPickerOpen: true, loadoutScenarioId: 'garden-gate' })).toBe('loadout');
      expect(over({ scenarioPickerOpen: true, settingsOpen: true })).toBe('settings');
      expect(over({ settingsOpen: true, savesDialogOpen: true })).toBe('saveLoad');
      expect(activeInputContext(state({ menuKind: 'pause', settingsOpen: true }))).toBe('settings');
      expect(activeInputContext(state({ menuKind: 'pause', savesDialogOpen: true }))).toBe('saveLoad');
    });

    it('is below the recovery prompt, which also shows above the start screen', () => {
      expect(over({ recovery: { phase: 'offered' } })).toBe('recovery');
      expect(over({ recovery: { phase: 'resuming' } })).toBe('recovery');
      // an idle or checking controller does not take the keyboard from the menu
      expect(over({ recovery: { phase: 'checking' } })).toBe('menu');
    });

    it('keeps a finished scenario park behind the start screen from opening its result overlay', () => {
      const ended = { scenario: scenario('succeeded'), rewardDraft: ['grand-opening'] };
      expect(over(ended)).toBe('menu');
      // the pause menu cannot coexist with an open result, but if it did the overlay would still win
      expect(activeInputContext(state({ ...ended, menuKind: 'pause' }))).toBe('rewardDraft');
      expect(activeInputContext(state(ended))).toBe('rewardDraft');
    });

    it('still lets a focused text field win', () => {
      expect(activeInputContext(state({ menuKind: 'start' }), true)).toBe('textInput');
    });
  });

  it('treats the bulldozer as a build layer and the pointer as the world', () => {
    expect(activeInputContext(state({ tool: 'bulldoze' }))).toBe('build');
    expect(activeInputContext(state({ tool: 'pointer', selectedDefinitionId: 'petal-roundabout' })))
      .toBe('world');
  });

  it('treats the paint tool like the bulldozer: a build-capability tool, not a new layer, with the keys of a build tool', () => {
    expect(activeInputContext(state({ tool: 'paint' }))).toBe('build');
    expect(INPUT_CONTEXT_CAPABILITIES.build).toEqual({ build: true, view: true });
    // The paint keys are build-not-designer keys: live while painting, dead in the coaster designer and behind any overlay.
    expect(scopeActiveIn('build-not-designer', 'build')).toBe(true);
    expect(scopeActiveIn('build-not-designer', 'coasterDesigner')).toBe(false);
    for (const id of ['paintTool', 'eyedropper'] as const) {
      const def = KEY_ACTION_BY_ID.get(id)!;
      expect(def.scope).toBe('build-not-designer');
      expect(def.yieldsDefault).toBe(true);
      expect(contextsForScope(def.scope)).toEqual(contextsForScope('build-not-designer'));
      expect(contextsForScope(def.scope)).not.toContain('menu');
      expect(contextsForScope(def.scope)).not.toContain('saveLoad');
    }
    // The inspector layer still outranks an armed tool, so Esc closes the inspector first; GameApp closes it when the tool arms.
    expect(activeInputContext(state({ tool: 'paint', selectedRide: {} as never }))).toBe('inspector');
  });

  it("drops back to The Map's overlay once a result is dismissed", () => {
    const dismissed = state({
      scenario: scenario('succeeded'),
      rewardDraft: ['grand-opening'],
      scenarioResultDismissed: true,
      runView: 'map',
    });
    expect(activeInputContext(dismissed)).toBe('runMap');
  });

  it('never shows a result layer while the park is still running', () => {
    expect(activeInputContext(state({ scenario: scenario('running'), tool: 'bulldoze' }))).toBe('build');
  });

  // The reward draft is the only layer Escape refuses to pop, so it must never claim the keyboard
  // unless the overlay can render a card to pick. Otherwise the player is behind a modal with no
  // exit and no accepted choice.
  it('only takes the keyboard for a draft that can actually be rendered', () => {
    const succeeded = scenario('succeeded');
    expect(activeInputContext(state({ scenario: succeeded, rewardDraft: ['grand-opening'] })))
      .toBe('rewardDraft');
    expect(
      activeInputContext(state({ scenario: succeeded, rewardDraft: [] })),
      'an empty draft trapped the player',
    ).toBe('scenarioResult');
    expect(
      activeInputContext(state({ scenario: succeeded, rewardDraft: ['no-such-card'] })),
      'an unrenderable draft trapped the player',
    ).toBe('scenarioResult');
    expect(activeInputContext(state({ scenario: succeeded, rewardDraft: ['no-such-card', 'grand-opening'] })))
      .toBe('rewardDraft');
  });

  it('never leaves a failed park showing a draft', () => {
    expect(activeInputContext(state({ scenario: scenario('failed'), rewardDraft: ['grand-opening'] })))
      .toBe('scenarioResult');
  });

  it('puts the Save / Load dialog above every other layer but a focused text field', () => {
    // Opened over the run map or a result overlay, it must own the keyboard, and the rename
    // field inside it must still win so Escape and typing reach the field.
    expect(activeInputContext(state({ savesDialogOpen: true, scenarioPickerOpen: true }))).toBe('saveLoad');
    expect(activeInputContext(state({ savesDialogOpen: true, scenario: scenario('failed') }))).toBe('saveLoad');
    expect(activeInputContext(state({ savesDialogOpen: true }), true)).toBe('textInput');
    expect(activeInputContext(state({ savesDialogOpen: false }))).toBe('world');
  });

  it('puts the sandbox clock popover above the tool layers so Escape closes only it', () => {
    const armed = { tool: 'build' as const, selectedDefinitionId: 'sunstone-path', clockPopoverOpen: true };
    expect(activeInputContext(state(armed))).toBe('clockPopover');
    expect(activeInputContext(state({ ...armed, managementOpen: true }))).toBe('clockPopover');
    expect(activeInputContext(state({ ...armed, savesDialogOpen: true }))).toBe('saveLoad');
    // A scenario park's popover (forecast only) is a layer too: Escape closes it and nothing below.
    const scenarioPark = { ...armed, scenario: { status: 'running' } as never };
    expect(activeInputContext(state(scenarioPark))).toBe('clockPopover');
    expect(activeInputContext(state({ ...scenarioPark, clockPopoverOpen: false }))).toBe('build');
  });

  it('recognises text-entry elements', () => {
    expect(isTextInputTarget(null)).toBe(false);
    expect(isTextInputTarget({ tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget)).toBe(true);
    expect(isTextInputTarget({ tagName: 'TEXTAREA', isContentEditable: false } as unknown as EventTarget)).toBe(true);
    expect(isTextInputTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTextInputTarget({ tagName: 'BUTTON', isContentEditable: false } as unknown as EventTarget)).toBe(false);
  });

  it('counts only text-like input types as text (a radio, checkbox or range never traps Escape)', () => {
    const input = (type: string) => ({ tagName: 'INPUT', type, isContentEditable: false }) as unknown as EventTarget;
    for (const type of ['text', 'search', 'number', 'email', 'url', 'password', 'tel']) {
      expect(isTextInputTarget(input(type)), type).toBe(true);
    }
    for (const type of ['radio', 'checkbox', 'range', 'button', 'color']) {
      expect(isTextInputTarget(input(type)), type).toBe(false);
    }
  });
});

describe('settings layer', () => {
  it('sits above world, build, inspector, management, clock, runMap, loadout, result and reward', () => {
    expect(activeInputContext(state({ settingsOpen: true }))).toBe('settings');
    expect(activeInputContext(state({ settingsOpen: true, scenarioPickerOpen: true }))).toBe('settings');
    expect(activeInputContext(state({ settingsOpen: true, scenario: scenario('failed') }))).toBe('settings');
    expect(activeInputContext(state({ settingsOpen: true, managementOpen: true, selectedRide: {} as never }))).toBe('settings');
  });

  it('sits below Save / Load and the recovery prompt (including in flight), and below a focused text field', () => {
    expect(activeInputContext(state({ settingsOpen: true, savesDialogOpen: true }))).toBe('saveLoad');
    for (const phase of ['offered', 'resuming', 'dismissing'] as const) {
      expect(activeInputContext(state({ settingsOpen: true, recovery: { phase } })), phase).toBe('recovery');
    }
    expect(activeInputContext(state({ settingsOpen: true }), true)).toBe('textInput');
  });

  it('has neither build nor view capability, and refuses the peek key', () => {
    expect(INPUT_CONTEXT_CAPABILITIES.settings).toEqual({ build: false, view: false });
    const press: PeekKeyEvent = { type: 'keydown', key: 'x', repeat: false, ctrlKey: false, metaKey: false, altKey: false };
    expect(planPeekKey(press, 'settings')).toBe('ignore');
  });

  it('closing it reveals exactly the layer that was below', () => {
    const below = state({ runView: 'map', managementOpen: true });
    expect(activeInputContext({ ...below, settingsOpen: true })).toBe('settings');
    expect(activeInputContext({ ...below, settingsOpen: false })).toBe('runMap');
  });
});

describe('planPeekKey', () => {
  const key = (overrides: Partial<PeekKeyEvent> = {}): PeekKeyEvent => ({
    type: 'keydown', key: 'x', repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...overrides,
  });

  it('presses on the first x keydown in every context with the build capability', () => {
    for (const [context, caps] of Object.entries(INPUT_CONTEXT_CAPABILITIES)) {
      expect(planPeekKey(key(), context as InputContext)).toBe(caps.build ? 'press' : 'ignore');
    }
    expect(planPeekKey(key({ key: 'X' }), 'world')).toBe('press');
  });

  it('ignores repeats, modifiers and other keys', () => {
    expect(planPeekKey(key({ repeat: true }), 'world')).toBe('ignore');
    expect(planPeekKey(key({ ctrlKey: true }), 'world')).toBe('ignore');
    expect(planPeekKey(key({ metaKey: true }), 'world')).toBe('ignore');
    expect(planPeekKey(key({ altKey: true }), 'world')).toBe('ignore');
    expect(planPeekKey(key({ key: 'z' }), 'world')).toBe('ignore');
  });

  it('never presses in text inputs, modals or management', () => {
    for (const context of ['textInput', 'saveLoad', 'recovery', 'rewardDraft', 'scenarioResult', 'leaveRun', 'loadout', 'runMap', 'management'] as const) {
      expect(planPeekKey(key(), context)).toBe('ignore');
    }
  });

  it('always releases on any x keyup, whatever the context or modifiers', () => {
    for (const context of Object.keys(INPUT_CONTEXT_CAPABILITIES) as InputContext[]) {
      expect(planPeekKey(key({ type: 'keyup' }), context)).toBe('release');
      expect(planPeekKey(key({ type: 'keyup', ctrlKey: true, altKey: true }), context)).toBe('release');
    }
    expect(planPeekKey(key({ type: 'keyup', key: 'y' }), 'world')).toBe('ignore');
  });
});

describe('key scopes versus the capability table', () => {
  const SCOPES: KeyScope[] = ['view', 'build', 'build-not-designer', 'designer'];

  it('scopesOverlap agrees with the context sets derived from INPUT_CONTEXT_CAPABILITIES', () => {
    for (const a of SCOPES) {
      for (const b of SCOPES) {
        const shared = contextsForScope(a).filter((context) => contextsForScope(b).includes(context));
        expect(scopesOverlap(a, b), `${a} vs ${b}`).toBe(shared.length > 0);
      }
    }
  });

  it('every build context also has view, so a view key is never blocked where a build key works', () => {
    for (const context of contextsForScope('build')) expect(contextsForScope('view')).toContain(context);
  });

  it('scopeActiveIn matches the derived sets, and every action scope is a known one', () => {
    for (const scope of SCOPES) {
      for (const context of Object.keys(INPUT_CONTEXT_CAPABILITIES) as InputContext[]) {
        expect(scopeActiveIn(scope, context)).toBe(contextsForScope(scope).includes(context));
      }
    }
    for (const def of KEY_ACTIONS) expect(SCOPES).toContain(def.scope);
  });

  it('recentre (Phase 11) is a view key: live in the park and the inspector, dead behind overlays and menus', () => {
    const def = KEY_ACTION_BY_ID.get('recentreView')!;
    expect(def.scope).toBe('view');
    expect(def.yieldsDefault).toBe(true);
    const contexts = contextsForScope(def.scope);
    for (const live of ['world', 'build', 'inspector', 'coasterDesigner'] as const) expect(contexts).toContain(live);
    for (const dead of ['menu', 'settings', 'saveLoad', 'textInput'] as const) expect(contexts).not.toContain(dead);
  });

  it('the inspector layer (where Delete asks to demolish) sits above an armed tool and below every overlay', () => {
    const ride = { selectedRide: {} as never };
    expect(activeInputContext(state({ ...ride, tool: 'bulldoze' }))).toBe('inspector');
    expect(activeInputContext(state({ ...ride, managementOpen: true }))).toBe('management');
    expect(activeInputContext(state({ ...ride, settingsOpen: true }))).toBe('settings');
    expect(activeInputContext(state(ride), true)).toBe('textInput');
  });
});

describe('planPeekKey with a rebound key', () => {
  const press = (key: string, extra: Partial<PeekKeyEvent> = {}): PeekKeyEvent => ({
    type: 'keydown', key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra,
  });

  it('follows the binding for press and release and ignores the old key', () => {
    const overrides = { peek: 'k:v' };
    expect(planPeekKey(press('v'), 'world', overrides)).toBe('press');
    expect(planPeekKey(press('x'), 'world', overrides)).toBe('ignore');
    expect(planPeekKey(press('v', { type: 'keyup', ctrlKey: true }), 'settings', overrides)).toBe('release');
    expect(planPeekKey(press('x', { type: 'keyup' }), 'world', overrides)).toBe('ignore');
  });

  it('an unbound peek never presses or releases', () => {
    expect(planPeekKey(press('x'), 'world', { peek: null })).toBe('ignore');
    expect(planPeekKey(press('x', { type: 'keyup' }), 'world', { peek: null })).toBe('ignore');
  });

  it('matches by character, so Dvorak and AZERTY players hold the printed key', () => {
    expect(planPeekKey(press('x', { code: 'KeyB' }), 'world', {})).toBe('press');
  });
});

describe('The Map layers (Phase 23)', () => {
  it('a park on The Map never shows the Scenario result overlay: the run screens are its result', () => {
    const finished = state({ scenario: scenario('succeeded'), rewardDraft: ['grand-opening'], sessionMode: 'run', tool: 'pointer' });
    expect(activeInputContext(finished)).toBe('world');
    expect(activeInputContext({ ...finished, runView: 'stage-result' })).toBe('runMap');
    // The same finished park in Scenario mode still owns the keyboard with its result.
    expect(activeInputContext({ ...finished, sessionMode: 'scenario' })).toBe('rewardDraft');
  });

  it('the run overlay opens from the menu, so it sits above it; the Scenario loadout too', () => {
    expect(activeInputContext(state({ menuKind: 'pause', runView: 'map' }))).toBe('runMap');
    expect(activeInputContext(state({ menuKind: 'pause', runView: 'map', scenarioPickerOpen: true, loadoutScenarioId: 'garden-gate' }))).toBe('loadout');
    expect(activeInputContext(state({ menuKind: 'start' }))).toBe('menu');
  });

  it('the leave-run question outranks the menu and the run map, and yields to Settings, Save / Load and the recovery prompt', () => {
    const asked = state({ menuKind: 'start', runView: 'map', leaveRunPrompt: { reason: 'new-run' } });
    expect(activeInputContext(asked)).toBe('leaveRun');
    expect(activeInputContext({ ...asked, settingsOpen: true })).toBe('settings');
    expect(activeInputContext({ ...asked, savesDialogOpen: true })).toBe('saveLoad');
    expect(activeInputContext({ ...asked, recovery: { phase: 'offered' } })).toBe('recovery');
    expect(activeInputContext(state({ menuKind: 'start', leaveRunPrompt: null }))).toBe('menu');
  });

  it('both layers take the whole keyboard', () => {
    for (const context of ['runMap', 'leaveRun'] as const) {
      expect(INPUT_CONTEXT_CAPABILITIES[context]).toEqual({ build: false, view: false });
    }
  });
});

describe('Phase 30: the guest inspector shares the inspector layer', () => {
  it('a selected guest is the inspector context, below management and above an armed tool; absent reads as none', () => {
    const guest = { id: 1 } as unknown as NonNullable<InputContextSource['selectedGuest']>;
    expect(activeInputContext({ ...base, selectedGuest: guest })).toBe('inspector');
    expect(activeInputContext({ ...base, selectedGuest: guest, tool: 'build', selectedDefinitionId: 'sunstone-path' })).toBe('inspector');
    expect(activeInputContext({ ...base, selectedGuest: guest, managementOpen: true })).toBe('management');
    expect(activeInputContext({ ...base, selectedGuest: null })).toBe(activeInputContext(base));
  });
});
