import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { saveBridge } from '../app/gameBridge';
import type { SaveFailure, SaveSlotId, SaveSlotMeta, SavesSnapshot } from '../app/saves/types';
import { slotBiomeName, slotMapName } from '../app/saves/mapMeta';
import { SaveNoticeLine, useVisibleSaveNotice } from './SaveBanner';
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
  interactionReducer,
  isManualSlotId,
  isRecoveredSlot,
  isUnreadable,
  NO_INTERACTION,
  planLoad,
  planRename,
  planSave,
  rowActions,
  rowDisplayName,
  rowModeLabel,
  rowPlaceText,
  rowTag,
  type RowInteraction,
  type SlotRow,
} from './saveLoadModel';
import { showToast } from './showToast';
import { useUiStore } from './store';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusableWithin = (root: HTMLElement): HTMLElement[] => (
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.offsetParent !== null)
);

const NOW_REFRESH_MS = 20_000;

const failureText = (failure: SaveFailure): string => describeSaveFailure(failure.code);

/**
 * Phase 34: the dialog's body is a lazy chunk. `SaveLoadDialog` (the open check) lives in `lazyPanels.tsx`, the button
 * in `SaveLoadButton.tsx`, so nothing in the main chunk imports this module statically.
 */
export const SaveLoadDialogBody = (): React.JSX.Element => {
  const saves = useUiStore((state) => state.saves);
  const closeDialog = useUiStore((state) => state.closeSavesDialog);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Captured once, on mount: whoever opened the dialog gets the keyboard back when it closes.
  const [opener] = useState<Element | null>(() => document.activeElement);
  const [interaction, dispatch] = useReducer(interactionReducer, NO_INTERACTION);
  const [now, setNow] = useState(() => Date.now());
  const [actionError, setActionError] = useState<SaveFailure | null>(null);
  const [dismissedError, setDismissedError] = useState<SaveFailure | null>(null);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const interactionRef = useRef<RowInteraction>(interaction);
  useEffect(() => { interactionRef.current = interaction; }, [interaction]);
  const notice = useVisibleSaveNotice();

  const rows = buildSlotRows(saves.slots);
  const busyId = saves.busy.saving ?? saves.busy.loading ?? saves.busy.mutating;
  const anyBusy = busyId !== null;
  const persistenceDown = saves.persistence.state === 'unavailable';
  const lastError = saves.lastError !== null && saves.lastError !== dismissedError ? saves.lastError : null;
  const shownError = actionError ?? lastError;

  useEffect(() => {
    titleRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), NOW_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => { dispatch({ type: 'slots-changed', slots: saves.slots }); }, [saves.slots]);

  // After an inline step opens or closes, focus lands on the control that makes sense, not on
  // <body>: confirmations focus their safe button, finished actions return to their row.
  useEffect(() => {
    if (pendingFocus === null) return;
    const wanted = dialogRef.current?.querySelector<HTMLElement>(pendingFocus) ?? null;
    // A button that is disabled while its own save runs cannot take focus: wait for the busy state
    // to end (this effect reruns on it) instead of dropping the keyboard onto <body>.
    if (wanted instanceof HTMLButtonElement && wanted.disabled && anyBusy) return;
    const target = wanted !== null && !(wanted instanceof HTMLButtonElement && wanted.disabled)
      ? wanted
      : wanted?.closest<HTMLElement>('[data-slot]') ?? titleRef.current;
    target?.focus();
    setPendingFocus(null);
  }, [pendingFocus, interaction, saves.slots, anyBusy]);

  /**
   * Escape, Tab and the focus trap live on window in the capture phase, because focus can be on
   * <body> after a click on the backdrop and the game's own handler (bubble phase on window)
   * must not see these keys while the dialog is open.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const dialog = dialogRef.current;
      if (dialog === null) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (escapeStep(interactionRef.current) === 'cancel-interaction') {
          const { slotId, kind } = interactionRef.current as { slotId: SaveSlotId; kind: RowInteraction['kind'] };
          dispatch({ type: 'cancel' });
          // Back to the control that opened the step, as the cancel buttons do.
          const opening = kind === 'rename' ? 'rename' : kind === 'confirm-delete' ? 'delete' : kind === 'confirm-load' ? 'load' : 'save';
          setPendingFocus(`[data-slot="${slotId}"] [data-action="${opening}"]`);
        } else {
          closeDialog();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableWithin(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active) || active === titleRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [closeDialog]);

  const report = useCallback((result: { ok: true } | { ok: false; error: SaveFailure }): boolean => {
    setActionError(result.ok ? null : result.error);
    return result.ok;
  }, []);

  const save = async (slotId: SaveSlotId): Promise<void> => {
    if (!isManualSlotId(slotId)) return;
    dispatch({ type: 'cancel' });
    report(await saveBridge.saveToSlot(slotId));
    setPendingFocus(`[data-slot="${slotId}"] [data-action="save"]`);
  };

  const load = async (slotId: SaveSlotId): Promise<void> => {
    dispatch({ type: 'cancel' });
    const result = await saveBridge.load(slotId);
    // The app closed this dialog to ask "Leave the run?" first: nothing failed, and nothing is reported here.
    if (!result.ok && result.error.code === 'deferred') return;
    if (!report(result)) {
      setPendingFocus(`[data-slot="${slotId}"] [data-action="load"]`);
      return;
    }
    if (result.ok) showToast(describeLoadResult(result.value), 'routine');
    // The manager closes these too; closing is idempotent and keeps the UI right if it did not.
    useUiStore.getState().closeScenarioPicker();
    closeDialog();
  };

  const remove = async (slotId: SaveSlotId): Promise<void> => {
    dispatch({ type: 'cancel' });
    const ok = report(await saveBridge.remove(slotId));
    setPendingFocus(ok ? 'h2' : `[data-slot="${slotId}"] [data-action="delete"]`);
  };

  const commitRename = async (row: SlotRow, draft: string): Promise<void> => {
    const name = row.meta === null ? null : planRename(draft, row.meta.name);
    dispatch({ type: 'cancel' });
    setPendingFocus(`[data-slot="${row.slotId}"] [data-action="rename"]`);
    if (name === null) return;
    report(await saveBridge.rename(row.slotId, name));
  };

  const banner = describePersistenceBanner(saves.persistence, true);
  const recoveryPhase = useUiStore((state) => state.recovery.phase);
  const pause = describeAutosavePause(saves, recoveryPhase);
  const quickSaveRow = saves.quickSaveSlotId !== null ? rows.find((row) => row.slotId === saves.quickSaveSlotId) : undefined;

  return (
    <div className="saves-backdrop">
      <div
        ref={dialogRef}
        className="saves-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="saves-title"
        aria-busy={anyBusy}
      >
        <header>
          <span>
            <small>PARKSMITH</small>
            <h2 id="saves-title" ref={titleRef} tabIndex={-1}>Save / Load</h2>
          </span>
          {saves.unsavedChanges && <em className="saves-dirty" title="This park has changes that are not saved to any slot">Unsaved changes</em>}
          <button className="saves-close" onClick={closeDialog} aria-label="Close Save / Load" title="Close (Esc)">×</button>
        </header>

        {banner && (
          <div className="saves-alert" role="alert">
            <span>{banner.message}</span>
            <button onClick={() => void saveBridge.retryPersistence()}>Retry</button>
          </div>
        )}
        {pause && (
          <div className="saves-alert soft" role="status">
            <span>{pause.message}</span>
            {pause.cause === 'other-tab' && <button onClick={() => saveBridge.resumeAutosaveHere()}>Resume here</button>}
          </div>
        )}
        {shownError && (
          <div className="saves-alert" role="alert">
            <span>{failureText(shownError)}</span>
            <button
              onClick={() => { setActionError(null); setDismissedError(saves.lastError); }}
              aria-label="Dismiss error"
            >Dismiss</button>
          </div>
        )}
        {/* An error notice would repeat the alert above it (the manager publishes both for one failure). */}
        <div className="saves-notice"><SaveNoticeLine notice={shownError && notice?.kind === 'error' ? null : notice} /></div>

        <SlotList
          saves={saves}
          rows={rows}
          now={now}
          interaction={interaction}
          anyBusy={anyBusy}
          persistenceDown={persistenceDown}
          dispatch={dispatch}
          setPendingFocus={setPendingFocus}
          onSave={(row) => {
            const plan = planSave(row);
            if (plan === 'save-now') void save(row.slotId);
            else if (plan === 'confirm-overwrite') {
              dispatch({ type: 'confirm-overwrite', slotId: row.slotId });
              setPendingFocus(`[data-slot="${row.slotId}"] [data-action="cancel"]`);
            }
          }}
          onLoad={(row) => {
            const plan = planLoad(row, saves.unsavedChanges);
            if (plan === 'load-now') void load(row.slotId);
            else if (plan === 'confirm-load') {
              dispatch({ type: 'confirm-load', slotId: row.slotId });
              setPendingFocus(`[data-slot="${row.slotId}"] [data-action="cancel"]`);
            }
          }}
          onConfirmSave={(slotId) => void save(slotId)}
          onConfirmLoad={(slotId) => void load(slotId)}
          onConfirmDelete={(slotId) => void remove(slotId)}
          onCommitRename={(row, draft) => void commitRename(row, draft)}
        />

        <footer>
          <span>
            {quickSaveRow
              ? `Ctrl+S saves to ${quickSaveRow.meta?.name ?? quickSaveRow.label}.`
              : saves.quickSaveSlotId !== null
                ? `Ctrl+S saves to ${saves.quickSaveSlotId.replace('manual-', 'Slot ')}.`
                : 'Every slot is full: Ctrl+S asks which one to replace.'}
          </span>
          <span>
            {describeAutosaveFooter(saves.autosave.state, recoveryPhase)}
          </span>
        </footer>
      </div>
    </div>
  );
};

