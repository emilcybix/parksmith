import { describe, expect, it } from 'vitest';
import type { SaveSlotMeta } from '../app/saves/types';
import {
  QUIT_CHOICES,
  bootMenuDecision,
  buildPauseMenu,
  buildStartMenu,
  continueUnavailable,
  describeContinue,
  describeUnreadableLatest,
  latestSave,
  menuEscapeStep,
  moveMenuFocus,
  planQuit,
  readableSlots,
  slotsNewestFirst,
  WAITING_FOR_RECOVERY,
  WAITING_FOR_SAVES,
  type StartMenuInput,
} from './menuModel';

const NOW = 10_000_000;

const meta = (id: SaveSlotMeta['id'], overrides: Partial<SaveSlotMeta> = {}): SaveSlotMeta => ({
  id,
  kind: id === 'autosave' ? 'auto' : 'manual',
  name: id === 'autosave' ? 'Autosave' : `Park ${id}`,
  scenarioId: null,
  scenarioName: 'Sandbox park',
  playtimeSeconds: 725,
  savedAt: NOW - 5 * 60_000,
  schemaVersion: 4,
  contentVersion: 2,
  savedAtTick: 100,
  guestCount: 342,
  cash: 12_340,
  rating: 78.4,
  sizeBytes: 1000,
  revision: 3,
  writerTabId: 'tab',
  status: { state: 'ok' },
  ...overrides,
});

const input = (overrides: Partial<StartMenuInput> = {}): StartMenuInput => ({
  slots: [],
  listState: 'ready',
  recoveryPhase: 'idle',
  busy: false,
  previewPhase: 'ready',
  now: NOW,
  ...overrides,
});

describe('latest save', () => {
  it('is the newest readable slot, autosave first on a tie, and never an unreadable record', () => {
    const slots = [
      meta('autosave', { savedAt: 500 }),
      meta('manual-1', { savedAt: 900 }),
      meta('manual-2', { savedAt: 900 }),
      meta('manual-3', { savedAt: 2_000, status: { state: 'unreadable', code: 'corrupt', message: 'bad' } }),
    ];
    expect(latestSave(slots)?.id).toBe('manual-1');
    expect(slotsNewestFirst(slots).map((slot) => slot.id)).toEqual(['manual-1', 'manual-2', 'autosave']);
    expect(readableSlots(slots)).toHaveLength(3);
    expect(latestSave([meta('autosave', { savedAt: 900 }), meta('manual-1', { savedAt: 900 })])?.id).toBe('autosave');
    expect(latestSave([])).toBeNull();
    expect(latestSave([meta('autosave', { status: { state: 'unreadable', code: 'corrupt', message: 'x' } })])).toBeNull();
  });

  it('ignores a slot whose time is not a number', () => {
    expect(latestSave([meta('autosave', { savedAt: Number.NaN })])).toBeNull();
  });

  it('describes the save by its age and key numbers', () => {
    const card = describeContinue(meta('autosave'), NOW);
    expect(card.title).toBe('Sandbox park');
    expect(card.subtitle, 'a record from before Phase 24 reads as the Meadow Garden').toBe('Sandbox · Meadow Garden · Autosave · 5 min ago');
    expect(card.stats).toEqual([
      { label: 'Guests', value: '342' },
      { label: 'Cash', value: '$12,340' },
      { label: 'Rating', value: '78' },
      { label: 'Park time', value: '12m 05s' },
    ]);
    expect(describeContinue(meta('manual-2', { name: 'Big wheel', scenarioName: '' }), NOW).title).toBe('Big wheel');
    expect(describeContinue(meta('manual-2', { name: 'Big wheel' }), NOW).subtitle).toBe('Sandbox · Meadow Garden · Big wheel · 5 min ago');
    expect(describeContinue(meta('manual-2', { name: 'Sandbox park' }), NOW).subtitle, 'a default name is not repeated').toBe('Sandbox · Meadow Garden · 5 min ago');
  });

  it('names the map of a sandbox, and of a scenario only when it is not the Meadow Garden (Phase 24)', () => {
    expect(describeContinue(meta('autosave', { mapName: 'Red Rock Canyon', biomeName: 'Desert Canyon' }), NOW).subtitle)
      .toBe('Sandbox · Red Rock Canyon · Autosave · 5 min ago');
    expect(describeContinue(meta('autosave', { scenarioId: 'garden-gala', scenarioName: 'Garden Gala', mapName: 'Meadow Garden' }), NOW).subtitle)
      .toBe('Scenario · Garden Gala · Autosave · 5 min ago');
    expect(describeContinue(meta('autosave', { scenarioId: 'garden-gala', scenarioName: 'Garden Gala' }), NOW).subtitle, 'an old scenario record')
      .toBe('Scenario · Garden Gala · Autosave · 5 min ago');
    expect(describeContinue(meta('autosave', { scenarioId: 'garden-gala', scenarioName: 'Garden Gala', mapName: 'Frosted Hollow' }), NOW).subtitle)
      .toBe('Scenario · Garden Gala · Frosted Hollow · Autosave · 5 min ago');
    expect(describeContinue(meta('autosave', { mapName: 'Custom map' }), NOW).subtitle).toContain('Custom map');
    expect(describeContinue(meta('autosave', { mapName: '  ' as string }), NOW).subtitle, 'a blank name falls back').toContain('Meadow Garden');
  });
});

