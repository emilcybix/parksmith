import { GAME_VERSION } from './aboutModel';
import type { RecoveryPhase } from '../app/saves/recoveryTypes';
import type { ManualSaveSlotId, SaveSlotId, SaveSlotMeta, SavesSnapshot } from '../app/saves/types';
import { slotMapName } from '../app/saves/mapMeta';
import { autosaveLabel, continuableSlots } from '../app/saves/autosaveGenerations';
import { PULSE_CARDS } from '../game/cards/content';
import { BONUSES } from '../game/profile/bonuses';
import { PROFILE_GATED_IDS } from '../game/profile/unlocks';
import type { GameMode } from '../game/modes/types';
import type { ProfileNotice, ProfileSnapshot } from '../game/profile/types';
import { MODE_DETAIL, modeLabel, slotModeOf, slotRunOf } from './modeLabels';
import { runIsAtMap, runLevelTitle, runPositionText } from './runCopy';
import type { RunSummary } from '../game/run/types';
import { formatCash, formatLastPlayed, formatPlaytime } from './saveLoadModel';
import { clearedSummary } from './scenarioBrowserModel';
import { bonusName, buildingName, plural, scenarioName } from './unlockCopy';

/**
 * The start screen and the pause menu as pure data (Phase 18 step 2). The components only render
 * what these functions return and forward key events to `moveMenuFocus`; everything that decides
 * (which save Continue means, what is disabled and why, where focus starts, what Escape does, when
 * the first run skips the menu) is here so it can be tested without a DOM.
 */

export type MenuKind = 'start' | 'pause';
/** `main` is the list of entries; `about`, `quit`, the Sandbox map picker (`new-park`, Phase 24), the Scenario browser (`scenarios`), the Collection, The Map's setup (`the-map`, Phase 23) and the pause menu's Parks chooser (`modes`) replace the card's content and Escape goes back. */
export type MenuPanel = 'main' | 'about' | 'quit' | 'new-park' | 'scenarios' | 'collection' | 'modes' | 'the-map';

export type StartMenuItemId = 'continue' | 'the-map' | 'scenarios' | 'sandbox' | 'load' | 'collection' | 'settings' | 'about';
export type PauseMenuItemId = 'resume' | 'run-map' | 'save' | 'load' | 'settings' | 'parks' | 'collection' | 'about' | 'quit';
export type MenuItemId = StartMenuItemId | PauseMenuItemId;

export interface MenuItem<Id extends MenuItemId = MenuItemId> {
  id: Id;
  label: string;
  /** One quiet line under the label (what Continue will open, what Save does). */
  detail: string | null;
  /**
   * Why the entry cannot be used right now, or null. A refused entry stays focusable and is marked
   * `aria-disabled` with this text as its description, so focus never jumps while it waits.
   */
  unavailable: string | null;
  primary: boolean;
}

// --- The latest save -----------------------------------------------------------------------------

/**
 * Only slots that were readable when they were listed are candidates; an unreadable record is never offered.
 * Phase 31: of the two autosave generations only one is a candidate, the newest readable one (`continuableSlots`):
 * the previous generation stands in when the current one is unreadable or was quarantined, never beside it.
 */
export const readableSlots = (slots: readonly SaveSlotMeta[]): SaveSlotMeta[] => continuableSlots(slots);

/**
 * Newest first. On a tie the autosave comes first (the list is autosave-first and the sort is
 * stable), because an autosave and a manual save written in the same instant describe the same park.
 */
export const slotsNewestFirst = (slots: readonly SaveSlotMeta[]): SaveSlotMeta[] => (
  readableSlots(slots).sort((a, b) => b.savedAt - a.savedAt)
);

export const latestSave = (slots: readonly SaveSlotMeta[]): SaveSlotMeta | null => slotsNewestFirst(slots)[0] ?? null;

export interface ContinueCard {
  slotId: SaveSlotId;
  title: string;
  /** The game mode of the save (Phase 22): the first word of the subtitle. */
  mode: GameMode;
  /**
   * "Sandbox · Red Rock Canyon · Autosave · 5 min ago", "Scenario · Penny Lane · Autosave · 5 min ago" or
   * "The Map · Garden Gala · yesterday". The mode comes first; a sandbox always names its map (a record from before
   * Phase 24 reads "Meadow Garden"); a scenario names it only when it is not the Meadow Garden, which every scenario
   * of the first four used.
   */
  subtitle: string;
  stats: { label: string; value: string }[];
}