interface SlotListProps {
  saves: SavesSnapshot;
  rows: SlotRow[];
  now: number;
  interaction: RowInteraction;
  anyBusy: boolean;
  persistenceDown: boolean;
  dispatch: React.Dispatch<Parameters<typeof interactionReducer>[1]>;
  setPendingFocus: (selector: string | null) => void;
  onSave: (row: SlotRow) => void;
  onLoad: (row: SlotRow) => void;
  onConfirmSave: (slotId: SaveSlotId) => void;
  onConfirmLoad: (slotId: SaveSlotId) => void;
  onConfirmDelete: (slotId: SaveSlotId) => void;
  onCommitRename: (row: SlotRow, draft: string) => void;
}

const SlotList = (props: SlotListProps): React.JSX.Element => {
  const { saves } = props;
  const empty = saves.slots.length === 0;
  return (
    <div className="saves-body">
      {saves.listState === 'loading' && empty && <p className="saves-state" role="status">Loading saves…</p>}
      {saves.listState === 'error' && (
        <p className="saves-state" role="alert">
          The list of saves could not be read.{' '}
          <button onClick={() => void saveBridge.refresh()}>Try again</button>
        </p>
      )}
      {saves.listState === 'ready' && empty && (
        <p className="saves-state">
          {saves.persistence.state === 'unavailable'
            ? 'Saves cannot be listed while browser storage is unavailable.'
            : 'No saves yet. Pick a slot and press Save, or let autosave do it.'}
        </p>
      )}
      <ul className="saves-list" aria-label="Save slots" aria-busy={saves.busy.listing}>
        {props.rows.map((row) => <SlotRowView key={row.slotId} row={row} {...props} />)}
      </ul>
    </div>
  );
};