describe('start menu', () => {
  it('Sandbox opens the map picker (its detail says so)', () => {
    const item = buildStartMenu(input()).items.find((entry) => entry.id === 'sandbox');
    expect(item?.label).toBe('Sandbox');
    expect(item?.detail).toBe('Build freely on any map');
  });

  const ids = (model: ReturnType<typeof buildStartMenu>): string[] => model.items.map((item) => item.id);

  it('leads with Continue, focused by default, when a save exists', () => {
    const model = buildStartMenu(input({ slots: [meta('autosave')] }));
    expect(ids(model)).toEqual(['continue', 'the-map', 'scenarios', 'sandbox', 'load', 'collection', 'settings', 'about']);
    expect(model.defaultFocus).toBe('continue');
    expect(model.items[0]).toMatchObject({ primary: true, unavailable: null });
    expect(model.items[0].detail).toBe('Sandbox · Meadow Garden · Autosave · 5 min ago');
    expect(model.continueCard?.slotId).toBe('autosave');
  });

  it('leads with The Map and offers no Continue when there is no save', () => {
    const model = buildStartMenu(input());
    expect(ids(model)).toEqual(['the-map', 'scenarios', 'sandbox', 'load', 'collection', 'settings', 'about']);
    expect(model.defaultFocus).toBe('the-map');
    expect(model.items[0].primary).toBe(true);
    expect(model.continueCard).toBeNull();
    // an unreadable record is not a park to continue
    expect(ids(buildStartMenu(input({ slots: [meta('autosave', { status: { state: 'unreadable', code: 'corrupt', message: 'x' } })] })))[0]).toBe('the-map');
  });

  it('keeps Continue listed but waiting while recovery is undecided, the list is read or a load runs', () => {
    const slots = [meta('autosave')];
    const waiting = (overrides: Partial<StartMenuInput>): string | null => buildStartMenu(input({ slots, ...overrides })).items[0].unavailable;
    expect(waiting({ recoveryPhase: 'offered' })).toBe(WAITING_FOR_RECOVERY);
    expect(waiting({ recoveryPhase: 'resuming' })).toBe(WAITING_FOR_RECOVERY);
    expect(waiting({ recoveryPhase: 'checking' })).toBe(WAITING_FOR_SAVES);
    expect(waiting({ listState: 'loading' })).toBe(WAITING_FOR_SAVES);
    expect(waiting({ previewPhase: 'checking' })).toBe(WAITING_FOR_SAVES);
    expect(waiting({ busy: true })).toMatch(/Loading/);
    expect(waiting({})).toBeNull();
    // focus does not jump: the default stays Continue throughout
    expect(buildStartMenu(input({ slots, recoveryPhase: 'offered' })).defaultFocus).toBe('continue');
  });

  it('holds the other park choices back while the recovery question is open', () => {
    const model = buildStartMenu(input({ slots: [meta('autosave')], recoveryPhase: 'offered' }));
    const byId = new Map(model.items.map((item) => [item.id, item]));
    for (const id of ['the-map', 'scenarios', 'sandbox', 'load'] as const) expect(byId.get(id)?.unavailable, id).toBe(WAITING_FOR_RECOVERY);
    expect(byId.get('settings')?.unavailable).toBeNull();
    expect(byId.get('about')?.unavailable).toBeNull();
    expect(continueUnavailable(input({ recoveryPhase: 'dismissing' }))).toBe(WAITING_FOR_RECOVERY);
  });
});

