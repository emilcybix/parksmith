import { useEffect, useId, useRef, useState } from 'react';
import { gameBridge } from '../app/gameBridge';
import { runBridge } from './runBridge';
import type { ProfileSnapshot } from '../game/profile/types';
import { CHANGELOG, GAME_VERSION } from './aboutModel';
import { FeedbackForm } from './FeedbackForm';
import {
  QUIT_CHOICES,
  QUIT_TEXT,
  buildModeChooser,
  buildPauseMenu,
  buildStartMenu,
  menuBackTarget,
  modeResumeOffer,
  moveMenuFocus,
  type MenuItem,
  type MenuItemId,
  type MenuKind,
  type QuitChoiceId,
} from './menuModel';
import { CollectionPanel } from './CollectionPanel';
import { activeInputContext } from './inputContext';
import { NewParkPanel } from './NewParkPanel';
import { RunSetupPanel } from './RunSetupPanel';
import { ScenarioBrowser } from './ScenarioBrowser';
import { summaryOfSnapshot } from './runMapModel';
import { openSaveLoadDialog } from './openSaveLoad';
import { openSettings } from './openSettings';
import { SaveNoticeLine, useVisibleSaveNotice } from './SaveBanner';
import { useUiStore } from './store';

// A roving radio (tabindex -1) is not a tab stop, so it is not an edge of the Tab trap either.
// Text fields count too (The Map's seed): a field left out of the trap's edges could never be reached with Tab.
const FOCUSABLE = 'button:not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

const focusableWithin = (root: HTMLElement): HTMLElement[] => (
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.offsetParent !== null)
);

/**
 * The start screen (over the camera sweep) and the in-game pause menu. One component, two models
 * (`menuModel.ts`); GameApp owns every transition and Escape, this renders, moves focus and calls
 * the same openers the HUD uses (`openSettings`, `openSaveLoadDialog`, the Parks chooser).
 */
export const MainMenu = (): React.JSX.Element | null => {
  const kind = useUiStore((state) => state.menuKind);
  return kind === null ? null : <MenuBody key={kind} kind={kind} />;
};