const SlotRowView = (props: SlotListProps & { row: SlotRow }): React.JSX.Element => {
  const { row, saves, now, interaction, dispatch, setPendingFocus } = props;
  const meta = row.meta;
  const unreadable = isUnreadable(meta);
  const actions = rowActions(row, { busy: props.anyBusy, persistenceUnavailable: props.persistenceDown });
  const here = interaction.kind !== 'none' && interaction.slotId === row.slotId ? interaction : null;
  const rowBusy = saves.busy.saving === row.slotId || saves.busy.loading === row.slotId || saves.busy.mutating === row.slotId;
  const className = ['save-row', row.kind === 'auto' ? 'auto' : '', meta === null ? 'empty' : '', unreadable ? 'unreadable' : ''].filter(Boolean).join(' ');
  const act = (selector: string) => setPendingFocus(selector);
  const rowSelector = `[data-slot="${row.slotId}"]`;
  const displayName = rowDisplayName(row);

  return (
    <li className={className} data-slot={row.slotId} aria-busy={rowBusy} tabIndex={-1}>
      <span className="save-tag">{rowTag(row)}</span>
      <div className="save-main">
        {here?.kind === 'rename' ? (
          <form
            className="save-rename"
            onSubmit={(event) => { event.preventDefault(); props.onCommitRename(row, here.draft); }}
          >
            <input
              value={here.draft}
              onChange={(event) => dispatch({ type: 'rename-edit', draft: event.target.value })}
              aria-label={`New name for ${row.label}: ${displayName}`}
              maxLength={80}
              autoFocus
              onFocus={(event) => event.target.select()}
            />
            <button type="submit" aria-label="Save name" title={here.draft.trim() === '' ? "A name can't be empty" : 'Save name'} disabled={here.draft.trim() === ''}>✓</button>
            <button type="button" aria-label="Cancel rename" title="Cancel (Esc)" onClick={() => { dispatch({ type: 'cancel' }); act(`${rowSelector} [data-action="rename"]`); }}>✕</button>
            {here.draft.trim() === '' && <span className="save-rename-hint" role="status">A name can't be empty</span>}
          </form>
        ) : (
          <strong className="save-name" title={displayName}>{displayName}</strong>
        )}
        {meta !== null && !unreadable && (
          <span className="save-sub">
            {meta.scenarioName || 'Sandbox'} · {formatPlaytime(meta.playtimeSeconds)} ·{' '}
            <time dateTime={new Date(meta.savedAt).toISOString()} title={new Date(meta.savedAt).toLocaleString()}>
              {formatLastPlayed(meta.savedAt, now)}
            </time>
            {props.persistenceDown && ' · kept in memory only'}
            {isRecoveredSlot(row) && ' · kept from an interrupted session'}
          </span>
        )}
        {meta !== null && !unreadable && (
          <span className="save-sub save-place" data-save-place>
            <b className={`save-mode-chip mode-${rowModeLabel(meta)?.toLowerCase().replace(' ', '-')}`} data-save-mode>{rowModeLabel(meta)}</b>
            {' '}{rowPlaceText(meta, `${slotMapName(meta)} · ${slotBiomeName(meta)}`)}
          </span>
        )}
        {meta !== null && unreadable && <UnreadableReason meta={meta} />}
      </div>
      {meta !== null && !unreadable ? <Stats meta={meta} /> : !unreadable && <div className="save-stats" aria-hidden="true" />}
      {/* Before the actions in the DOM so Shift+Tab from Cancel reaches Replace/Load/Delete; CSS order keeps it visually last. */}
      {here !== null && here.kind !== 'rename' && (
        <div className="save-confirm" role="group" aria-label={confirmLabel(here, `${row.label}: ${displayName}`)}>
          <span>{confirmText(here, meta, saves.slots)}</span>
          <button
            data-action="confirm"
            className={here.kind === 'confirm-delete' ? 'danger' : 'primary'}
            onClick={() => {
              if (here.kind === 'confirm-overwrite') props.onConfirmSave(row.slotId);
              else if (here.kind === 'confirm-load') props.onConfirmLoad(row.slotId);
              else props.onConfirmDelete(row.slotId);
            }}
          >
            {here.kind === 'confirm-overwrite' ? 'Replace' : here.kind === 'confirm-load' ? 'Load' : 'Delete'}
          </button>
          <button data-action="cancel" onClick={() => { dispatch({ type: 'cancel' }); act(rowSelector); }}>Cancel</button>
        </div>
      )}
      <div className="save-actions">
        {rowBusy && <span className="save-spinner" role="status" aria-label="Working" />}
        {actions.showSave && (
          <button data-action="save" disabled={!actions.canSave} title={actions.saveHint} aria-label={`Save to ${row.label}`} onClick={() => props.onSave(row)}>
            Save
          </button>
        )}
        {(row.kind === 'auto' || meta !== null) && !unreadable && (
          <button data-action="load" disabled={!actions.canLoad} title={actions.loadHint} aria-label={`Load ${row.label}: ${displayName}`} onClick={() => props.onLoad(row)}>
            Load
          </button>
        )}
        {actions.showRename && (
          <button
            data-action="rename"
            disabled={!actions.canRename}
            aria-label={`Rename ${row.label}: ${displayName}`}
            onClick={() => { dispatch({ type: 'rename-start', slotId: row.slotId, name: displayName }); }}
          >
            Rename
          </button>
        )}
        {meta !== null && (
          <button
            data-action="delete"
            className="danger"
            disabled={!actions.canDelete}
            aria-label={`Delete ${row.label}: ${displayName}`}
            onClick={() => { dispatch({ type: 'confirm-delete', slotId: row.slotId }); act(`${rowSelector} [data-action="cancel"]`); }}
          >
            Delete
          </button>
        )}
      </div>
    </li>
  );
};

const Stats = ({ meta }: { meta: SaveSlotMeta }): React.JSX.Element => (
  <dl className="save-stats">
    <div><dt>Guests</dt><dd>{Math.max(0, Math.round(meta.guestCount)).toLocaleString('en-US')}</dd></div>
    <div><dt>Cash</dt><dd>{formatCash(meta.cash)}</dd></div>
    <div><dt>Rating</dt><dd>{Math.round(meta.rating)}</dd></div>
  </dl>
);

const UnreadableReason = ({ meta }: { meta: SaveSlotMeta }): React.JSX.Element | null => {
  if (meta.status.state !== 'unreadable') return null;
  return (
    <span className="save-reason" data-code={meta.status.code}>
      <b>{describeUnreadableCode(meta.status.code)}</b> {meta.status.message}
    </span>
  );
};

const confirmLabel = (interaction: Exclude<RowInteraction, { kind: 'none' | 'rename' }>, name: string): string => (
  interaction.kind === 'confirm-overwrite' ? `Confirm replacing ${name}`
    : interaction.kind === 'confirm-load' ? `Confirm loading ${name}`
      : `Confirm deleting ${name}`
);

const confirmText = (
  interaction: Exclude<RowInteraction, { kind: 'none' | 'rename' }>,
  meta: SaveSlotMeta | null,
  slots: readonly SaveSlotMeta[],
): string => {
  const name = meta?.name ?? 'this slot';
  if (interaction.kind === 'confirm-overwrite') {
    return `Replace ${name} from ${meta ? formatLastPlayed(meta.savedAt, Date.now()) : 'earlier'}?`;
  }
  if (interaction.kind === 'confirm-load') return 'This park has unsaved changes. Load anyway?';
  return describeDeleteConfirm(interaction.slotId, slots);
};
