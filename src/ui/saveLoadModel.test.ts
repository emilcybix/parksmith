import { describe, expect, it } from 'vitest';
import { MANUAL_SLOT_IDS, SAVE_NAME_MAX_LENGTH } from '../app/saves/constants';
import type { PersistenceStatus, SaveFailureCode, SaveSlotMeta, SavesSnapshot, UnreadableCode } from '../app/saves/types';
import { DEFAULT_SAVES_SNAPSHOT } from './store';
import {
  buildSlotRows,
  describeAutosaveFooter,
  describeAutosavePause,
  describeDeleteConfirm,
  describeLoadResult,
  describePersistenceBanner,
  describeSaveFailure,
  describeUnreadableCode,
  escapeStep,
  formatCash,
  formatLastPlayed,
  formatPlaytime,
  indicatorDelayMs,
  indicatorLabel,
  interactionReducer,
  isManualSlotId,
  isRecoveredSlot,
  NO_INTERACTION,
  planLoad,
  planQuickSaveShortcut,
  planRename,
  planSave,
  rowActions,
  rowDisplayName,
  rowModeLabel,
  rowTag,
  sanitizeSaveName,
  type RowContext,
  type ShortcutKey,
} from './saveLoadModel';

const meta = (id: SaveSlotMeta['id'], overrides: Partial<SaveSlotMeta> = {}): SaveSlotMeta => ({
  id,
  kind: id === 'autosave' ? 'auto' : 'manual',
  name: `Park in ${id}`,
  scenarioId: null,
  scenarioName: 'Sandbox park',
  playtimeSeconds: 125,
  savedAt: 1_000_000,
  schemaVersion: 1,
  contentVersion: 1,
  savedAtTick: 10,
  guestCount: 12,
  cash: 4500,
  rating: 61.4,
  sizeBytes: 1000,
  revision: 1,
  writerTabId: 'tab',
  status: { state: 'ok' },
  ...overrides,
});

const unreadable = (id: SaveSlotMeta['id'], code: UnreadableCode = 'corrupt'): SaveSlotMeta => (
  meta(id, { status: { state: 'unreadable', code, message: 'bad' } })
);

const idle: RowContext = { busy: false, persistenceUnavailable: false };

describe('slot rows', () => {
  it('lists autosave first, then every manual slot in order, empty or not', () => {
    const rows = buildSlotRows([meta('manual-3'), meta('autosave')]);
    expect(rows.map((row) => row.slotId)).toEqual(['autosave', ...MANUAL_SLOT_IDS]);
    expect(rows[0].meta?.id).toBe('autosave');
    expect(rows[3].meta?.id, 'manual-3 sits at index 3').toBe('manual-3');
    expect(rows[1].meta, 'empty slot keeps its row').toBeNull();
    expect(rows[1].label).toBe('Slot 1');
  });

  it('keeps an empty autosave row and does not depend on input order', () => {
    const rows = buildSlotRows([meta('manual-10'), meta('manual-1')]);
    expect(rows[0].slotId).toBe('autosave');
    expect(rows[0].meta).toBeNull();
    expect(rows[1].meta?.id).toBe('manual-1');
    expect(rows[10].meta?.id).toBe('manual-10');
  });

  it('appends records with an unknown id instead of hiding them', () => {
    const orphan = unreadable('manual-99' as never, 'record-corrupt');
    const rows = buildSlotRows([orphan]);
    expect(rows).toHaveLength(1 + MANUAL_SLOT_IDS.length + 1);
    expect(rows[rows.length - 1].meta).toBe(orphan);
    expect(rows[rows.length - 1].label).toBe('manual-99');
  });
});

describe('slot ids', () => {
  it('tells manual slots from the autosave and from unknown ids', () => {
    expect(isManualSlotId('manual-4')).toBe(true);
    expect(isManualSlotId('autosave')).toBe(false);
    expect(isManualSlotId('manual-99' as never)).toBe(false);
  });
});

