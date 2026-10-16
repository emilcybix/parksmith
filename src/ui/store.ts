import { create } from 'zustand';
import { GAME_CONFIG } from '../game/config';
import type { BuildCategory, Cell, GameSpeed, Rotation } from '../game/types';
import type { CoasterLiftView } from '../game/coaster/lift';
import type { RideSnapshot } from '../game/rides/types';
import type { ObjectColours } from '../game/content/colours';
import type { PaintBrush, PaintTarget } from '../game/content/colourPresets';
import type { GuestSnapshot, ThoughtInsight } from '../game/guests/types';
import type { GuestCapacityView } from '../game/guests/GuestSimulation';
import type { ServiceSnapshot } from '../game/shops/types';
import type { ManagementSnapshot } from '../game/management/types';
import type { OnboardingSnapshot } from '../game/onboarding/types';
import type { Facing } from '../game/maps/types';
import type { ProgressionSnapshot } from '../game/progression/types';
import { slotCostTotal } from '../game/cards/content';
import type { ActiveCardSnapshot } from '../game/cards/types';
import type { ParkRuleset } from '../game/scenarios/rules';
import type { ScenarioSnapshot } from '../game/scenarios/types';
import type { GameMode } from '../game/modes/types';
import type { ActiveBonusSnapshot } from '../game/profile/bonuses';
import type { ProfileSnapshot, RunRewardResult, ScenarioRewardResult } from '../game/profile/types';
import type { PulseCardId } from '../game/cards/types';
import type { RunSnapshot, RunSummary } from '../game/run/types';
import type { ScenerySnapshot } from '../game/scenery/types';
import type { BuildingSnapshot } from '../game/session/types';
import type { WorkerSnapshot } from '../game/operations/types';
import type { BuildingsView } from './buildingsWindowModel';
import { loadWindowPrefs, saveWindowPrefs, type WindowId } from './windowPrefs';
import type { SavesSnapshot } from '../app/saves/types';
import type { RecoverySnapshot } from '../app/saves/recoveryTypes';
import type { UndoStatus } from '../app/undo/types';
import type { PhaseLabel, TimeLock } from '../game/calendar/calendarMath';
import type { NotificationClass } from '../settings/notify';
import { DEFAULT_WEATHER_UI, type WeatherUi } from './weatherModel';
import { EMPTY_UNDO_STATUS } from '../app/undo/constants';
import type { ViewRotation } from '../rendering/viewRotation';
import type { MenuKind, MenuPanel } from './menuModel';
import type { SaveSlotId } from '../app/saves/types';
import type { RunView } from './runViewModel';
import { toggleLoadoutCard as toggleRunLoadoutCard } from './runLoadoutModel';
import type { PlacementThemeView } from './themeCopy';
import type { CrowdUi } from './neighborhoodTypes';

/**
 * Exactly one tool is armed at all times, and only the player disarms it. `pointer` is the
 * resting tool: it inspects buildings and changes nothing. A click in the world never switches
 * tools, so placing a row of benches past a 3×3 ride cannot silently leave you empty-handed.
 */
export type ToolMode = 'pointer' | 'build' | 'bulldoze' | 'paint' | 'land';

/**
 * Phase 21: the park's land at a glance (published by GameApp when it changes). Null on a wholly owned map, where there is
 * nothing to buy and the Land tool is not offered.
 */
export interface LandUi {
  readonly ownedParcels: number;
  readonly totalParcels: number;
  readonly forSaleParcels: number;
  /** The cheapest parcel for sale now (null when none is for sale). */
  readonly cheapestPrice: number | null;
}

/**
 * The cursor readout of the Paint tool (written by GameApp on a hover change): what is under the cursor and
 * what a click would do. `muted` is for "nothing to paint here" lines.
 */
export interface PaintReadout {
  title: string;
  detail: string;
  muted: boolean;
}