const DEFAULT_PARK_NAME = 'sandbox park';

export const describeContinue = (meta: SaveSlotMeta, now: number): ContinueCard => {
  const title = meta.scenarioName.trim() === '' ? meta.name : meta.scenarioName;
  const label = meta.kind === 'auto' ? autosaveLabel(meta) : meta.name;
  const mode = slotModeOf(meta);
  const run = mode === 'run' ? slotRunOf(meta) : null;
  if (run !== null) return describeRunContinue(meta, run, now);
  // A manual save still carrying the default name ("Sandbox park") or the scenario's own name is not repeated.
  const map = slotMapName(meta);
  const showMap = meta.scenarioId === null || map !== slotMapName({});
  const normalisedLabel = label.trim().toLowerCase();
  const parts = [
    modeLabel(mode),
    ...(meta.scenarioId === null ? [] : [title]),
    ...(showMap ? [map] : []),
    ...(normalisedLabel === title.trim().toLowerCase() || (meta.scenarioId === null && normalisedLabel === DEFAULT_PARK_NAME) ? [] : [label]),
    formatLastPlayed(meta.savedAt, now),
  ];
  return {
    slotId: meta.id,
    title,
    mode,
    subtitle: parts.join(' · '),
    stats: [
      { label: 'Guests', value: Math.max(0, Math.round(meta.guestCount)).toLocaleString('en-US') },
      { label: 'Cash', value: formatCash(meta.cash) },
      { label: 'Rating', value: String(Math.round(meta.rating)) },
      { label: 'Park time', value: formatPlaytime(meta.playtimeSeconds) },
    ],
  };
};

/**
 * The Continue card of a save that carries a run (Phase 23): "Level 3 · Desert Canyon" over "The Map · level 3/5 ·
 * seed 1234 · Autosave · 5 min ago". Between stages the subtitle says "at the run map"; a run that is over says so.
 */
const describeRunContinue = (meta: SaveSlotMeta, run: RunSummary, now: number): ContinueCard => {
  const label = meta.kind === 'auto' ? autosaveLabel(meta) : meta.name;
  const where = run.phase === 'won' ? ['run complete'] : run.phase === 'lost' ? ['run over'] : runIsAtMap(run.phase) ? ['at the run map'] : [];
  return {
    slotId: meta.id,
    title: runLevelTitle(run),
    mode: 'run',
    subtitle: [modeLabel('run'), runPositionText(run), ...where, label, formatLastPlayed(meta.savedAt, now)].join(' · '),
    stats: [
      { label: 'Guests', value: Math.max(0, Math.round(meta.guestCount)).toLocaleString('en-US') },
      { label: 'Cash', value: formatCash(meta.cash) },
      { label: 'Rating', value: String(Math.round(meta.rating)) },
      { label: 'Park time', value: formatPlaytime(meta.playtimeSeconds) },
    ],
  };
};

/** The newest readable save of each mode (a mode without one is absent). Pure; ties keep list order (autosave first). */
export const latestSlotByMode = (slots: readonly SaveSlotMeta[]): ReadonlyMap<GameMode, SaveSlotMeta> => {
  const result = new Map<GameMode, SaveSlotMeta>();
  for (const slot of slotsNewestFirst(slots)) {
    const mode = slotModeOf(slot);
    if (!result.has(mode)) result.set(mode, slot);
  }
  return result;
};

/** What the latest park of a mode is called in the menu: a sandbox by its map, the others by their scenario. */
const latestSubject = (meta: SaveSlotMeta): string => {
  const run = slotModeOf(meta) === 'run' ? slotRunOf(meta) : null;
  return run !== null ? `${runLevelTitle(run)} (${runPositionText(run)})` : latestParkSubject(meta);
};

const latestParkSubject = (meta: SaveSlotMeta): string => (
  meta.scenarioId === null || slotModeOf(meta) === 'sandbox' ? slotMapName(meta) : (meta.scenarioName.trim() === '' ? meta.name : meta.scenarioName)
);

export interface ModeResumeOffer {
  slotId: SaveSlotId;
  /** "Resume your latest sandbox — Red Rock Canyon · 2 days ago". */
  text: string;
  /** "Red Rock Canyon, 2 days ago" (the tail of the entry's detail). */
  short: string;
}

const MODE_NOUN: Readonly<Record<GameMode, string>> = { sandbox: 'sandbox', scenario: 'scenario park', run: 'park on The Map' };