describe('row actions', () => {
  const rowFor = (slot: SaveSlotMeta | null, id: SaveSlotMeta['id'] = 'manual-1') => (
    buildSlotRows(slot ? [slot] : []).find((row) => row.slotId === id)!
  );

  it('offers an unreadable slot only Delete: never Save over it, never Load it', () => {
    const actions = rowActions(rowFor(unreadable('manual-1')), idle);
    expect(actions.canSave, 'save over a damaged record').toBe(false);
    expect(actions.canLoad).toBe(false);
    expect(actions.showRename).toBe(false);
    expect(actions.canDelete).toBe(true);
    expect(actions.saveHint).toContain('cannot be read');
  });

  it('does not offer Save on the autosave row, and lets nothing act on an empty slot but Save', () => {
    const auto = rowActions(rowFor(meta('autosave'), 'autosave'), idle);
    expect(auto.showSave).toBe(false);
    expect(auto.canLoad).toBe(true);
    expect(auto.showRename).toBe(false);
    const empty = rowActions(rowFor(null), idle);
    expect(empty.canSave).toBe(true);
    expect(empty.canLoad).toBe(false);
    expect(empty.canDelete).toBe(false);
  });

  it('disables every action while an operation is in flight, and Save while persistence is down', () => {
    const row = rowFor(meta('manual-1'));
    const busy = rowActions(row, { busy: true, persistenceUnavailable: false });
    expect([busy.canSave, busy.canLoad, busy.canRename, busy.canDelete]).toEqual([false, false, false, false]);
    const down = rowActions(row, { busy: false, persistenceUnavailable: true });
    expect(down.canSave).toBe(false);
    expect(down.canLoad, 'loading an already stored save may still work').toBe(true);
  });
});

describe('plans', () => {
  const row = (slot: SaveSlotMeta | null) => buildSlotRows(slot ? [slot] : [])[1];

  it('saves into an empty slot at once, asks before replacing, and refuses an unreadable one', () => {
    expect(planSave(row(null))).toBe('save-now');
    expect(planSave(row(meta('manual-1')))).toBe('confirm-overwrite');
    expect(planSave(row(unreadable('manual-1')))).toBe('blocked');
  });

  it('asks before loading only when the live park has unsaved changes', () => {
    expect(planLoad(row(meta('manual-1')), false)).toBe('load-now');
    expect(planLoad(row(meta('manual-1')), true)).toBe('confirm-load');
    expect(planLoad(row(null), true)).toBe('blocked');
    expect(planLoad(row(unreadable('manual-1')), false)).toBe('blocked');
  });

  it('renames only to a usable, different name', () => {
    expect(planRename('  New   name ', 'Old')).toBe('New name');
    expect(planRename('   ', 'Old')).toBeNull();
    expect(planRename('Old', 'Old')).toBeNull();
  });
});