export interface CoasterDraftSnapshot {
  typeName: string;
  maximumHeight: number;
  allowedSpecials: string[];
  pieces: number;
  height: number;
  baseCost: number;
  effectiveCost: number;
  stats: {
    excitement: number;
    intensity: number;
    durationSeconds: number;
    turns: number;
    drops: number;
    totalDescent: number;
    highestHeight: number;
    topSpeed: number;
    loops: number;
    boosts: number;
  } | null;
  validationMessage: string;
  buildable: boolean;
  affordable: boolean;
  lastPieceSpecial: string | null;
  /** One entry per lift (a maximal run of climbing pieces), in track order. */
  liftRuns: DraftLiftRun[];
  /** A free climb that crawls but is still allowed; null when there is nothing to warn about. */
  warning: string | null;
  /** Base cost the free climbs save compared with chaining every hill. */
  chainSavings: number;
}

export interface DraftLiftRun {
  start: number;
  length: number;
  chained: boolean;
  verdict: 'ok' | 'slow' | 'stalls';
}
export type ManagementTab = 'overview' | 'research' | 'buildings' | 'finances' | 'operations' | 'activity' | 'neighborhoods';

export type BuildingSort = 'position' | 'name' | 'queue' | 'revenue' | 'satisfaction' | 'condition';

export interface PerformanceStats {
  fps: number;
  simulationMs: number;
  renderMs: number;
  /** Total simulated entities. Not a visible count — nothing is culled yet. */
  entities: number;
  pathfindingRequests: number;
}

/**
 * Before the save manager reports, nothing is known: no slots, persistence still being checked.
 * The banner must not flash "unavailable" during that first moment, hence 'checking'.
 */
export const DEFAULT_SAVES_SNAPSHOT: SavesSnapshot = {
  slots: [],
  listState: 'idle',
  busy: { listing: false, saving: null, loading: null, mutating: null },
  persistence: { state: 'checking', code: null, message: null, bannerDismissed: false, writer: null },
  autosave: { state: 'off', indicator: 'hidden', lastSavedAt: null },
  unsavedChanges: false,
  quickSaveSlotId: null,
  lastError: null,
  notice: null,
};

/** Before detection has run nothing is known; 'checking' keeps the prompt from flashing. */
export const DEFAULT_RECOVERY_SNAPSHOT: RecoverySnapshot = { phase: 'checking', offer: null, error: null, notice: null };

/**
 * What the start screen's sweep is showing. `checking` until the save list, the recovery decision
 * and the preview read are all done; then `ready`, with the slot the park came from (null for the
 * empty starter map) and the slot revision that was read.
 */
export interface MenuPreview {
  phase: 'checking' | 'ready';
  slotId: SaveSlotId | null;
  revision: number | null;
}

/**
 * The leave-run question (Phase 23): the app raises it when the player is about to replace an unfinished run. The run at
 * stake is `run` (level, seed); `reason` is what comes next.
 */
export interface LeaveRunPrompt {
  reason: 'new-run' | 'new-park' | 'scenario' | 'load';
  /**
   * Asked from the start screen, where no run is live: the unfinished run the autosave holds (`autosavedRunAtStake`).
   * There is no park to save from there, so the prompt offers no "Save first". Absent in a live park.
   */
  saved?: RunSummary;
}

export const NO_MENU_PREVIEW: MenuPreview = { phase: 'checking', slotId: null, revision: null };