/**
 * The "latest of this mode" offer, only when Continue does not already mean it: Continue opens the newest save of any
 * mode, so the newest of another mode would otherwise need a trip through Load.
 */
export const modeResumeOffer = (slots: readonly SaveSlotMeta[], mode: GameMode, now: number): ModeResumeOffer | null => {
  const latest = latestSave(slots);
  const ofMode = latestSlotByMode(slots).get(mode);
  if (latest === null || ofMode === undefined || ofMode.id === latest.id) return null;
  const when = formatLastPlayed(ofMode.savedAt, now);
  const subject = latestSubject(ofMode);
  return {
    slotId: ofMode.id,
    text: `Resume your latest ${MODE_NOUN[mode]} — ${subject} · ${when}`,
    short: `${subject}, ${when}`,
  };
};

// --- The profile in the menu -----------------------------------------------------------------------

/** "1 of 4 buildings · 4 of 6 cards · 2 of 6 bonuses" (counts unlocked of total). */
export const collectionSummary = (profile: ProfileSnapshot | null): string => (
  `${profile?.unlockedBuildingIds.length ?? 0} of ${PROFILE_GATED_IDS.length} buildings · `
  + `${profile?.collectionCardIds.length ?? 0} of ${PULSE_CARDS.length} cards · `
  + `${profile?.bonusIds.length ?? 0} of ${BONUSES.length} bonuses`
);

export interface ProfileNoticeModel {
  text: string;
}

/** The one-time message after an older profile was converted (Park Tour progress carried over). */
export const describeProfileNotice = (notice: ProfileNotice | null): ProfileNoticeModel | null => {
  if (notice === null || notice.kind !== 'tour-converted') return null;
  const cleared = notice.clearedScenarioIds.map(scenarioName);
  const earned = [
    ...notice.bonusIds.map(bonusName),
    ...notice.unlockedBuildingIds.map(buildingName),
  ];
  const first = `Your Park Tour progress carried over: ${cleared.length === 0 ? 'no parks' : plural(cleared.length, 'park')} (${cleared.join(', ')}) now count as cleared scenarios.`;
  const second = earned.length === 0 ? '' : ` You earned ${earned.join(', ')}.`;
  return { text: `${first}${second}` };
};

// --- Start screen --------------------------------------------------------------------------------

export interface StartMenuInput {
  slots: readonly SaveSlotMeta[];
  listState: SavesSnapshot['listState'];
  recoveryPhase: RecoveryPhase;
  /** A load or a Continue is in flight. */
  busy: boolean;
  /** The park behind the menu is still being chosen and read (the sweep is not ready yet). */
  previewPhase: 'checking' | 'ready';
  now: number;
  /** The profile as the store holds it (null until the app published it). */
  profile?: ProfileSnapshot | null;
}

export interface StartMenuModel {
  items: MenuItem<StartMenuItemId>[];
  defaultFocus: StartMenuItemId;
  continueCard: ContinueCard | null;
  /** The one-time profile message above the entries (Got it / Open Collection), or null. */
  notice: ProfileNoticeModel | null;
}

export const WAITING_FOR_RECOVERY = 'Answer the question about your interrupted park first.';
export const WAITING_FOR_SAVES = 'Looking for your park…';
export const WAITING_FOR_LOAD = 'Loading…';

/** Why Continue cannot run now, or null. Disabled entries are still listed so the order never shifts. */
export const continueUnavailable = (input: StartMenuInput): string | null => {
  if (input.recoveryPhase !== 'idle') {
    return input.recoveryPhase === 'checking' ? WAITING_FOR_SAVES : WAITING_FOR_RECOVERY;
  }
  if (input.previewPhase === 'checking' || input.listState === 'idle' || input.listState === 'loading') return WAITING_FOR_SAVES;
  if (input.busy) return WAITING_FOR_LOAD;
  return null;
};

/** An entry's detail with the "latest of this mode" tail when Continue does not already mean it. */
const withLatest = (detail: string, offer: ModeResumeOffer | null): string => (
  offer === null ? detail : `${detail} · Latest: ${offer.short}`
);

/** The three mode entries' details, one source for the start menu and the pause menu's Parks chooser. */
export const modeEntryDetails = (profile: ProfileSnapshot | null, slots: readonly SaveSlotMeta[], now: number): Record<GameMode, string> => ({
  run: withLatest(MODE_DETAIL.run, modeResumeOffer(slots, 'run', now)),
  scenario: withLatest(`${MODE_DETAIL.scenario} · ${clearedSummary(profile)}`, modeResumeOffer(slots, 'scenario', now)),
  sandbox: withLatest(MODE_DETAIL.sandbox, modeResumeOffer(slots, 'sandbox', now)),
});