describe('confirmation state machine', () => {
  const slots = [meta('manual-1'), meta('manual-2')];

  it('holds one interaction at a time: starting another replaces the first', () => {
    let state = interactionReducer(NO_INTERACTION, { type: 'confirm-delete', slotId: 'manual-1' });
    expect(state).toEqual({ kind: 'confirm-delete', slotId: 'manual-1' });
    state = interactionReducer(state, { type: 'confirm-overwrite', slotId: 'manual-2' });
    expect(state).toEqual({ kind: 'confirm-overwrite', slotId: 'manual-2' });
    expect(interactionReducer(state, { type: 'cancel' })).toEqual(NO_INTERACTION);
  });

  it('edits a rename draft within the length limit and ignores edits outside a rename', () => {
    const long = 'x'.repeat(SAVE_NAME_MAX_LENGTH + 20);
    let state = interactionReducer(NO_INTERACTION, { type: 'rename-start', slotId: 'manual-1', name: long });
    expect(state.kind === 'rename' && state.draft.length, 'start').toBe(SAVE_NAME_MAX_LENGTH);
    state = interactionReducer(state, { type: 'rename-edit', draft: long + 'y' });
    expect(state.kind === 'rename' && state.draft.length, 'edit').toBe(SAVE_NAME_MAX_LENGTH);
    expect(interactionReducer(NO_INTERACTION, { type: 'rename-edit', draft: 'a' })).toBe(NO_INTERACTION);
  });

  it('drops an interaction whose slot disappeared, keeps one whose slot is still listed', () => {
    const del = interactionReducer(NO_INTERACTION, { type: 'confirm-delete', slotId: 'manual-2' });
    expect(interactionReducer(del, { type: 'slots-changed', slots })).toBe(del);
    expect(interactionReducer(del, { type: 'slots-changed', slots: [meta('manual-1')] })).toEqual(NO_INTERACTION);
  });

  it('peels Escape in order: rename or confirmation first, then the dialog', () => {
    expect(escapeStep(NO_INTERACTION)).toBe('close-dialog');
    for (const action of [
      { type: 'confirm-overwrite', slotId: 'manual-1' },
      { type: 'confirm-delete', slotId: 'manual-1' },
      { type: 'confirm-load', slotId: 'manual-1' },
      { type: 'rename-start', slotId: 'manual-1', name: 'a' },
    ] as const) {
      const state = interactionReducer(NO_INTERACTION, action);
      expect(escapeStep(state), action.type).toBe('cancel-interaction');
      expect(escapeStep(interactionReducer(state, { type: 'cancel' })), action.type).toBe('close-dialog');
    }
  });
});

describe('formatting', () => {
  it('formats park time', () => {
    expect(formatPlaytime(0)).toBe('0m 00s');
    expect(formatPlaytime(125.9)).toBe('2m 05s');
    expect(formatPlaytime(3600)).toBe('1h 00m');
    expect(formatPlaytime(3600 * 12 + 61)).toBe('12h 01m');
    expect(formatPlaytime(-5)).toBe('0m 00s');
    expect(formatPlaytime(Number.NaN)).toBe('0m 00s');
  });

  it('formats last played relative to now', () => {
    const now = 1_000_000_000_000;
    const ago = (ms: number) => formatLastPlayed(now - ms, now);
    expect(ago(5_000)).toBe('just now');
    expect(ago(-60_000), 'saved in the future').toBe('just now');
    expect(ago(50_000)).toBe('1 min ago');
    expect(ago(5 * 60_000)).toBe('5 min ago');
    expect(ago(3 * 3_600_000)).toBe('3 h ago');
    expect(ago(30 * 3_600_000)).toBe('yesterday');
    expect(ago(5 * 86_400_000)).toBe('5 days ago');
    expect(ago(90 * 86_400_000)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatLastPlayed(0, now)).toBe('unknown');
    expect(formatLastPlayed(Number.NaN, now)).toBe('unknown');
  });

  it('formats cash and sanitizes names', () => {
    expect(formatCash(1234567.4)).toBe('$1,234,567');
    expect(formatCash(Number.NaN)).toBe('$0');
    expect(sanitizeSaveName('  a \n  b ')).toBe('a b');
    expect(sanitizeSaveName('')).toBeNull();
    expect(sanitizeSaveName('z'.repeat(100))).toBe('z'.repeat(SAVE_NAME_MAX_LENGTH));
  });
});

describe('failure words', () => {
  it('has a sentence for every code and chip label for every unreadable code', () => {
    const codes: SaveFailureCode[] = [
      'unavailable', 'blocked', 'quota', 'corrupt', 'not-found', 'conflict', 'unreadable-slot', 'unknown',
      'not-a-save', 'too-new', 'no-migration-path', 'migration-failed', 'invalid-state', 'unsynced',
      'content-mismatch', 'seal-failed', 'busy', 'not-ready', 'no-park', 'slot-unreadable', 'invalid-slot',
      'worker-failed',
    ];
    for (const code of codes) expect(describeSaveFailure(code).length, code).toBeGreaterThan(10);
    expect(describeSaveFailure('quota')).toContain('full');
    for (const code of ['corrupt', 'too-new', 'meta-corrupt', 'payload-missing', 'content-mismatch'] as UnreadableCode[]) {
      expect(describeUnreadableCode(code).length, code).toBeGreaterThan(2);
    }
  });
});