export interface UiState {
  cash: number;
  pathCount: number;
  objectCount: number;
  guestCount: number;
  tick: number;
  /**
   * The park calendar as primitives, written by GameApp on its 250 ms snapshot and after any load,
   * undo or setting change; never per frame. The chip shows the effective time (a fixed time of day
   * shows as such). `calendarEditable` is false in a scenario park.
   */
  dayNumber: number;
  clockText: string;
  phaseLabel: PhaseLabel;
  timeLock: TimeLock;
  dayLengthSeconds: number;
  calendarEditable: boolean;
  /**
   * Weather chip, forecast, opening hours and the Park Pulse weather lines as primitives. GameApp
   * writes it at 4 Hz and after any load, undo or setting change, and only when its key changed, so
   * a steady sky causes no re-render. The per-frame WeatherView never passes through React.
   */
  weatherUi: WeatherUi;
  parkOpen: boolean;
  speed: GameSpeed;
  activeCategory: BuildCategory;
  /** Phase 29: the build dock's filter per category (absent = 'all'); kept while switching categories. */
  buildFilters: Partial<Record<BuildCategory, string>>;
  selectedDefinitionId: string | null;
  tool: ToolMode;
  /** Quarter turns applied to the next placed building; kept between selections. */
  buildRotation: Rotation;
  /**
   * Phase 26: the view quarter turns the renderer actually shows (the compass reads it). Written
   * only by GameApp, never part of the world, the undo ring or the determinism hash. It stays 0
   * while the active renderer cannot rotate; GameApp keeps the park's own value separately.
   */
  viewRotation: ViewRotation;
  hoveredCell: Cell | null;
  previewCost: number;
  previewValid: boolean;
  /**
   * Why the hovered placement is refused, in the same words the click toast uses. Null when the
   * placement is fine. One string, one source, so the readout and the toast cannot disagree.
   */
  previewBlock: string | null;
  /** Phase 24: the bulldozer's headline over a prop it would clear ("Clear Red boulder · $180"); null = the tool's own name. */
  previewTitle: string | null;
  /**
   * Phase 16: what a themed scenery piece at the hovered cell would add to same-theme rides and stalls (from
   * `ScenerySimulation.previewThemeBonus`). Written by GameApp only when the hovered cell, the piece, its rotation or the
   * world changes; null for anything else.
   */
  previewTheme: PlacementThemeView | null;
  toast: string | null;
  /** The notification class of the current toast; picks its live region (alerts interrupt, the rest wait). */
  toastClass: NotificationClass;
  /** Counts every toast shown, so the same refusal twice is announced twice. */
  toastSeq: number;
  /**
   * Snapshot undo (Phase 12 step 3): what the next press rewinds, how far, and whether it needs a
   * second press. Written only by GameApp (through updateUiSnapshot) when `SnapshotUndo.refresh()`
   * reports a change.
   */
  undoStatus: UndoStatus;
  /** Interrupted-session recovery: written only by the recovery controller (through setRecoverySnapshot). */
  recovery: RecoverySnapshot;
  setRecoverySnapshot: (recovery: RecoverySnapshot) => void;
  /**
   * Key of the recovery banner the player closed (or that timed out), see `recoveryBanner`. UI
   * only: the controller's notice stays in `recovery`, this just stops one banner showing twice.
   */
  recoveryBannerDismissedKey: string | null;
  dismissRecoveryBanner: (key: string) => void;
  showGrid: boolean;
  showPerformance: boolean;
  performance: PerformanceStats;
  selectedRide: RideSnapshot | null;
  /**
   * The selected ride's colour record (Phase 28), or null for defaults. Written by GameApp together
   * with `selectedRide` whenever the world changes; the world replaces the record on every edit, so
   * its identity only moves when a colour does and a component selecting it re-renders only then.
   */
  selectedColours: ObjectColours | null;
  /**
   * The Paint tool's brush (Phase 28 step 2). UI state only: never saved, never in the world or the undo ring.
   * It also chooses the colour of the NEXT building while a colourable build card is armed (colour before
   * placing), so it outlives the tool.
   */
  paintBrush: PaintBrush;
  /** Which slots a swatch or default brush paints: Main, Accent or every part. A preset or copied brush paints every part. */
  paintTarget: PaintTarget;
  /** Eyedropper mode: the next click copies an object's colours into the brush instead of painting. */
  paintPicking: boolean;
  /** Build mode: the paint panel's brush parts are shown next to an armed colourable card (the "Colour" button). */
  paintPanelOpen: boolean;
  paintReadout: PaintReadout | null;
  selectPaint: (pick?: boolean) => void;
  setPaintBrush: (brush: PaintBrush) => void;
  setPaintTarget: (target: PaintTarget) => void;
  setPaintPicking: (picking: boolean) => void;
  setPaintPanelOpen: (open: boolean) => void;
  /** UI only: whether the inspector's Colours section is expanded. Remembered for the session. */
  colourPanelOpen: boolean;
  setColourPanelOpen: (open: boolean) => void;
  /** Speeds and chain cost of the selected custom coaster; null for anything else. */
  selectedCoasterLift: CoasterLiftView | null;
  selectedService: ServiceSnapshot | null;
  /**
   * Phase 30: the inspected guest (the pointer tool's click on a figure, or a complaint link), rebuilt by GameApp on
   * every UI sync from `GuestSimulation.guestSnapshot`; null with no guest inspected or once the guest has left.
   * Never saved. The three selections are exclusive: GameApp clears the other two when one is set.
   */
  selectedGuest: GuestSnapshot | null;
  /**
   * Phase 11 (PA-015): what demolishing the inspected ride or stall would refund (`world.demolitionRefund`), published by
   * GameApp with the selection; null with nothing inspected. A store field so `RideSnapshot` and `ServiceSnapshot` stay as
   * they are (they are hashed by the determinism observables).
   */
  selectedDemolitionRefund: number | null;
  /**
   * Phase 11 (PA-015): the object whose demolish confirmation is open in the inspector, or null. UI state only. Cleared
   * on a selection change, an inspector close and a session swap; Escape closes it before the inspector.
   */
  demolishConfirmId: number | null;
  openDemolishConfirm: (id: number) => void;
  closeDemolishConfirm: () => void;
  /**
   * Phase 11 (PA-009): the park's guest ceiling and what it is made of (`GuestSimulation.capacityView`), published by
   * GameApp at 4 Hz and on every world change, with a new object only when a number changed. Null before the first
   * publish.
   */
  guestCapacity: GuestCapacityView | null;
  /**
   * Phase 19: a fatal error after start (the frame loop threw, or no renderer could run): the app has stopped the park,
   * written an emergency autosave if it could, and the error screen replaces the game. Null while all is well.
   */
  fatalError: string | null;
  /** Phase 21: the park's land, or null on a wholly owned map (see LandUi). */
  land: LandUi | null;
  /**
   * Phase 11 (PA-009): the guest count has sat at the ceiling for 10 simulated seconds (`app/capacityNotice.ts`). App
   * state only: never saved, never a simulation notification, reset on a session swap.
   */
  atCapacity: boolean;
  /**
   * Phase 11 (PA-024): the rides and stalls no path from the gate reaches (`ManagementSimulation.hasPathAccess`), sorted
   * ascending. A new array only when the content changed, so a steady park causes no re-render.
   */
  noPathAccessIds: readonly number[];
  pulseInsights: ThoughtInsight[];
  management: ManagementSnapshot | null;
  buildings: BuildingSnapshot[];
  buildingSort: BuildingSort;
  progression: ProgressionSnapshot | null;
  /** First Day progression; null in scenario parks. Read by the First Day card in Park Pulse. */
  onboarding: OnboardingSnapshot | null;
  /**
   * Phase 24: the inward direction of the park's gate (a map property), so the First Day card can say which way the
   * park runs from the gate in the view the player sees. 'north' is the Meadow gate. Written by GameApp.
   */
  gateFacing: Facing;
  /**
   * Bumped by GameApp when a different park is installed (new park, load), never for an undo
   * rewind, so the First Day card never celebrates progress that belongs to another park.
   */
  parkEpoch: number;
  /** The one-time "Ready for The Map?" offer is showing in Park Pulse (Phase 23; it was the Park Tour offer). */
  mapOfferPending: boolean;
  setMapOfferPending: (pending: boolean) => void;
  scenery: ScenerySnapshot | null;
  scenario: ScenarioSnapshot | null;
  /** The Scenario-mode loadout layer is open (the browser's "Choose cards and start"); it is the only host left of the retired Parks map. */
  scenarioPickerOpen: boolean;
  scenarioResultDismissed: boolean;
  activeCards: ActiveCardSnapshot[];
  rewardDraft: string[] | null;
  coasterDraft: CoasterDraftSnapshot | null;
  sessionRules: ParkRuleset | null;
  loadoutScenarioId: string | null;
  loadoutCardIds: string[];
  // --- Phase 23: The Map (runs). The app owns the run and when the overlay opens; the screens own the sub-view. ---
  /** The run the running park belongs to, as structured data (`runSnapshotOf`); null outside a run. */
  run: RunSnapshot | null;
  /** The permanent bonuses the run's grant snapshot holds (they compile into every stage); written with `run`. Optional: null reads as the profile's bonuses for The Map. */
  runBonusIds: string[] | null;
  /** The run overlay: null = closed. See `runBridge.ts` for who sets what. */
  runView: RunView | null;
  /** The deck / used-pile drawer of the run map, or null. */
  runDrawer: 'deck' | 'used' | null;
  /** The cards ticked on the loadout screen (never saved: the loadout is locked when the stage starts). */
  runLoadoutSelection: PulseCardId[];
  /** What the profile answered when the run ended (rewards for the victory / run-over screens); null while it goes on. */
  runRewards: RunRewardResult | null;
  /** Leaving an unfinished run asks first; null when no question is open. */
  leaveRunPrompt: LeaveRunPrompt | null;
  setRunView: (view: RunView | null) => void;
  setRunDrawer: (drawer: 'deck' | 'used' | null) => void;
  toggleRunLoadoutCard: (cardId: string) => void;
  resetRunLoadoutSelection: () => void;
  /** Phase 22: the profile as GameApp publishes it (null until the app has built it); only when its revision changes. */
  profile: ProfileSnapshot | null;
  /** Phase 22: how the running park is played, its compiled permanent bonuses and the gated entries it has not got. */
  sessionMode: GameMode;
  /** Phase 33: the park's name for the top bar (`parkTitleOf`): the scenario, the Map level or the Sandbox map. */
  parkTitle: string;
  activeBonuses: ActiveBonusSnapshot[];
  profileLocks: Record<string, string>;
  /** Phase 22: what the last scenario result granted (null while running). */
  scenarioRewards: ScenarioRewardResult | null;
  managementOpen: boolean;
  /** Phase 42: the open windows (Staff, Buildings), oldest first: the last is on top and the first Esc closes it. */
  openWindows: WindowId[];
  /** Phase 42: every worker, published while the Staff window is open. */
  workers: WorkerSnapshot[];
  /** Phase 42: the Buildings window's filters, search and sort (remembered per player). */
  buildingsView: BuildingsView;
  toggleWindow: (id: WindowId) => void;
  closeWindow: (id: WindowId) => void;
  setBuildingsView: (patch: Partial<BuildingsView>) => void;
  /** Clean view: the build dock and every floating panel are hidden, nothing else changes. */
  cleanView: boolean;
  managementTab: ManagementTab;
  focusedResearchProjectId: string | null;
  showSceneryInfluence: boolean;
  /**
   * Phase 14: the crowd flow heatmap (voxel only). Exclusive with `showSceneryInfluence` (GameApp enforces it; the
   * store setter only records the flag).
   */
  showCrowdHeatmap: boolean;
  /** Phase 14: false under the classic renderer (the rail button is then `aria-disabled`). Written by GameApp. */
  crowdHeatmapSupported: boolean;
  /** Phase 14: neighborhood Pulse line, dashboard rows, Overview line and hover readout; null until published. */
  crowd: CrowdUi | null;
  /** Written only by the SaveManager (through setSavesSnapshot); the UI reads it. */
  saves: SavesSnapshot;
  /** Save/Load dialog visibility; it is an input context layer (see inputContext.ts). */
  savesDialogOpen: boolean;
  /**
   * The menu layer: `start` is the start screen over the sweep, `pause` the in-game menu. It is an
   * input context (`menu`, see inputContext.ts) and is written only by GameApp.
   */
  menuKind: MenuKind | null;
  menuPanel: MenuPanel;
  menuPreview: MenuPreview;
  /** One line of news inside the menu: an unreadable save, a failed Continue or a failed save-and-quit. */
  menuNotice: string | null;
  setMenuPanel: (panel: MenuPanel) => void;
  /** The settings panel. Not persisted; open it from non-React code with `openSettings()`. */
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  /** Sandbox time-settings popover from the clock chip; an input context layer (see inputContext.ts). */
  clockPopoverOpen: boolean;
  setClockPopoverOpen: (open: boolean) => void;
  setSavesSnapshot: (saves: SavesSnapshot) => void;
  openSavesDialog: () => void;
  closeSavesDialog: () => void;
  setCategory: (category: BuildCategory) => void;
  setBuildFilter: (category: BuildCategory, filterId: string) => void;
  selectBuild: (definitionId: string) => void;
  rotateBuild: () => void;
  selectBulldozer: () => void;
  /** Phase 21: arms the Land tool (click a parcel next to owned land to buy it). */
  selectLandTool: () => void;
  selectPointer: () => void;
  cancelTool: () => void;
  setHover: (cell: Cell | null, cost?: number, valid?: boolean, block?: string | null, title?: string | null) => void;
  setToast: (toast: string | null, cls?: NotificationClass) => void;
  setGrid: (show: boolean) => void;
  setPerformanceVisible: (show: boolean) => void;
  openManagement: (tab?: ManagementTab) => void;
  openResearch: (projectId?: string) => void;
  closeManagement: () => void;
  toggleCleanView: () => void;
  setManagementTab: (tab: ManagementTab) => void;
  setBuildingSort: (sort: BuildingSort) => void;
  setSceneryInfluenceVisible: (visible: boolean) => void;
  setCrowdHeatmapVisible: (visible: boolean) => void;
  closeScenarioPicker: () => void;
  /** The Scenario browser's "Choose cards and start": opens the loadout layer for Scenario mode (closing it returns to the browser). */
  openScenarioLoadout: (scenarioId: string) => void;
  closeLoadout: () => void;
  toggleLoadoutCard: (cardId: string, maximumSlots: number) => void;
  dismissScenarioResult: () => void;
  resetScenarioResult: () => void;
}