export const buildStartMenu = (input: StartMenuInput): StartMenuModel => {
  const latest = latestSave(input.slots);
  const continueCard = latest === null ? null : describeContinue(latest, input.now);
  const profile = input.profile ?? null;
  const items: MenuItem<StartMenuItemId>[] = [];
  const blocked = continueUnavailable(input);
  const waiting = input.recoveryPhase !== 'idle' ? WAITING_FOR_RECOVERY : null;
  if (continueCard !== null) {
    items.push({
      id: 'continue',
      label: 'Continue',
      detail: continueCard.subtitle,
      unavailable: blocked,
      primary: true,
    });
  }
  const hasContinue = continueCard !== null;
  const details = modeEntryDetails(profile, input.slots, input.now);
  items.push(
    { id: 'the-map', label: 'The Map', detail: details.run, unavailable: waiting, primary: !hasContinue },
    { id: 'scenarios', label: 'Scenario', detail: details.scenario, unavailable: waiting, primary: false },
    { id: 'sandbox', label: 'Sandbox', detail: details.sandbox, unavailable: waiting, primary: false },
    { id: 'load', label: 'Load', detail: 'Pick any save', unavailable: waiting, primary: false },
    { id: 'collection', label: 'Collection', detail: collectionSummary(profile), unavailable: null, primary: false },
    { id: 'settings', label: 'Settings', detail: null, unavailable: null, primary: false },
    { id: 'about', label: 'About and feedback', detail: `v${GAME_VERSION}`, unavailable: null, primary: false },
  );
  return {
    items,
    defaultFocus: hasContinue ? 'continue' : 'the-map',
    continueCard,
    notice: describeProfileNotice(profile?.notice ?? null),
  };
};

// --- Pause menu ----------------------------------------------------------------------------------

export interface PauseMenuInput {
  /** Phase 23: the run the paused park belongs to (mode `run`), or null. A run that is over has no map to open. */
  run?: RunSummary | null;
  /** The manual slot a quick save writes to next; null when every slot is taken. */
  quickSaveSlotId: ManualSaveSlotId | null;
  persistence: SavesSnapshot['persistence']['state'];
  unsavedChanges: boolean;
}

export const buildPauseMenu = (input: PauseMenuInput): { items: MenuItem<PauseMenuItemId>[]; defaultFocus: PauseMenuItemId } => {
  const saveDetail = input.quickSaveSlotId === null
    ? 'Every slot is taken: choose one to replace'
    : input.persistence === 'unavailable'
      ? 'Saving is unavailable: this session only'
      : `Quick save to slot ${input.quickSaveSlotId.replace('manual-', '')}`;
  return {
    items: [
      { id: 'resume', label: 'Resume', detail: 'Back to the park at the speed you had', unavailable: null, primary: true },
      ...(input.run != null && input.run.phase !== 'won' && input.run.phase !== 'lost'
        ? [{ id: 'run-map' as const, label: 'Run map', detail: `${runPositionText(input.run)} · levels, deck and offer`, unavailable: null, primary: false }]
        : []),
      { id: 'save', label: 'Save', detail: saveDetail, unavailable: null, primary: false },
      { id: 'load', label: 'Load', detail: null, unavailable: null, primary: false },
      { id: 'settings', label: 'Settings', detail: null, unavailable: null, primary: false },
      { id: 'parks', label: 'Parks', detail: 'Sandbox, Scenario or The Map', unavailable: null, primary: false },
      { id: 'collection', label: 'Collection', detail: null, unavailable: null, primary: false },
      // Phase 19: the version, the changelog and the feedback form are reachable from inside a park.
      { id: 'about', label: 'About and feedback', detail: `v${GAME_VERSION}`, unavailable: null, primary: false },
      { id: 'quit', label: 'Quit to menu', detail: input.unsavedChanges ? 'You have unsaved changes' : null, unavailable: null, primary: false },
    ],
    defaultFocus: 'resume',
  };
};

// --- Quit to menu --------------------------------------------------------------------------------

// --- The Parks chooser (pause menu panel `modes`) ----------------------------------------------------

export interface ModeChoice {
  id: 'the-map' | 'scenarios' | 'sandbox';
  mode: GameMode;
  label: string;
  detail: string;
}