describe('banner and indicator', () => {
  const persistence = (overrides: Partial<PersistenceStatus>): PersistenceStatus => (
    { ...DEFAULT_SAVES_SNAPSHOT.persistence, ...overrides }
  );

  it('stays silent while checking or ready, and when dismissed (except the dialog copy)', () => {
    expect(describePersistenceBanner(persistence({ state: 'checking' }))).toBeNull();
    expect(describePersistenceBanner(persistence({ state: 'ready' }))).toBeNull();
    const down = persistence({ state: 'unavailable', code: 'quota' });
    expect(describePersistenceBanner(down)?.message).toContain('storage is full');
    expect(describePersistenceBanner({ ...down, bannerDismissed: true })).toBeNull();
    expect(describePersistenceBanner({ ...down, bannerDismissed: true }, true)).not.toBeNull();
    expect(describePersistenceBanner(persistence({ state: 'unavailable', code: 'blocked' }))?.message).toContain('close other Parksmith tabs');
    expect(describePersistenceBanner(persistence({ state: 'unavailable', code: null }))?.canRetry).toBe(true);
  });

  const snapshot = (overrides: Partial<SavesSnapshot>): SavesSnapshot => ({ ...DEFAULT_SAVES_SNAPSHOT, ...overrides });

  it('tells an unreadable autosave slot from another tab taking over', () => {
    const suspended = { state: 'suspended', indicator: 'hidden', lastSavedAt: null } as const;
    expect(describeAutosavePause(snapshot({}))).toBeNull();
    expect(describeAutosavePause(snapshot({ autosave: suspended }))?.cause).toBe('other-tab');
    expect(describeAutosavePause(snapshot({ autosave: suspended, slots: [unreadable('autosave')] }))?.cause).toBe('unreadable-slot');
    const down = persistence({ state: 'unavailable', code: 'unavailable' });
    expect(describeAutosavePause(snapshot({ autosave: suspended, persistence: down })), 'one banner at a time').toBeNull();
  });

  it('holds back a fast "Saving…" so it does not flicker, but never delays a result', () => {
    expect(indicatorDelayMs('saving')).toBe(400);
    expect(indicatorDelayMs('saved')).toBe(0);
    expect(indicatorDelayMs('failed')).toBe(0);
    expect(indicatorLabel('hidden')).toBe('');
    expect(indicatorLabel('failed')).toBe('Autosave failed');
  });

  it('says when a loaded save came from another balance generation', () => {
    expect(describeLoadResult({ name: 'Park', contentDrift: 'none' })).toBe('Loaded Park');
    expect(describeLoadResult({ name: 'Park', contentDrift: 'older' })).toContain('older balance');
    expect(describeLoadResult({ name: 'Park', contentDrift: 'newer' })).toContain('newer balance');
  });
});