const INITIAL_WINDOW_PREFS = loadWindowPrefs();

export const useUiStore = create<UiState>((set) => ({
  // Only the value shown before the first session snapshot arrives; the world owns the real one.
  cash: GAME_CONFIG.startingCash,
  pathCount: 0,
  objectCount: 0,
  tick: 0,
  dayNumber: 1,
  clockText: '06:00',
  phaseLabel: 'Dawn',
  timeLock: 'auto',
  dayLengthSeconds: GAME_CONFIG.calendar.defaultDayLengthSeconds,
  calendarEditable: true,
  weatherUi: DEFAULT_WEATHER_UI,
  parkOpen: true,
  speed: 1,
  activeCategory: 'paths',
  buildFilters: {},
  selectedDefinitionId: 'sunstone-path',
  tool: 'build',
  buildRotation: 0,
  viewRotation: 0,
  hoveredCell: null,
  previewCost: 0,
  previewValid: true,
  previewBlock: null,
  previewTitle: null,
  previewTheme: null,
  toast: null,
  toastClass: 'alert',
  toastSeq: 0,
  undoStatus: EMPTY_UNDO_STATUS,
  recovery: DEFAULT_RECOVERY_SNAPSHOT,
  setRecoverySnapshot: (recovery) => set({ recovery }),
  recoveryBannerDismissedKey: null,
  dismissRecoveryBanner: (recoveryBannerDismissedKey) => set({ recoveryBannerDismissedKey }),
  showGrid: true,
  showPerformance: false,
  guestCount: 0,
  selectedRide: null,
  selectedColours: null,
  paintBrush: { kind: 'default' },
  paintTarget: 'primary',
  paintPicking: false,
  paintPanelOpen: false,
  paintReadout: null,
  selectPaint: (paintPicking = false) => set({ tool: 'paint', selectedDefinitionId: null, paintPicking, previewCost: 0, previewBlock: null, previewTitle: null }),
  setPaintBrush: (paintBrush) => set({ paintBrush }),
  setPaintTarget: (paintTarget) => set({ paintTarget }),
  setPaintPicking: (paintPicking) => set({ paintPicking }),
  setPaintPanelOpen: (paintPanelOpen) => set({ paintPanelOpen }),
  colourPanelOpen: false,
  setColourPanelOpen: (colourPanelOpen) => set({ colourPanelOpen }),
  selectedCoasterLift: null,
  selectedService: null,
  selectedGuest: null,
  selectedDemolitionRefund: null,
  demolishConfirmId: null,
  openDemolishConfirm: (demolishConfirmId) => set({ demolishConfirmId }),
  closeDemolishConfirm: () => set({ demolishConfirmId: null }),
  guestCapacity: null,
  fatalError: null,
  land: null,
  atCapacity: false,
  noPathAccessIds: [],
  pulseInsights: [],
  management: null,
  buildings: [],
  buildingSort: 'revenue',
  progression: null,
  onboarding: null,
  gateFacing: 'north',
  parkEpoch: 0,
  mapOfferPending: false,
  setMapOfferPending: (mapOfferPending) => set({ mapOfferPending }),
  scenery: null,
  scenario: null,
  scenarioPickerOpen: false,
  scenarioResultDismissed: false,
  activeCards: [],
  rewardDraft: null,
  coasterDraft: null,
  sessionRules: null,
  loadoutScenarioId: null,
  loadoutCardIds: [],
  run: null,
  runBonusIds: null,
  runView: null,
  runDrawer: null,
  runLoadoutSelection: [],
  runRewards: null,
  leaveRunPrompt: null,
  setRunView: (runView) => set({ runView, runDrawer: null }),
  setRunDrawer: (runDrawer) => set({ runDrawer }),
  toggleRunLoadoutCard: (cardId) => set((state) => (
    state.run === null ? {} : { runLoadoutSelection: toggleRunLoadoutCard(state.run, state.runLoadoutSelection, cardId) }
  )),
  resetRunLoadoutSelection: () => set({ runLoadoutSelection: [] }),
  profile: null,
  sessionMode: 'sandbox',
  parkTitle: '',
  activeBonuses: [],
  profileLocks: {},
  scenarioRewards: null,
  managementOpen: false,
  openWindows: INITIAL_WINDOW_PREFS.open,
  workers: [],
  buildingsView: INITIAL_WINDOW_PREFS.buildings,
  toggleWindow: (id) => set((state) => {
    const openWindows = state.openWindows.includes(id)
      ? state.openWindows.filter((open) => open !== id)
      : [...state.openWindows, id];
    saveWindowPrefs({ open: openWindows, buildings: state.buildingsView });
    return { openWindows };
  }),
  closeWindow: (id) => set((state) => {
    if (!state.openWindows.includes(id)) return {};
    const openWindows = state.openWindows.filter((open) => open !== id);
    saveWindowPrefs({ open: openWindows, buildings: state.buildingsView });
    return { openWindows };
  }),
  setBuildingsView: (patch) => set((state) => {
    const buildingsView = { ...state.buildingsView, ...patch };
    saveWindowPrefs({ open: state.openWindows, buildings: buildingsView });
    return { buildingsView };
  }),
  cleanView: false,
  managementTab: 'overview',
  focusedResearchProjectId: null,
  showSceneryInfluence: false,
  showCrowdHeatmap: false,
  crowdHeatmapSupported: true,
  crowd: null,
  saves: DEFAULT_SAVES_SNAPSHOT,
  savesDialogOpen: false,
  settingsOpen: false,
  menuKind: null,
  menuPanel: 'main',
  menuPreview: NO_MENU_PREVIEW,
  menuNotice: null,
  setMenuPanel: (menuPanel) => set({ menuPanel }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  clockPopoverOpen: false,
  setClockPopoverOpen: (clockPopoverOpen) => set({ clockPopoverOpen }),
  setSavesSnapshot: (saves) => set({ saves }),
  openSavesDialog: () => set({ savesDialogOpen: true }),
  closeSavesDialog: () => set({ savesDialogOpen: false }),
  performance: { fps: 60, simulationMs: 0, renderMs: 0, entities: 1, pathfindingRequests: 0 },
  setCategory: (activeCategory) => set({ activeCategory }),
  setBuildFilter: (category, filterId) => set((state) => ({ buildFilters: { ...state.buildFilters, [category]: filterId } })),
  selectBuild: (selectedDefinitionId) => set({ selectedDefinitionId, tool: 'build', paintPicking: false }),
  rotateBuild: () => set((state) => ({ buildRotation: ((state.buildRotation + 1) % 4) as Rotation })),
  selectBulldozer: () => set({ tool: 'bulldoze', selectedDefinitionId: null, paintPicking: false }),
  selectLandTool: () => set({ tool: 'land', selectedDefinitionId: null, paintPicking: false }),
  selectPointer: () => set({ tool: 'pointer', selectedDefinitionId: null, previewCost: 0, previewBlock: null, paintPicking: false }),
  // Escape steps the armed tool back to the pointer, and no further. It also closes the paint panel it opened.
  cancelTool: () => set({ tool: 'pointer', selectedDefinitionId: null, previewCost: 0, previewBlock: null, paintPicking: false, paintPanelOpen: false, paintReadout: null }),
  setHover: (hoveredCell, previewCost = 0, previewValid = true, previewBlock = null, previewTitle = null) =>
    set({ hoveredCell, previewCost, previewValid, previewBlock, previewTitle }),
  setToast: (toast, cls = 'alert') => set((state) => ({ toast, toastClass: cls, toastSeq: toast === null ? state.toastSeq : state.toastSeq + 1 })),
  setGrid: (showGrid) => set({ showGrid }),
  setPerformanceVisible: (showPerformance) => set({ showPerformance }),
  openManagement: (managementTab = 'overview') => set({ managementOpen: true, managementTab }),
  openResearch: (focusedResearchProjectId) => set({
    managementOpen: true,
    managementTab: 'research',
    focusedResearchProjectId: focusedResearchProjectId ?? null,
  }),
  closeManagement: () => set({ managementOpen: false }),
  toggleCleanView: () => set((state) => ({ cleanView: !state.cleanView })),
  setManagementTab: (managementTab) => set({ managementTab }),
  setBuildingSort: (buildingSort) => set({ buildingSort }),
  setSceneryInfluenceVisible: (showSceneryInfluence) => set({ showSceneryInfluence }),
  setCrowdHeatmapVisible: (showCrowdHeatmap) => set({ showCrowdHeatmap }),
  closeScenarioPicker: () => set({ scenarioPickerOpen: false, loadoutScenarioId: null, loadoutCardIds: [] }),
  openScenarioLoadout: (loadoutScenarioId) => set({ scenarioPickerOpen: true, loadoutScenarioId, loadoutCardIds: [] }),
  closeLoadout: () => set({ scenarioPickerOpen: false, loadoutScenarioId: null, loadoutCardIds: [] }),
  toggleLoadoutCard: (cardId, maximumSlots) => set((state) => {
    if (state.loadoutCardIds.includes(cardId)) {
      return { loadoutCardIds: state.loadoutCardIds.filter((id) => id !== cardId) };
    }
    // Slot cost (Phase 25): a rare takes two slots, so a card is added only when its cost fits in what is left.
    if (slotCostTotal([...state.loadoutCardIds, cardId] as PulseCardId[]) > maximumSlots) return {};
    return { loadoutCardIds: [...state.loadoutCardIds, cardId] };
  }),
  dismissScenarioResult: () => set({ scenarioResultDismissed: true }),
  resetScenarioResult: () => set({ scenarioResultDismissed: false }),
}));

export const updateUiSnapshot = (snapshot: Partial<UiState>): void => useUiStore.setState(snapshot);