describe('pause menu', () => {
  it('lists Resume, Save, Load, Settings, Parks, Collection, About and feedback (Phase 19) and Quit to menu with Resume focused', () => {
    const model = buildPauseMenu({ quickSaveSlotId: 'manual-2', persistence: 'ready', unsavedChanges: false });
    expect(model.items.map((item) => item.id)).toEqual(['resume', 'save', 'load', 'settings', 'parks', 'collection', 'about', 'quit']);
    expect(model.items.map((item) => item.label)).toEqual(['Resume', 'Save', 'Load', 'Settings', 'Parks', 'Collection', 'About and feedback', 'Quit to menu']);
    expect(model.defaultFocus).toBe('resume');
    expect(model.items[1].detail).toBe('Quick save to slot 2');
    expect(model.items[4].detail).toBe('Sandbox, Scenario or The Map');
    expect(model.items[6].detail).toMatch(/^v\d+\.\d+\.\d+/);
    expect(model.items[7].detail).toBeNull();
  });

  it('says what Save does when slots are full or storage is down, and flags unsaved changes on Quit', () => {
    const full = buildPauseMenu({ quickSaveSlotId: null, persistence: 'ready', unsavedChanges: true });
    expect(full.items[1].detail).toMatch(/slot is taken|Every slot/);
    expect(full.items[7].detail).toBe('You have unsaved changes');
    expect(buildPauseMenu({ quickSaveSlotId: 'manual-1', persistence: 'unavailable', unsavedChanges: false }).items[1].detail).toMatch(/this session only/);
  });
});

describe('quit, keys and escape', () => {
  it('asks before leaving a park with unsaved changes, and offers save, discard and cancel', () => {
    expect(planQuit(true)).toBe('confirm');
    expect(planQuit(false)).toBe('quit-now');
    expect(QUIT_CHOICES.map((choice) => choice.id)).toEqual(['save', 'discard', 'cancel']);
  });

  it('moves focus with the arrows, wraps, and ignores other keys', () => {
    const list = ['a', 'b', 'c'];
    expect(moveMenuFocus(list, 'a', 'ArrowDown')).toBe('b');
    expect(moveMenuFocus(list, 'c', 'ArrowDown')).toBe('a');
    expect(moveMenuFocus(list, 'a', 'ArrowUp')).toBe('c');
    expect(moveMenuFocus(list, 'b', 'Home')).toBe('a');
    expect(moveMenuFocus(list, 'b', 'End')).toBe('c');
    expect(moveMenuFocus(list, null, 'ArrowDown')).toBe('a');
    expect(moveMenuFocus(list, null, 'ArrowUp')).toBe('c');
    expect(moveMenuFocus(list, 'zzz', 'ArrowDown')).toBe('a');
    expect(moveMenuFocus(list, 'a', 'Enter')).toBeNull();
    expect(moveMenuFocus([], 'a', 'ArrowDown')).toBeNull();
  });

  it('maps Escape: panels step back, the pause menu resumes, the start screen has no exit', () => {
    expect(menuEscapeStep('start', 'main')).toBe('none');
    expect(menuEscapeStep('start', 'about')).toBe('back');
    expect(menuEscapeStep('start', 'new-park'), 'Escape leaves the picker for the list').toBe('back');
    expect(menuEscapeStep('pause', 'main')).toBe('resume');
    expect(menuEscapeStep('pause', 'quit')).toBe('back');
    expect(menuEscapeStep('pause', 'about')).toBe('back');
  });
});