describe('Ctrl+S', () => {
  const press = (overrides: Partial<ShortcutKey> = {}): ShortcutKey => (
    { key: 's', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...overrides }
  );

  it('quick-saves in the world and swallows the browser dialog', () => {
    expect(planQuickSaveShortcut(press(), 'world', 'manual-2')).toBe('quick-save');
    expect(planQuickSaveShortcut(press({ ctrlKey: false, metaKey: true, key: 'S' }), 'build', 'manual-2')).toBe('quick-save');
    expect(planQuickSaveShortcut(press(), 'management', 'manual-2')).toBe('quick-save');
  });

  it('opens the dialog when no slot is chosen and every slot is taken', () => {
    expect(planQuickSaveShortcut(press(), 'world', null)).toBe('open-dialog');
  });

  it('swallows but does not save behind a modal, on key repeat, or inside a text field', () => {
    expect(planQuickSaveShortcut(press(), 'saveLoad', 'manual-1')).toBe('suppress');
    expect(planQuickSaveShortcut(press(), 'runMap', 'manual-1')).toBe('suppress');
    expect(planQuickSaveShortcut(press({ repeat: true }), 'world', 'manual-1')).toBe('suppress');
    expect(planQuickSaveShortcut(press(), 'textInput', 'manual-1')).toBe('ignore');
  });

  it('ignores every other key combination', () => {
    expect(planQuickSaveShortcut(press({ ctrlKey: false }), 'world', 'manual-1')).toBe('ignore');
    expect(planQuickSaveShortcut(press({ shiftKey: true }), 'world', 'manual-1')).toBe('ignore');
    expect(planQuickSaveShortcut(press({ altKey: true }), 'world', 'manual-1')).toBe('ignore');
    expect(planQuickSaveShortcut(press({ key: 'z' }), 'world', 'manual-1')).toBe('ignore');
  });
});

describe('recovery hold in the Save / Load dialog', () => {
  const snapshot = (overrides: Partial<SavesSnapshot>): SavesSnapshot => ({ ...DEFAULT_SAVES_SNAPSHOT, ...overrides });
  const suspended: SavesSnapshot['autosave'] = { state: 'suspended', indicator: 'hidden', lastSavedAt: null };

  it('does not report a hold for the recovery prompt as a fault', () => {
    expect(describeAutosavePause(snapshot({ autosave: suspended }), 'offered'), 'held autosave is not another-tab').toBeNull();
    expect(describeAutosavePause(snapshot({ autosave: suspended }), 'idle')?.cause).toBe('other-tab');
  });

  it('says why autosave is held while the prompt is unresolved, and uses the old words otherwise', () => {
    for (const phase of ['offered', 'resuming', 'dismissing'] as const) {
      expect(describeAutosaveFooter('suspended', phase)).toContain('until you decide');
    }
    expect(describeAutosaveFooter('waiting', 'idle')).toBe('Autosave is on.');
    expect(describeAutosaveFooter('off', 'checking')).toBe('Autosave is off.');
    expect(describeAutosaveFooter('suspended', 'idle')).toBe('Autosave is paused.');
  });

  it('recognises the kept autosave by its slot name, manual slots only', () => {
    const kept = (name: string, id: SaveSlotMeta['id'] = 'manual-3'): Parameters<typeof isRecoveredSlot>[0] => ({ kind: id === 'autosave' ? 'auto' : 'manual', meta: meta(id, { name }) });
    expect(isRecoveredSlot(kept('Recovered autosave'))).toBe(true);
    expect(isRecoveredSlot(kept('Recovered autosave (renamed)'))).toBe(false);
    expect(isRecoveredSlot(kept('Recovered autosave', 'autosave'))).toBe(false);
    expect(isRecoveredSlot({ kind: 'manual', meta: null })).toBe(false);
  });
});