/** The three buttons of the chooser, in the start menu's order, with the start menu's details. */
export const buildModeChooser = (profile: ProfileSnapshot | null): ModeChoice[] => {
  const details = modeEntryDetails(profile, [], 0);
  return [
    { id: 'the-map', mode: 'run', label: 'The Map', detail: details.run },
    { id: 'scenarios', mode: 'scenario', label: 'Scenario', detail: details.scenario },
    { id: 'sandbox', mode: 'sandbox', label: 'Sandbox', detail: details.sandbox },
  ];
};

export type QuitPlan = 'quit-now' | 'confirm';

/** Leaving a park with changes no save holds asks first, exactly as the Load dialog does (the manager's dirty state). */
export const planQuit = (unsavedChanges: boolean): QuitPlan => (unsavedChanges ? 'confirm' : 'quit-now');

export type QuitChoiceId = 'save' | 'discard' | 'cancel';

export const QUIT_TEXT = 'This park has changes no save holds. Save them before you leave?';

export const QUIT_CHOICES: readonly { id: QuitChoiceId; label: string }[] = [
  { id: 'save', label: 'Save and quit' },
  { id: 'discard', label: 'Quit without saving' },
  { id: 'cancel', label: 'Cancel' },
];

// --- Keys ----------------------------------------------------------------------------------------

/**
 * Roving focus for a vertical list of entries: arrows and Home/End move, the ends wrap, anything
 * else is not ours (null). Enter and Space are the buttons' own. A current id that is not in the
 * list (focus is elsewhere in the card) starts from the edge the key points at.
 */
export const moveMenuFocus = (ids: readonly string[], current: string | null, key: string): string | null => {
  if (ids.length === 0) return null;
  const index = current === null ? -1 : ids.indexOf(current);
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return ids[index < 0 ? 0 : (index + 1) % ids.length];
    case 'ArrowUp':
    case 'ArrowLeft':
      return ids[index < 0 ? ids.length - 1 : (index - 1 + ids.length) % ids.length];
    case 'Home':
      return ids[0];
    case 'End':
      return ids[ids.length - 1];
    default:
      return null;
  }
};

export type MenuEscapeStep = 'resume' | 'back' | 'none';

/**
 * Where a sub-panel's Back goes: the pause menu's Parks chooser is one level above the Scenario browser, The Map's setup and
 * the Sandbox picker it opens, so Back returns there; every other panel returns to the list.
 */
export const menuBackTarget = (kind: MenuKind, panel: MenuPanel): MenuPanel => (
  kind === 'pause' && (panel === 'scenarios' || panel === 'new-park' || panel === 'the-map') ? 'modes' : 'main'
);

/**
 * Escape inside the menu layer: a sub-panel goes back exactly where its Back button goes (`menuBackTarget`), the pause
 * menu resumes, the start screen has no exit.
 */
export const menuEscapeStep = (kind: MenuKind, panel: MenuPanel): MenuEscapeStep => {
  if (panel !== 'main') return 'back';
  return kind === 'pause' ? 'resume' : 'none';
};

// --- Boot ----------------------------------------------------------------------------------------

export interface BootMenuInput {
  /** `&menu=0` turns it off. */
  enabled: boolean;
  /** The browser holds no profile yet (ProfileManager.isFirstRun). */
  isFirstRun: boolean;
  developerMode: boolean;
  hasSlots: boolean;
}

/**
 * First run (no profile, no saves) keeps the Sandbox First Day (Phase 23 decision): the park opens at once, with no menu
 * in front of it and no map over it, and the one-time "Ready for The Map?" offer follows once the park is stable.
 * Developer mode never skips, so a developer with a clean profile still sees the menu.
 */
export const bootMenuDecision = (input: BootMenuInput): 'menu' | 'skip' => {
  if (!input.enabled) return 'skip';
  if (input.isFirstRun && !input.hasSlots && !input.developerMode) return 'skip';
  return 'menu';
};

// --- Messages ------------------------------------------------------------------------------------

/** What the start screen says when a save it tried to show could not be read. */
export const describeUnreadableLatest = (failedNames: readonly string[], showingName: string | null): string => {
  const subject = failedNames.length === 1 ? `Your latest save “${failedNames[0]}”` : `Your ${failedNames.length} latest saves`;
  const kept = failedNames.length === 1 ? 'It stays in Save / Load, marked unreadable.' : 'They stay in Save / Load, marked unreadable.';
  return showingName === null
    ? `${subject} could not be read. ${kept}`
    : `${subject} could not be read, so the menu shows “${showingName}” instead. ${kept}`;
};