const MenuBody = ({ kind }: { kind: MenuKind }): React.JSX.Element => {
  const panel = useUiStore((state) => state.menuPanel);
  const notice = useUiStore((state) => state.menuNotice);
  const previewPhase = useUiStore((state) => state.menuPreview.phase);
  const saves = useUiStore((state) => state.saves);
  const recoveryPhase = useUiStore((state) => state.recovery.phase);
  const profile = useUiStore((state) => state.profile);
  const parkRun = useUiStore((state) => (state.sessionMode === 'run' ? state.run : null));
  const setPanel = useUiStore((state) => state.setMenuPanel);
  const topmost = useUiStore((state) => activeInputContext(state) === 'menu');
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const lastFocused = useRef<string | null>(null);
  // The pause menu's Parks chooser keeps its own memory, so an entry chosen there never becomes the list's (which has no
  // such entry, and focus would fall to the page).
  const modesFocused = useRef<string | null>(null);
  // Once the player has moved focus themselves, a late change of the default (Continue appearing once the list is read) must not take it away.
  const touched = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const saveNotice = useVisibleSaveNotice();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  // Closing the pause menu (Resume, Esc) hands the keyboard back to the control that opened it (the ☰ button, or the top bar's Parks
  // button), else to the ☰ button, not to the page. Leaving for the start screen unmounts the HUD button's visibility, so there
  // nothing is focused.
  useEffect(() => {
    if (kind !== 'pause') return undefined;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active.closest('.top-bar, .utility-bar') !== null ? active : null;
    return () => {
      const now = document.activeElement;
      if (now === null || now === document.body || !now.isConnected) {
        (opener?.isConnected === true ? opener : document.querySelector<HTMLElement>('[data-menu-button]'))?.focus();
      }
    };
  }, [kind]);

  const start = buildStartMenu({
    slots: saves.slots,
    listState: saves.listState,
    recoveryPhase,
    busy: saves.busy.loading !== null || pending,
    previewPhase,
    now,
    profile,
  });
  const pause = buildPauseMenu({
    quickSaveSlotId: saves.quickSaveSlotId,
    persistence: saves.persistence.state,
    unsavedChanges: saves.unsavedChanges,
    run: parkRun === null ? null : summaryOfSnapshot(parkRun),
  });
  const items: readonly MenuItem[] = kind === 'start' ? start.items : pause.items;
  const defaultFocus: MenuItemId = kind === 'start' ? start.defaultFocus : pause.defaultFocus;
  // The start screen waits, scrim only, until the park behind it is known: no card that rearranges itself.
  const ready = kind === 'pause' || previewPhase === 'ready';

  const focusItem = (id: string | null): boolean => {
    const target = id === null ? null : cardRef.current?.querySelector<HTMLElement>(`[data-menu-item="${id}"]`);
    if (target) target.focus();
    return Boolean(target);
  };

  // Focus: the default entry when the card appears or the panel changes, and the entry that had
  // it when a layer above (Settings, Save / Load, the Parks chooser) closes. Never while another layer owns the keyboard.
  useEffect(() => {
    if (!topmost || !ready) return;
    const card = cardRef.current;
    if (card === null) return;
    if (card.contains(document.activeElement) && document.activeElement !== card) return;
    if (panel === 'main') {
      if (!focusItem(lastFocused.current ?? defaultFocus)) focusItem(defaultFocus);
    } else if (panel !== 'modes' || !focusItem(modesFocused.current)) {
      card.querySelector<HTMLElement>('[data-panel-focus]')?.focus();
    }
  }, [topmost, ready, panel]);

  useEffect(() => {
    // The start screen's own default may arrive late (Continue appears once the list is read).
    if (!topmost || !ready || panel !== 'main' || lastFocused.current !== null || touched.current) return;
    focusItem(defaultFocus);
  }, [defaultFocus]);

  // Holding Enter on an entry repeats its click. "Quit to menu" or "Quit without saving" swaps this component for the
  // start screen under the same held key, and the repeat would press Continue there. A held Enter is one press.
  useEffect(() => {
    const onRepeat = (event: KeyboardEvent): void => {
      if (!event.repeat || event.key !== 'Enter') return;
      const target = event.target;
      if (target === document.body || (target instanceof Node && cardRef.current?.contains(target))) event.preventDefault();
    };
    window.addEventListener('keydown', onRepeat, true);
    return () => window.removeEventListener('keydown', onRepeat, true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const card = cardRef.current;
      if (card === null || !topmost) return;
      touched.current = true;
      if (event.key === 'Tab') {
        const focusable = focusableWithin(card);
        if (focusable.length === 0) { event.preventDefault(); return; }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (!card.contains(active) || active === card) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      const ids = Array.from(card.querySelectorAll<HTMLElement>('[data-menu-item]')).map((element) => element.dataset.menuItem ?? '');
      const active = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.menuItem ?? null : null;
      const next = moveMenuFocus(ids, active, event.key);
      if (next !== null) {
        event.preventDefault();
        focusItem(next);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [topmost]);

  const activate = (id: MenuItemId): void => {
    if (panel === 'modes') {
      modesFocused.current = id;
    } else {
      lastFocused.current = id;
      // Entering the chooser from the list starts at its heading again.
      if (id === 'parks') modesFocused.current = null;
    }
    switch (id) {
      case 'continue':
        setPending(true);
        void gameBridge.menuContinue().finally(() => setPending(false));
        return;
      case 'sandbox':
        // The picker: Meadow Garden is preselected, so Enter on its map row is today's sandbox.
        setPanel('new-park');
        return;
      case 'scenarios':
        setPanel('scenarios');
        return;
      case 'the-map':
        // In a run the pause menu's The Map is the run map itself; everywhere else it is the setup (New run, Continue run).
        if (kind === 'pause' && parkRun !== null && parkRun.phase !== 'won' && parkRun.phase !== 'lost') runBridge.openRunMap();
        else setPanel('the-map');
        return;
      case 'run-map':
        runBridge.openRunMap();
        return;
      case 'collection':
        setPanel('collection');
        return;
      case 'parks':
        // Phase 30: through GameApp so a pause-menu park with unsaved changes asks the Quit question first.
        gameBridge.openParksChooser('modes');
        return;
      case 'load':
        openSaveLoadDialog();
        return;
      case 'settings':
        openSettings();
        return;
      case 'about':
        setPanel('about');
        return;
      case 'resume':
        gameBridge.resumeFromMenu();
        return;
      case 'save':
        gameBridge.menuQuickSave();
        return;
      case 'quit':
        gameBridge.requestQuitToMenu();
        return;
    }
  };

  const goBack = (): void => setPanel(menuBackTarget(kind, panel));

  const chooseQuit = (choice: QuitChoiceId): void => {
    if (choice === 'cancel') { setPanel('main'); return; }
    setPending(true);
    void gameBridge.confirmQuitToMenu(choice).finally(() => setPending(false));
  };

  return (
    <div className={`menu-backdrop ${kind}`} data-menu-kind={kind} data-ready={ready ? 'true' : 'false'}>
      {ready && (
        <div
          ref={cardRef}
          className={`menu-card ${kind} ${panel === 'new-park' || panel === 'scenarios' || panel === 'collection' || panel === 'the-map' ? 'picking' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          inert={!topmost}
          onPointerDown={() => { touched.current = true; }}
        >
          <header className="menu-brand">
            <span className="menu-brand-mark" aria-hidden="true">P</span>
            <span>
              <small>{kind === 'start' ? 'THEME PARK BUILDER' : 'PAUSED'}</small>
              <strong id={titleId}>{kind === 'start' ? 'Parksmith' : 'Paused'}</strong>
            </span>
          </header>
          {panel === 'about' && <AboutPanel onBack={goBack} />}
          {panel === 'new-park' && <NewParkPanel onBack={goBack} resume={kind === 'start' ? modeResumeOffer(saves.slots, 'sandbox', now) : null} />}
          {panel === 'the-map' && <RunSetupPanel slots={saves.slots} profile={profile} now={now} onBack={goBack} />}
          {panel === 'scenarios' && <ScenarioBrowser onBack={goBack} />}
          {panel === 'collection' && <CollectionPanel onBack={goBack} />}
          {panel === 'modes' && <ModesPanel profile={profile} onChoose={activate} onBack={goBack} />}
          {panel === 'quit' && <QuitPanel pending={pending} onChoose={chooseQuit} />}
          {panel === 'main' && (
            <>
              {notice !== null && <p className="menu-notice" role="alert">{notice}</p>}
              {kind === 'start' && start.notice !== null && (
                <div className="menu-profile-notice" role="status" data-profile-notice>
                  <p>{start.notice.text}</p>
                  <span>
                    <button type="button" data-menu-item="notice-ok" onClick={() => gameBridge.dismissProfileNotice()}>Got it</button>
                    <button type="button" data-menu-item="notice-collection" onClick={() => { gameBridge.dismissProfileNotice(); setPanel('collection'); }}>Open Collection</button>
                  </span>
                </div>
              )}
              <div className="menu-list" role="group" aria-label={kind === 'start' ? 'Start menu' : 'Pause menu'}>
                {items.map((item) => (
                  <MenuEntry
                    key={item.id}
                    item={item}
                    card={kind === 'start' && item.id === 'continue' ? start.continueCard : null}
                    onActivate={activate}
                  />
                ))}
              </div>
              {kind === 'pause' && saveNotice !== null && <p className="menu-save-notice"><SaveNoticeLine notice={saveNotice} /></p>}
              <p className="menu-foot">
                <span>Arrows to move · Enter to choose{kind === 'pause' ? ' · Esc to resume' : ''}</span>
                {kind === 'start' && <span>v{GAME_VERSION}</span>}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};

interface MenuEntryProps {
  item: MenuItem;
  card: ReturnType<typeof buildStartMenu>['continueCard'];
  onActivate: (id: MenuItemId) => void;
}

const MenuEntry = ({ item, card, onActivate }: MenuEntryProps): React.JSX.Element => {
  const hintId = useId();
  const refused = item.unavailable !== null;
  const described = refused ? item.unavailable : item.detail;
  return (
    <button
      type="button"
      className={`menu-entry ${item.primary ? 'primary' : ''} ${refused ? 'waiting' : ''}`}
      data-menu-item={item.id}
      aria-disabled={refused}
      aria-describedby={described ? hintId : undefined}
      // A refused entry stays in the focus order (so focus never jumps while it waits) but does nothing.
      onClick={() => { if (!refused) onActivate(item.id); }}
    >
      <span className="menu-entry-label">{item.label}</span>
      {described ? <span id={hintId} className="menu-entry-detail">{described}</span> : null}
      {card !== null && !refused && (
        <span className="menu-entry-stats" aria-hidden="true">
          {card.stats.map((stat) => (
            <span key={stat.label}><b>{stat.value}</b><small>{stat.label}</small></span>
          ))}
        </span>
      )}
    </button>
  );
};

const ModesPanel = ({ profile, onChoose, onBack }: {
  profile: ProfileSnapshot | null;
  onChoose: (id: MenuItemId) => void;
  onBack: () => void;
}): React.JSX.Element => (
  <section className="menu-modes" aria-label="Parks">
    <h2 tabIndex={-1} data-panel-focus>Parks</h2>
    <div className="menu-list" role="group" aria-label="Game modes">
      {buildModeChooser(profile).map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="menu-entry"
          data-menu-item={choice.id}
          aria-describedby={`modes-${choice.id}`}
          onClick={() => onChoose(choice.id)}
        >
          <span className="menu-entry-label">{choice.label}</span>
          <span id={`modes-${choice.id}`} className="menu-entry-detail">{choice.detail}</span>
        </button>
      ))}
    </div>
    <button type="button" className="menu-back" data-menu-item="back" onClick={onBack}>Back</button>
  </section>
);

const AboutPanel = ({ onBack }: { onBack: () => void }): React.JSX.Element => (
  <section className="menu-about" aria-label="About and feedback">
    <h2 tabIndex={-1} data-panel-focus>About Parksmith <span className="menu-version">v{GAME_VERSION}</span></h2>
    <p className="menu-about-lead">A theme-park builder: lay paths, raise rides, keep guests happy and the books balanced.</p>
    <div className="menu-changelog">
      {CHANGELOG.map((entry) => (
        <article key={entry.version}>
          <h3>v{entry.version} <small>{entry.date} · {entry.title}</small></h3>
          <ul>{entry.changes.map((change) => <li key={change}>{change}</li>)}</ul>
        </article>
      ))}
    </div>
    <FeedbackForm />
    <button type="button" className="menu-back" data-menu-item="back" onClick={onBack}>Back</button>
  </section>
);

const QuitPanel = ({ pending, onChoose }: { pending: boolean; onChoose: (choice: QuitChoiceId) => void }): React.JSX.Element => {
  const notice = useUiStore((state) => state.menuNotice);
  return (
    <section className="menu-quit" aria-label="Quit to menu">
      <h2 tabIndex={-1} data-panel-focus>Leave this park?</h2>
      <p>{QUIT_TEXT}</p>
      {notice !== null && <p className="menu-notice" role="alert">{notice}</p>}
      <div className="menu-list" role="group" aria-label="Quit choices">
        {QUIT_CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            className={`menu-entry ${choice.id === 'save' ? 'primary' : ''}`}
            data-menu-item={choice.id}
            aria-disabled={pending}
            onClick={() => { if (!pending) onChoose(choice.id); }}
          >
            <span className="menu-entry-label">{choice.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
};