describe('mode on Save / Load rows (Phase 22)', () => {
  const rowOf = (slot: SaveSlotMeta | null, id: SaveSlotMeta['id'] = 'autosave') => buildSlotRows(slot ? [slot] : []).find((entry) => entry.slotId === id)!;

  it('chips a readable row with its mode, a legacy record by its scenario, nothing for empty or unreadable rows', () => {
    expect(rowModeLabel(meta('manual-1', { mode: 'run' }))).toBe('The Map');
    expect(rowModeLabel(meta('manual-1', { mode: 'scenario', scenarioId: 'penny-lane' }))).toBe('Scenario');
    expect(rowModeLabel(meta('manual-1', { scenarioId: 'penny-lane' }))).toBe('Scenario');
    expect(rowModeLabel(meta('manual-1'))).toBe('Sandbox');
    expect(rowModeLabel(null)).toBeNull();
    expect(rowModeLabel(meta('manual-1', { status: { state: 'unreadable', code: 'corrupt', message: 'x' } }))).toBeNull();
  });

  it('titles the autosave row with the mode of the park it holds, and leaves other names alone', () => {
    expect(rowDisplayName(rowOf(meta('autosave', { name: 'Autosave', mode: 'scenario', scenarioId: 'penny-lane' })))).toBe('Autosave · Scenario');
    expect(rowDisplayName(rowOf(meta('autosave', { name: 'Autosave' })))).toBe('Autosave · Sandbox');
    expect(rowDisplayName(rowOf(meta('autosave', { name: 'My favourite', mode: 'run', scenarioId: 'garden-gala' })))).toBe('My favourite');
    expect(rowDisplayName(rowOf(meta('manual-1', { name: 'Big wheel', mode: 'run', scenarioId: 'garden-gala' }), 'manual-1'))).toBe('Big wheel');
    expect(rowDisplayName(rowOf(null))).toBe('No autosave yet');
    expect(rowDisplayName(rowOf(null, 'manual-2'))).toBe('Empty slot 2');
  });
});

describe('the previous autosave generation in Save / Load (Phase 31)', () => {
  const previous = (overrides: Partial<SaveSlotMeta> = {}): SaveSlotMeta => meta('autosave-previous', { kind: 'auto', name: 'Autosave', savedAt: 900_000, ...overrides });

  it('lists a loadable "Previous autosave" row right after the autosave, only when one exists', () => {
    const rows = buildSlotRows([meta('manual-2'), previous(), meta('autosave', { name: 'Autosave' })]);
    expect(rows.map((row) => row.slotId).slice(0, 3)).toEqual(['autosave', 'autosave-previous', 'manual-1']);
    expect(rows).toHaveLength(2 + MANUAL_SLOT_IDS.length);
    expect(rows[1].label).toBe('Previous autosave');
    expect(rows[1].kind).toBe('auto');
    expect(rowDisplayName(rows[1]), 'named by its place and mode').toBe('Previous autosave · Sandbox');
    expect(rowDisplayName(rows[0]), 'the autosave keeps its words').toBe('Autosave · Sandbox');
    expect(rowTag(rows[1])).toBe('PREV');
    expect(rowTag(rows[0])).toBe('AUTO');
    expect(rowTag(rows[3])).toBe('SLOT 2');
    expect(buildSlotRows([meta('autosave')]).map((row) => row.slotId), 'no empty previous row').not.toContain('autosave-previous');
  });

  it('keeps a renamed autosave name in the previous generation', () => {
    const rows = buildSlotRows([previous({ name: 'Big wheel park' })]);
    expect(rowDisplayName(rows[1])).toBe('Big wheel park');
  });

  it('offers Load and Delete, never Save or Rename', () => {
    const row = buildSlotRows([previous()])[1];
    const actions = rowActions(row, idle);
    expect(actions.showSave, 'never a save target').toBe(false);
    expect(actions.showRename, 'read-only').toBe(false);
    expect(actions.canLoad).toBe(true);
    expect(actions.canDelete).toBe(true);
    expect(planLoad(row, false)).toBe('load-now');
  });

  it('says that deleting the autosave deletes the previous generation too', () => {
    const slots = [meta('autosave', { name: 'Autosave' }), previous()];
    expect(describeDeleteConfirm('autosave', slots)).toBe('Delete Autosave and the previous autosave? This cannot be undone.');
    expect(describeDeleteConfirm('autosave-previous', slots)).toBe('Delete Previous autosave? This cannot be undone.');
    expect(describeDeleteConfirm('autosave', [unreadable('autosave'), previous()]), 'a damaged autosave goes alone').toBe('Delete Park in autosave? The damaged record is removed for good.');
    expect(describeDeleteConfirm('autosave', [meta('autosave', { name: 'Autosave' })])).toBe('Delete Autosave? This cannot be undone.');
  });
});