describe('boot decision', () => {
  const base = { enabled: true, isFirstRun: false, developerMode: false, hasSlots: true };
  it('shows the menu by default, including in developer mode', () => {
    expect(bootMenuDecision(base)).toBe('menu');
    expect(bootMenuDecision({ ...base, developerMode: true })).toBe('menu');
    expect(bootMenuDecision({ ...base, hasSlots: false })).toBe('menu');
  });
  it('keeps the Phase 13 first-run flow: no profile and no saves skips the menu (unless developer mode)', () => {
    expect(bootMenuDecision({ ...base, isFirstRun: true, hasSlots: false })).toBe('skip');
    expect(bootMenuDecision({ ...base, isFirstRun: true, hasSlots: false, developerMode: true })).toBe('menu');
    // a save without a profile is an existing player
    expect(bootMenuDecision({ ...base, isFirstRun: true, hasSlots: true })).toBe('menu');
  });
  it('&menu=0 always skips', () => {
    expect(bootMenuDecision({ ...base, enabled: false })).toBe('skip');
    expect(bootMenuDecision({ ...base, enabled: false, developerMode: true })).toBe('skip');
  });
});

describe('unreadable latest save message', () => {
  it('names the save and what is shown instead', () => {
    expect(describeUnreadableLatest(['Autosave'], null)).toBe('Your latest save “Autosave” could not be read. It stays in Save / Load, marked unreadable.');
    expect(describeUnreadableLatest(['Autosave'], 'Big wheel')).toContain('shows “Big wheel” instead');
    expect(describeUnreadableLatest(['A', 'B'], null)).toBe('Your 2 latest saves could not be read. They stay in Save / Load, marked unreadable.');
  });
});

describe('Continue with two autosave generations (Phase 31)', () => {
  const previous = (overrides: Partial<SaveSlotMeta> = {}): SaveSlotMeta => meta('autosave-previous', { kind: 'auto', name: 'Autosave', savedAt: NOW - 10 * 60_000, ...overrides });
  const broken = meta('autosave', { status: { state: 'unreadable', code: 'corrupt', message: 'bad' } });

  it('continues the autosave, never its previous generation beside it', () => {
    const slots = [meta('autosave'), previous({ savedAt: NOW })];
    expect(latestSave(slots)?.id, 'even with a clock that says otherwise').toBe('autosave');
    expect(readableSlots(slots).map((slot) => slot.id)).toEqual(['autosave']);
  });

  it('falls back to the previous generation when the autosave is unreadable or gone', () => {
    expect(latestSave([broken, previous()])?.id, 'unreadable').toBe('autosave-previous');
    expect(latestSave([previous(), meta('manual-1', { savedAt: NOW - 60 * 60_000 })])?.id, 'quarantined').toBe('autosave-previous');
    expect(latestSave([broken, previous(), meta('manual-1', { savedAt: NOW - 60_000 })])?.id, 'a newer manual save still wins').toBe('manual-1');
  });

  it('names the previous generation on the Continue card', () => {
    expect(describeContinue(previous(), NOW).subtitle).toBe('Sandbox · Meadow Garden · Previous autosave · 10 min ago');
    expect(buildStartMenu(input({ slots: [broken, previous()] })).continueCard?.slotId).toBe('autosave-previous');
  });
});
