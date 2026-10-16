import { CARD_BY_ID } from '../game/cards/content';
import { COASTER_TYPE_BY_ID, coasterHangs, type CoasterSpecial, type CoasterTypeDefinition } from '../game/coaster/content';
import {
  COASTER_VALIDATION_TEXT,
  checkCoasterDesign,
  coasterBaseCost,
  deriveCoasterStats,
  isExclusiveCoasterPiece,
  trackPiecesMayCross,
  type CoasterPiece,
} from '../game/coaster/design';
import {
  describeCoasterLift,
  liftRunAtPiece,
  liftRunForTarget,
  liftRuns,
  normaliseLiftFlags,
  setLiftRunChained,
  toggleLiftRun,
  type CoasterLiftView,
} from '../game/coaster/lift';
import {
  EMPTY_LIFT_HISTORY,
  planDraftUndo,
  recordLiftToggle,
  type LiftToggleHistory,
} from './coasterDraftHistory';
import { draftRewardChoices } from '../game/cards/draft';
import type { ActiveCardSnapshot, PulseCardId } from '../game/cards/types';
import { ProfileManager, type ProfileStorage } from '../game/profile/ProfileManager';
import { PROFILE_STORAGE_KEY } from '../game/profile/schema';
import { rewardEligible } from '../game/profile/eligibility';
import { colourCostModeOf, type GameMode } from '../game/modes/types';
import type { RunRewardResult, ScenarioRewardResult } from '../game/profile/types';
import { SaveError, createParkSave, type ParkSave } from '../game/save/version';
import { BUILD_BY_ID } from '../game/content/catalog';
import type { GuestCapacityView, GuestSimulation } from '../game/guests/GuestSimulation';
import type { GuestSnapshot } from '../game/guests/types';
import { souvenirSellsNow } from '../game/guests/life';
import type { ManagementSimulation } from '../game/management/ManagementSimulation';
import type { OperationsSimulation } from '../game/operations/OperationsSimulation';
import type { StaffRole } from '../game/operations/types';
import type { ProgressionSimulation } from '../game/progression/ProgressionSimulation';
import type { ProgressionEvent } from '../game/progression/types';
import type { RideSimulation } from '../game/rides/RideSimulation';
import type { ScenerySimulation } from '../game/scenery/ScenerySimulation';
import { SCENARIO_BY_ID } from '../game/scenarios/content';
import type { ScenarioEvent, ScenarioId } from '../game/scenarios/types';
import { researchCostScaleOf } from '../game/scenarios/rules';
import {
  RUN_DIFFICULTY_LABELS, abandonRun as abandonRunState, acceptOffer, buildStage, createRun, forceStageOutcomeForDevelopment, isRunDifficulty,
  resolveStage, runHash, runOutcomeOf, runRewardEligible, runSnapshotOf, runSummaryOf, startStage,
  type RunDifficulty, type RunOutcome, type RunRefusalReason, type RunState,
} from '../game/run';
import { isMapSeed } from '../game/maps/recipe';
import { GAME_CONFIG } from '../game/config';
import { DEFAULT_MAP_ID, MAP_BY_ID, isMapId } from '../game/maps/content';
import { PROP_KIND_BY_ID, type PropKindId } from '../game/maps/props';
import type { MapId, MapLayout, MapRecipe } from '../game/maps/types';
import { BIOME_BY_ID } from '../game/biomes/content';
import { generateMap, generatedMapName, readRecipe } from '../game/maps/generator';

import { DEVELOPER_MODE } from './devMode';
import { getSettings, settingsStore, updateSettings } from '../settings/settingsStore';
import { effectiveUiScale } from '../settings/uiScale';
import { hudInsets } from '../ui/layoutModel';
import { muteToastText, nextMuteStep } from '../settings/muteToggle';
import type { VolumeLevel } from '../settings/schema';
import { shouldShowNotification, type NotificationClass } from '../settings/notify';
import { RENDERER_KIND } from './rendererFlag';
import { ParkSession, type PlayCardResult } from '../game/session/ParkSession';
import { DEV_PARK_CASH, DEV_PARK_CENTRE, seedDevPark } from '../game/session/devPark';
import type { ShopSimulation } from '../game/shops/ShopSimulation';
import { SimulationClock } from '../game/SimulationClock';
import { SOUVENIR_KINDS, footprintSize } from '../game/types';
import type { BuildDefinition, Cell, GameSpeed, PlacedObject, Rotation } from '../game/types';
import type { ColourEdit, ColourEditResult, GameWorld } from '../game/World';
import { UnsupportedRendererError, type CameraMotion, type RendererPort, type SeeThroughRequest, type ViewInfo } from '../rendering/RendererPort';
import { isViewRotation, turnView, type ViewRotation } from '../rendering/viewRotation';
import {
  activeInputContext,
  isRecoveryPromptOpen,
  isTextInputTarget,
  INPUT_CONTEXT_CAPABILITIES,
  planPeekKey,
  scopeActiveIn,
  type InputContext,
} from '../ui/inputContext';
import { resolveKeyAction } from '../settings/keybindings';
import { keyLabel } from '../settings/keyHints';
import { FeedbackTracker } from './feedback/feedbackTracker';
import { buildFeedbackReport, type FeedbackReport } from './alpha/feedbackReport';
import { consumeRecoverOnBoot } from './alpha/bootFlags';
import { degradationNotice } from './alpha/degradationNotice';
import { GAME_VERSION } from '../ui/aboutModel';
import { AudioEngine } from '../audio/AudioEngine';
import { createBrowserAudioContext } from '../audio/browserContext';
import { ambienceFor, soundForCue, volumesOf, wholeMapView } from '../audio/audioDirector';
import { describeLoadResult, planQuickSaveShortcut } from '../ui/saveLoadModel';
import {
  bootMenuDecision,
  describeUnreadableLatest,
  latestSave,
  menuBackTarget,
  menuEscapeStep,
  planQuit,
  slotsNewestFirst,
  type QuitChoiceId,
} from '../ui/menuModel';
import { hintMarkerKey, selectHintMarkers } from './hints/hintMarkers';
import { shouldOfferMap } from './firstRun';
import { registerRunCommands, type RunCommands } from '../ui/runBridge';
import { escapeRunLayer } from '../ui/runEscape';
import type { RunView } from '../ui/runViewModel';
import { autosavedRunAtStake, latestRunSlot } from './runSlots';
import { slotDisplayName } from './saves/autosaveGenerations';
import { pickGuest } from './guestPick';
import { createCameraSweep, sweepDayPhase, sweepZoomStep, type SweepPoint } from './cameraSweep';
import { START_MENU_DEFAULT } from './menuFlag';
import { onReducedMotionChange, reducedMotion } from '../settings/motion';
import { NO_MENU_PREVIEW, updateUiSnapshot, useUiStore, type LandUi, type LeaveRunPrompt, type ToolMode, type UiState } from '../ui/store';
import { parkTitleOf } from '../ui/modeLabels';
import { placementThemeViewOf, researchCardFaces, samePlacementThemeView } from '../ui/themeCopy';
import { createCalendarView, type TimeLock } from '../game/calendar/calendarMath';
import { calendarUiOf, type CalendarUi } from '../ui/clockModel';
import { WEATHER_KINDS, createWeatherView, type WeatherSeverity } from '../game/weather/types';
import { mapMetaOf } from './saves/mapMeta';
import { climateKindOf } from '../game/weather/climate';
import { weatherUiKey, weatherUiOf, type WeatherUi } from '../ui/weatherModel';
import { TIME_OVERRIDE } from './rendererFlag';
import { registerGameCommands, registerRecoveryCommands, registerSaveCommands, type GameCommands, type ParkStartRequest } from './gameBridge';
import { INITIAL_CAPACITY_NOTICE, stepCapacityNotice, type CapacityNoticeState } from './capacityNotice';
import { capacityToast } from '../ui/capacityModel';
import { INITIAL_CROWD_NOTICE, stepCrowdNotice, type CrowdNoticeState } from './crowdNotice';
import { buildCrowdUi, crowdHoverText, crowdUiEqual, CROWD_CLASSIC_TOAST } from '../ui/neighborhoodModel';
import type { CrowdHeatmapView } from '../game/crowd/types';
import {
  DEMOLISH_DURING_DRAFT_MESSAGE,
  PATH_BLOCKED_MESSAGE,
  clearHoverText,
  coasterArmedText,
  coasterHoverText,
  demolitionToast,
  pathBlockedMessage,
  permanentPropText,
  placementBlockReason,
  placementBlockToast,
  landHoverTitle,
  landRefusalText,
  shortfallMessage,
  unownedLandMessage,
} from './placementFeedback';
import { parcelCentre, parcelRect } from '../game/land/parcels';
import { DEFAULT_SANDBOX_NAME } from './saves/constants';
import { createRecoveryController } from './saves/recoveryController';
import { getOrCreateRecoveryMonitor } from './saves/recoveryMonitor';
import type { RecoveryController, RecoveryMonitor, RecoveryParkInfo } from './saves/recoveryTypes';
import { cardPlayedLabel, demolitionLabel, objectBuiltLabel, pathsBuiltLabel, recolourLabel } from './undo/gestureLabels';
import { withSlotColour } from './colourEdit';
import { lineCells } from './lineCells';
import { blockedDraftCells, extendPathDraft } from './pathDraft';
import { facingOnScreen } from './buildFacing';
import { roleLabel, workerName } from '../ui/staffWindowModel';
import { hasMeaningfulFront } from '../game/access';
import { ENTRANCE_COLOUR_ID, isColourable, normaliseObjectColours, sameObjectColours, type ObjectColours } from '../game/content/colours';
import { recolourCharge, type ColourCostMode } from '../game/content/colourCost';
import { COLOUR_PRESET_BY_ID, brushPrimaryRgb, paintTargetFor, placementRecord, presetRecord, sameBrush, type ColourPresetId, type PaintBrush } from '../game/content/colourPresets';
import { PaintGesture, judgePaint, pickBrush, resolvePaintTarget, type PaintHost } from './paintGesture';
import type { PointerModifiers } from '../rendering/RendererPort';
import { formatRewind } from './undo/rewindLabel';
import { ParkSnapshotUndo } from './undo/SnapshotUndo';
import type { UndoCapture, UndoEntry, UndoOutcome, UndoStatus } from './undo/types';
import { createSaveStore } from './saves/createSaveStore';
import { SaveManager, createDefaultSaveWriter, type LoadModule } from './saves/SaveManager';
import type {
  CapturedPark,
  LoadedPark,
  ParkPreview,
  SaveCommands,
  SaveHost,
  SaveStore,
  SaveWriter,
  StoreStatus,
} from './saves/types';

const safeLocalStorage = (): ProfileStorage | null => {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
};

/** What the player is told when the voxel renderer could not start and the classic one took over. */
const startFailureToast = (cause: unknown): string => {
  if (cause instanceof UnsupportedRendererError && cause.capability) {
    return cause.kind === 'software'
      ? 'Voxel renderer needs a hardware GPU — using the classic renderer'
      : 'Voxel renderer needs WebGL2 — using the classic renderer';
  }
  return 'Voxel renderer failed to start — using the classic renderer';
};

/**
 * Runs a callback in a later task through a MessageChannel: unlike setTimeout it is not clamped in
 * a background tab, and unlike requestIdleCallback it cannot be starved by a busy renderer. Falls
 * back to setTimeout where MessageChannel does not exist.
 */
const hopToNextTask = (callback: () => void): void => {
  if (typeof MessageChannel === 'undefined') {
    setTimeout(callback, 0);
    return;
  }
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    callback();
  };
  channel.port2.postMessage(null);
};

/** Layers that own the whole screen: the pause menu never opens beneath them. */
const OVERLAY_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>(['textInput', 'saveLoad', 'recovery', 'settings', 'rewardDraft', 'scenarioResult', 'loadout', 'runMap', 'leaveRun']);

/** The one message for a map that cannot be turned (a voxel GPU without the view code, `no-view-rotation`). */
const VIEW_ROTATION_UNAVAILABLE = 'Map rotation is not available on this graphics device';

const sameCell = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y;

const sameCapacityView = (a: GuestCapacityView | null, b: GuestCapacityView | null): boolean => (
  a === b || (a !== null && b !== null
    && a.ceiling === b.ceiling && a.rideSeats === b.rideSeats && a.rating === b.rating
    && a.crowdMultiplier === b.crowdMultiplier && a.hardMaximum === b.hardMaximum && a.blocked === b.blocked)
);

const sameIds = (a: readonly number[], b: readonly number[]): boolean => (
  a.length === b.length && a.every((id, index) => id === b[index])
);

/** The toast for a refused one-shot play (Phase 25): the session's own hint when it has one ("No ride is broken"). */
const playRefusalText = (reason: Extract<PlayCardResult, { ok: false }>['reason'], hint: string | undefined, name: string | null): string => {
  switch (reason) {
    case 'not-playable': return hint ?? `${name ?? 'That card'} cannot be played right now`;
    case 'already-played': return `${name ?? 'That card'} was already played this level`;
    case 'not-one-shot': return `${name ?? 'That card'} is in play all level: only one-shot cards are played`;
    case 'not-in-loadout': return 'That card is not in this level\'s loadout';
    case 'unknown': return 'That card does not exist';
    case 'not-a-run': return 'One-shot cards are played on The Map';
  }
};

/** Phase 40: the hover line of a building whose front looks onto no path (it can still be built). */
export const FRONT_FACES_NO_PATH = 'Front faces no path: guests cannot reach it. Press R to turn it.';

/** Phase 38: what stops a coaster draft from being built where it is (the designer's status line). */
const coasterConflictMessage = (conflict: 'blocked' | 'object' | 'path' | 'track' | null): string => {
  switch (conflict) {
    case 'track': return `Too close to other track: ${GAME_CONFIG.coaster.trackClearanceLevels} levels needed, and stations, loops and boosts cannot be crossed.`;
    case 'path': return `Track over a path must be at level ${GAME_CONFIG.coaster.pathClearanceHeight} or higher.`;
    case 'object': return 'The track runs into a building. Low objects (benches, bins, flowers) can go under raised track.';
    default: return 'The track crosses land you do not own, water or a prop.';
  }
};

/** Everything a test may replace; production passes nothing and gets IndexedDB, the hash worker and the lazy loader. */
export interface GameAppOptions {
  saveStore?: SaveStore;
  /** Defaults to the hash-in-a-worker writer over `saveStore`. */
  saveWriter?: SaveWriter;
  /** What Retry runs; defaults to the resilient store's `retry()` when it has one, else `init()`. */
  retrySaveStore?: () => Promise<StoreStatus>;
  loadModule?: () => Promise<LoadModule>;
  /**
   * Whether the game opens on the start screen. Defaults to the URL flag (`&menu=0` turns it off),
   * and to off outside a browser, so a test that does not ask for the menu is not behind one.
   */
  startMenu?: boolean;
  /** Where the profile lives; tests inject a memory storage to exercise the first run (Phase 23: the Park Tour option is gone). */
  profileStorage?: ProfileStorage | null;
}

export class GameApp implements GameCommands, RunCommands {
  private session = new ParkSession(null);
  readonly clock = new SimulationClock((stepMs) => {
    const events = this.session.step(stepMs);
    this.handleProgressionEvents(events.progression);
    this.handleScenarioEvents(events.scenario);
  });
  /**
   * Created by `mount`, not up front: which renderer runs depends on the URL flag, the voxel one is
   * loaded on demand, and a voxel renderer that cannot start is replaced by the classic one.
   */
  private renderer: RendererPort | null = null;

  get world(): GameWorld { return this.session.world; }
  get scenery(): ScenerySimulation { return this.session.scenery; }
  get rides(): RideSimulation { return this.session.rides; }
  get shops(): ShopSimulation { return this.session.shops; }
  get guests(): GuestSimulation { return this.session.guests; }
  get operations(): OperationsSimulation { return this.session.operations; }
  get progression(): ProgressionSimulation { return this.session.progression; }
  get management(): ManagementSimulation { return this.session.management; }
  private draftPath: Cell[] = [];
  private lastDraftCell: Cell | null = null;
  private coasterDraft: CoasterPiece[] = [];
  private coasterHeight = 0;
  private coasterLastCell: Cell | null = null;
  /** Phase 40: the cell R was pressed on: the ghost keeps the player's turn there instead of facing the path. */
  private manualFacingCell: Cell | null = null;
  /** Phase 38: the cell whose refused crossing was last toasted, so a drag over it says so once. */
  private coasterDraftRefusal: string | null = null;
  private coasterTypeId: string | null = null;
  /** Lift toggles made in the designer, so Ctrl+Z can take one back before it takes a piece. */
  private coasterLiftHistory: LiftToggleHistory = EMPTY_LIFT_HISTORY;
  private coasterLiftCache: { record: object; rules: object; view: CoasterLiftView } | null = null;
  private bulldozed = new Set<string>();
  private lastBulldozeCell: Cell | null = null;
  /** The cell a refusal toast just explained, so the readout does not repeat it. */
  private blockToastCell: Cell | null = null;
  private uiAccumulator = 0;
  private elapsedMs = 0;
  private pathfindingAccumulator = 0;
  private pathfindingRequestsPerSecond = 0;
  private selectedRideId: number | null = null;
  private selectedServiceId: number | null = null;
  /** Phase 30: the inspected guest; exclusive with the two above. Dropped when the guest leaves or a session swaps. */
  private selectedGuestId: number | null = null;
  private toastTimer = 0;
  private stopWatchingAutosaveSetting: (() => void) | null = null;
  private unsubscribeWorld: (() => void) | null = null;
  private unsubscribeUi: (() => void) | null = null;
  private viewInputEnabled = true;
  /**
   * Phase 26: the park's own map view in quarter turns, the value saved in the app block. It is
   * presentation and app state only: never in the world, the undo ring or the hash. What the
   * renderer shows (and the store's `viewRotation`) is this value, or 0 while the active renderer
   * cannot rotate, so a park saved turned keeps its view through a session on such a renderer.
   */
  private viewRotation: ViewRotation = 0;
  private toolCursor = 'crosshair';
  /** The see-through request: ONE object, mutated in place and handed to the renderer on change. */
  private readonly seeThroughRequest: SeeThroughRequest = { armed: false, peek: false };
  private armedDefinitionId: string | null = null;
  private destroyed = false;
  /** The element the renderer was mounted into, kept for a mid-game switch to the classic renderer. */
  private host: HTMLElement | null = null;
  /** Phase 22: the one writer of the profile key (unlocks, bonuses, records, discovered cards, run stats). */
  private readonly profile: ProfileManager;
  private unsubscribeProfile: (() => void) | null = null;
  /** Phase 23: what the player asked for when "Leave the run?" was raised; null while no prompt is up. */
  private pendingLeave: { go: () => void } | null = null;
  /** The start-menu panel the next quit to the menu lands on (null = the main one). */
  private quitPanel: 'the-map' | null = null;
  /**
   * Phase 30: the Parks chooser panel a pause-menu "save before you leave?" question leads to (the chooser replaces the
   * park, so it asks like Quit to menu). Set by openParksChooser, read once by quitToMenu, dropped whenever the pause menu
   * opens afresh, resumes or Quit to menu is asked, so a cancelled question cannot steer a later quit.
   */
  private chooserAfterQuit: 'modes' | 'scenarios' | 'collection' | null = null;
  /**
   * The app opens on a default sandbox park nobody chose. It is only worth autosaving once the
   * player starts, loads or edits a park; otherwise opening the game would, 15 seconds later,
   * overwrite yesterday's autosave with an empty sandbox.
   */
  private parkChosen = false;
  /** The key of the hint markers the renderer shows; '' is none. Reset whenever a renderer or park is swapped in. */
  private hintKey = '';
  /** Where the current First Day step points, refreshed at 4 Hz and on every sync (never per frame). */
  private hintFocus: readonly Cell[] = [];
  /** Whether this page session opens on the start screen (`&menu=0` and tests turn it off). */
  private readonly startMenuEnabled: boolean;
  /**
   * True while ONLY the start screen is up: the park behind it is a preview, so the save manager
   * sees no park (no autosave, no dirty tracking, no quick save), and no recovery marker exists.
   */
  private menuHold = false;
  /** The speed to give back when the pause menu closes with Resume. */
  private menuPausedSpeed: GameSpeed | null = null;
  /** The park the start screen's sweep is showing, as read from its slot; Continue adopts it. */
  private preview: ParkPreview | null = null;
  /** Bumped to cancel a preview read that is still in flight (Continue, New park, a load, quit). */
  private previewToken = 0;
  /** The session on screen is a starter nobody has touched: the empty boot park, or the backdrop for nothing to continue. */
  private starterShown = true;
  /** Whether the starter backdrop is the developer park (false only if its layout could not be stamped). */
  private starterIsDevPark = false;
  /** The preview is parked on the starter map until an open recovery offer is answered. */
  private previewWaitsForRecovery = false;
  // The centre of the current world (set on every session swap; the first session is built before this field).
  private readonly sweep = createCameraSweep({ centreX: this.session.world.width / 2, centreY: this.session.world.height / 2 });
  private readonly sweepPoint: SweepPoint = { x: this.session.world.width / 2, y: this.session.world.height / 2 };
  private sweepActive = false;
  private sweepStill = false;
  private sweepLastX = Number.NaN;
  private sweepLastY = Number.NaN;
  /** The zoom the sweep started from (its steps are added to it, and it is put back when the sweep stops); null: none. */
  private sweepBaseZoom: number | null = null;
  private sweepLastZoom = Number.NaN;
  /** The park's own time of day when the sweep started; the sweep's light runs on from it. */
  private sweepStartPhase = 0.5;
  private stopWatchingMotion: (() => void) | null = null;
  private readonly pristineWorldVersion: number;
  /**
   * Bumped when the player changes a park setting (day length, fixed time, opening hours, weather). The save manager
   * decides "unsaved changes" by a version number, and a setting is not a world edit, so the
   * version it sees is `saveVersion()`: this counter above the world version.
   */
  private settingsRevision = 0;
  /** Reused every frame by the ticker; the clock never allocates. */
  private readonly frameCalendar = createCalendarView();
  /** Reused every frame for the renderer's weather picture, and by the 4 Hz UI snapshot. */
  private readonly frameWeather = createWeatherView();
  private readonly uiWeather = createWeatherView();
  private readonly saves: SaveManager;
  private readonly saveCommands: SaveCommands;
  /** Tells a crash from a clean close; one per page, so a hot-reloaded module keeps one session id. */
  private readonly recoveryMonitor: RecoveryMonitor;
  private readonly recoveryController: RecoveryController;
  private unsubscribeRecovery: (() => void) | null = null;
  /** Whole-park snapshots, one per construction gesture; the Undo control and Ctrl+Z end here. */
  private readonly undo = new ParkSnapshotUndo({
    capture: () => this.captureForUndo(),
    worldVersion: () => this.undoStamp(),
    simulationTimeMs: () => this.clock.simulationTimeMs,
    cash: () => this.world.cash,
    scenarioRunning: () => !this.runHold() && (this.session.scenario?.currentStatus ?? 'running') === 'running',
    busy: () => this.swapping || this.saves.snapshot().busy.loading !== null,
    restore: (entry) => this.restoreSnapshot(entry),
    afterRestore: () => this.saves.notifyParkRewound(),
    now: () => Date.now(),
  });
  /** True while a session swap runs, so an undo cannot start inside another swap. */
  private swapping = false;
  /**
   * Phase 28: how many colour edits (and cosmetic undos) this app instance has applied, never reset.
   * A colour edit does not move `world.version` (a colour is not simulation state), so the undo ring's
   * "did the gesture change anything" stamp and the save layer's change token add this on top.
   */
  private colourEdits = 0;
  /**
   * Phase 25: how many one-shot cards this app instance has played, never reset. A play moves no `world.version` (its
   * money goes through `postTransaction`), so like a colour edit it enters the undo stamp and the save layer's token.
   */
  private cardPlays = 0;
  /** The Paint tool's gesture in progress (pointer down to up), null otherwise. */
  private paintGesture: PaintGesture | null = null;
  /** What each recolour entry charged (the default is 0 and then nothing is stored), so its undo can refund it. */
  private readonly recolourCharges = new Map<number, number>();
  /** Shift as the keyboard last said it, so the paint readout can follow the key (the gesture itself reads it at pointer down). */
  private shiftHeld = false;
  /** What the paint hover and the ghost were last drawn for: a change redraws them without waiting for a mouse move. */
  private lastTool: ToolMode = 'build';
  private lastPaintBrush: PaintBrush | null = null;
  private lastPaintTarget = 'primary';
  private lastPaintPicking = false;
  /** The ring entry the latest recolour opened, so further picks on the same ride join it. */
  private recolourEntry: { entryId: number; objectId: number } | null = null;
  /** What the bulldozer has taken out during the current drag, which names its undo entry. */
  private demolishedInDrag: string[] = [];
  /** How many of those were props cleared for a price (Phase 24); names the undo entry. */
  private clearedInDrag = 0;
  /** Props whose refusal was already toasted in this bulldozer drag. */
  private readonly refusedProps = new Set<number>();
  /** Phase 15: diffs the park into feedback cues (world effects now, sounds with the audio step). */
  private readonly feedback = new FeedbackTracker((effect) => {
    this.renderer?.showEffect?.(effect);
    const sound = soundForCue(effect, this.viewInfo, this.session);
    if (sound !== null) this.audio.play(sound);
  });
  /** Phase 15: the six-bus audio engine; silent until the first user gesture (`unlockAudio`). */
  private readonly audio = new AudioEngine(createBrowserAudioContext, volumesOf(getSettings()));
  /** Phase 15: what the camera shows, refreshed at 4 Hz for the on-screen test and the ambience. */
  private readonly viewInfo: ViewInfo = { zoom: 0.5, x0: 0, y0: 0, x1: 31, y1: 31 };
  private stopWatchingVolumes: (() => void) | null = null;
  /** Phase 21: what the published land UI was computed from (the world and its land revision). */
  private landUiKey: { world: GameWorld; revision: number } | null = null;
  /** The `__voxelDegraded` label already told to the player. */
  private degradationSeen: string | undefined = undefined;
  /** Phase 19: set once the frame loop threw (see enterFatal). */
  private fatal = false;
  /** The status object last written to the store, so an unchanged one is never written again. */
  private publishedUndoStatus: UndoStatus | null = null;
  /** The designer's own status, rebuilt only when its piece count changes. */
  private coasterUndoCache: { pieces: number; toggle: boolean; status: UndoStatus } | null = null;
  /**
   * Phase 11 (PA-009): the transient "at capacity" tracker (`capacityNotice.ts`), stepped by the 4 Hz snapshot with the
   * world tick. Never saved; reset on every session swap.
   */
  private capacityNotice: CapacityNoticeState = INITIAL_CAPACITY_NOTICE;
  /**
   * Phase 14: the Park Pulse neighborhood tracker (`crowdNotice.ts`), stepped on the 4 Hz cadence by the session tick;
   * never saved, reset on every session swap.
   */
  private crowdNotice: CrowdNoticeState = INITIAL_CROWD_NOTICE;
  /** Phase 14: the crowd heatmap view last handed to the renderer (null: hidden, or not pushed since a swap/mount). */
  private crowdHeatmapShown: Readonly<CrowdHeatmapView> | null = null;
  /**
   * Phase 11 (PA-015): the coaster a first bulldozer press armed; a second press on any of its cells demolishes it.
   * A press anywhere else, Escape, a right-click cancel, a tool change and a session swap disarm it. No timer.
   */
  private armedCoasterId: number | null = null;
  /** Phase 35: settles `firstFrame` on the first frame of the app (then null). */
  private resolveFirstFrame: (() => void) | null = null;
  /** Phase 35: resolves once the first world frame has been drawn (the idle prefetch of the lazy panels waits for it). */
  readonly firstFrame: Promise<void> = new Promise((resolve) => { this.resolveFirstFrame = resolve; });
  /** Phase 35: the Master level the mute key muted from, brought back by the next press (this session only). */
  private unmutedMasterVolume: VolumeLevel | null = null;

  constructor(options: GameAppOptions = {}) {
    const profileStorage = options.profileStorage !== undefined ? options.profileStorage : safeLocalStorage();
    this.profile = new ProfileManager(profileStorage);
    // Published only when the profile's revision moves (a start, a result, a switch, another tab), never per frame.
    updateUiSnapshot({ profile: this.profile.snapshot() });
    this.unsubscribeProfile = this.profile.subscribe(this.publishProfile);
    this.startMenuEnabled = options.startMenu ?? START_MENU_DEFAULT;
    this.pristineWorldVersion = this.session.world.version;
    this.feedback.attach(this.session);
    const store = options.saveStore ?? createSaveStore();
    this.recoveryMonitor = getOrCreateRecoveryMonitor(window as unknown as Record<string, unknown>);
    const resilient = store as SaveStore & { retry?: () => Promise<{ status: StoreStatus }> };
    this.saves = new SaveManager({
      host: this.saveHost,
      store,
      tabId: this.recoveryMonitor.sessionId,
      writer: options.saveWriter ?? createDefaultSaveWriter(store),
      publish: (snapshot) => useUiStore.getState().setSavesSnapshot(snapshot),
      loadModule: options.loadModule ?? (() => import('./saves/loadSave')),
      deferWrite: hopToNextTask,
      retryStore: options.retrySaveStore
        ?? (typeof resilient.retry === 'function' ? async () => (await resilient.retry!()).status : undefined),
    });
    this.saves.setAutosaveInterval(getSettings().autosaveMinutes * 60);
    this.stopWatchingAutosaveSetting = settingsStore.subscribe((state, previous) => {
      if (state.settings.autosaveMinutes !== previous.settings.autosaveMinutes) {
        this.saves.setAutosaveInterval(state.settings.autosaveMinutes * 60);
      }
      if (state.settings.uiScale !== previous.settings.uiScale) this.pushViewInsets();
    });
    // Before anything can start a park: until the player has decided about an interrupted session,
    // a park-start autosave must not replace the autosave they may want back.
    this.saves.holdAutosave();
    this.recoveryController = createRecoveryController({ monitor: this.recoveryMonitor, saves: this.saves });
    this.saveCommands = {
      saveToSlot: (id, name, saveOptions) => this.saves.saveToSlot(id, name, saveOptions),
      quickSave: () => this.saves.quickSave(),
      load: (id) => this.loadGame(id),
      rename: (id, name) => this.saves.rename(id, name),
      remove: (id) => this.saves.remove(id),
      refresh: () => this.saves.refresh(),
      retryPersistence: () => this.saves.retryPersistence(),
      dismissBanner: () => this.saves.dismissBanner(),
      resumeAutosaveHere: () => this.saves.resumeAutosaveHere(),
    };
  }

  async mount(host: HTMLElement): Promise<void> {
    const renderer = await this.mountRenderer(host);
    if (!renderer || this.destroyed) return;
    this.host = host;
    this.attachRenderer(renderer);
    this.unsubscribeWorld = this.world.subscribe(this.onWorldChanged);
    this.unsubscribeUi = useUiStore.subscribe(this.syncInputContext);
    // Before the first frame: the park behind the start screen must not tick, whatever the clock's default.
    if (this.startMenuEnabled) this.enterStartMenu();
    // Phase 19: the error screen's "Reload and recover" continues the newest save once the start screen has read it.
    if (this.startMenuEnabled && consumeRecoverOnBoot()) this.recoverWhenReady();
    this.syncUi();
    this.syncInputContext();
    registerGameCommands(this);
    registerRunCommands(this);
    registerSaveCommands(this.saveCommands);
    // Phase 15: audio exists only after the first gesture (browsers refuse it before, and a game must not start loud).
    window.addEventListener('pointerdown', this.unlockAudio, true);
    window.addEventListener('keydown', this.unlockAudio, true);
    this.stopWatchingVolumes = settingsStore.subscribe((state, previous) => {
      if (state.settings !== previous.settings) this.audio.setVolumes(volumesOf(state.settings));
    });
    window.addEventListener('keydown', this.handleShortcuts);
    window.addEventListener('keydown', this.handlePeekKey);
    window.addEventListener('keydown', this.trackShift);
    window.addEventListener('keyup', this.trackShift);
    window.addEventListener('keyup', this.handlePeekKey);
    window.addEventListener('blur', this.releasePeek);
    // Best effort: a hidden or closing page gets one autosave if the park changed. The interval
    // save bounds what a killed tab can lose.
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('pagehide', this.handlePageHide);
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    this.unsubscribeRecovery = this.recoveryController.subscribe((snapshot) => {
      useUiStore.getState().setRecoverySnapshot(snapshot);
      // An answered recovery offer frees the start screen to choose the park behind it.
      if (snapshot.phase === 'idle' && this.menuHold && this.previewWaitsForRecovery) void this.refreshMenuPreview();
    });
    useUiStore.getState().setRecoverySnapshot(this.recoveryController.snapshot());
    registerRecoveryCommands(this.recoveryController.commands);
    window.addEventListener('pageshow', this.handlePageShow);
    window.addEventListener('resize', this.pushViewInsets);
    window.addEventListener('storage', this.handleProfileStorage);
    // Detection needs the slot list, so it runs once init has read it. It never rejects and always
    // ends with autosave released or held for an offer.
    void this.saves.init().then(() => this.recoveryController.start()).then(() => this.onBootReady());
    // Developer builds expose the live objects so browser tests can compare a saved park with the
    // loaded one (tick, cash, state hash) without a second code path into the session.
    if (DEVELOPER_MODE) {
      (window as unknown as { __parksmithDev?: unknown }).__parksmithDev = {
        session: () => this.session,
        saves: this.saves,
        profile: this.profile,
        // Phase 23: the run, and the one development lever (latches a stage's result; one step later the app handles it).
        run: () => this.session.run,
        forceStageOutcome: (outcome: 'succeeded' | 'failed') => forceStageOutcomeForDevelopment(this.session, outcome),
        speed: () => this.clock.speed,
        undo: this.undo,
        recovery: this.recoveryController,
        clock: this.clock,
        recoveryMonitor: this.recoveryMonitor,
      };
    }
    // The voxel renderer started, but on a GPU that could not build all of it. Losing only the view
    // rotation keeps the full look; Q/E say so when pressed instead.
    const degraded = (window as unknown as { __voxelDegraded?: string }).__voxelDegraded;
    if (degraded && degraded !== 'no-view-rotation') {
      this.toast('Running the simplified voxel look on this GPU', 'routine');
    }
  }

  /** Everything that ties a freshly mounted renderer to the game: input, then the per-frame hook. */
  private attachRenderer(renderer: RendererPort): void {
    renderer.setInputHandlers({
      hover: (cell) => this.handleHover(cell),
      start: (cell, modifiers) => this.handleStart(cell, modifiers),
      move: (cell) => this.handleMove(cell),
      end: (cell) => this.handleEnd(cell),
      cancel: () => this.cancelOrStepBack(),
    });
    this.appTicker(renderer);
    // A fresh renderer starts at view 0; hand it the park's view at once (no turn animation).
    this.applyViewRotation(true);
    // Phase 36: the HUD's cover, so the camera clamp keeps the plot out from behind the dock and Park Pulse.
    this.pushViewInsets();
    // A fresh renderer shows no markers yet.
    this.hintKey = '';
    this.applyHints();
    // ...and no see-through state: hand it the current request again.
    this.lastSeeThroughArmed = false;
    this.lastSeeThroughPeek = false;
    this.pushSeeThrough();
    // Phase 14: only a renderer with `setCrowdHeatmap` (voxel) draws the crowd heatmap; the classic one (also after a GPU
    // fallback) turns the toggle off and disabled. A fresh renderer has no crowd layer yet: hand it the view again.
    const crowdSupported = typeof renderer.setCrowdHeatmap === 'function';
    const ui = useUiStore.getState();
    if (ui.crowdHeatmapSupported !== crowdSupported || (!crowdSupported && ui.showCrowdHeatmap)) {
      updateUiSnapshot({ crowdHeatmapSupported: crowdSupported, ...(crowdSupported ? {} : { showCrowdHeatmap: false }) });
    }
    this.crowdHeatmapShown = null;
    this.pushCrowdHeatmap(true);
  }

  /**
   * A mounted voxel renderer reported it can no longer draw (a lost WebGL context that never came
   * back, or came back unable to build the pipeline): replace it with the classic renderer in the
   * same host, as a failed mount does, and carry the view-input state over. The camera, the preview
   * and the selection start fresh; the park itself is the session, which the renderer never owned.
   */
  private async fallBackToClassic(failed: RendererPort, cause: unknown): Promise<void> {
    const host = this.host;
    if (this.destroyed || this.renderer !== failed || !host) return;
    console.error(cause);
    (window as unknown as { __voxelFailure?: string }).__voxelFailure =
      cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    try {
      failed.destroy();
    } catch (error) {
      // A dead context can make teardown throw; the classic renderer must still come up.
      console.error(error);
    }
    this.renderer = null;
    const classic = await this.mountClassicRenderer(host);
    if (!classic || this.destroyed) return;
    this.attachRenderer(classic);
    // A renderer that had to fall back does not sweep (a software or broken GPU is the case this protects).
    this.stopSweep();
    this.syncInputContext();
    this.toast('The GPU stopped responding — switched to the classic renderer');
  }

  /**
   * Mounts the renderer the URL asks for. The voxel renderer's module is imported only in voxel mode,
   * so the classic game never downloads or runs it. If it cannot start — no WebGL2, a software GPU,
   * a program that fails to link, a module that fails to load — the classic renderer takes over and
   * the player is told why. Null means the game was destroyed while mounting.
   */
  private async mountRenderer(host: HTMLElement): Promise<RendererPort | null> {
    if (RENDERER_KIND !== 'voxel') return this.mountClassicRenderer(host);
    let voxel: RendererPort | null = null;
    try {
      const { VoxelRenderer } = await import('../rendering/voxel/VoxelRenderer');
      if (this.destroyed) return null;
      voxel = new VoxelRenderer(this.session);
      this.renderer = voxel;
      await voxel.mount(host);
      if (this.destroyed) return null;
      const mounted = voxel;
      voxel.onFatalError?.((error) => { void this.fallBackToClassic(mounted, error); });
      return voxel;
    } catch (cause) {
      // A refusal can be an Error with no message (Firefox, browser check 2026-10-14): say what happened around it.
      console.error(cause, '(the voxel renderer could not start; using the classic renderer)');
      // Kept where a person can read it without hunting through a flooded console: type
      // `__voxelFailure` in the DevTools console after the classic renderer has taken over.
      (window as unknown as { __voxelFailure?: string }).__voxelFailure =
        cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      voxel?.destroy();
      this.renderer = null;
      if (this.destroyed) return null;
      const classic = await this.mountClassicRenderer(host);
      if (classic) {
        this.toast(startFailureToast(cause));
      }
      return classic;
    }
  }

  /**
   * Phase 34: the classic renderer (and with it most of Pixi's scene-graph code) is a lazy chunk like the voxel one,
   * imported only for `?renderer=classic` or a fallback, so the voxel game never downloads it. A chunk that fails to
   * load rejects like a failed mount did before.
   */
  private async mountClassicRenderer(host: HTMLElement): Promise<RendererPort | null> {
    const { WorldRenderer } = await import('../rendering/WorldRenderer');
    if (this.destroyed) return null;
    const classic = new WorldRenderer(this.session);
    this.renderer = classic;
    await classic.mount(host);
    return this.destroyed ? null : classic;
  }

  setSpeed(speed: GameSpeed): void {
    // Between two stages the park is a frozen backdrop: it never runs (Phase 23).
    if (speed !== 0 && this.runHold()) return;
    this.clock.setSpeed(speed);
    updateUiSnapshot({ speed });
  }

  togglePark(): void { this.world.setParkOpen(!this.world.parkOpen); }

  setDayLength(seconds: number): void {
    const calendar = this.session.calendar;
    const before = calendar.dayLengthSeconds;
    if (!calendar.setDayLength(seconds) || calendar.dayLengthSeconds === before) return;
    this.parkSettingChanged();
  }

  setTimeLock(lock: TimeLock): void {
    const calendar = this.session.calendar;
    const before = calendar.timeLock;
    if (!calendar.setTimeLock(lock) || calendar.timeLock === before) return;
    this.parkSettingChanged();
  }

  setWeatherEnabled(enabled: boolean): void {
    const before = this.session.weather.enabled;
    if (!this.session.setWeatherEnabled(enabled) || this.session.weather.enabled === before) return;
    this.parkSettingChanged();
  }

  setWeatherSeverity(severity: WeatherSeverity): void {
    const before = this.session.weather.severity;
    if (!this.session.setWeatherSeverity(severity) || this.session.weather.severity === before) return;
    this.parkSettingChanged();
  }

  setOpeningHours(enabled: boolean, open: number, close: number): void {
    const calendar = this.session.calendar;
    const before = `${calendar.hoursEnabled}${calendar.openHour}${calendar.closeHour}`;
    if (!this.session.setOpeningHours(enabled, open, close) || before === `${calendar.hoursEnabled}${calendar.openHour}${calendar.closeHour}`) return;
    this.parkSettingChanged();
  }

  /** Developer: step the current six hours through sunny, hot, cloudy, rain and storm. */
  cycleDevWeather(): void {
    if (!this.developerToolsAvailable()) return;
    const current = this.session.weatherViewInto(this.uiWeather).kind;
    const next = WEATHER_KINDS[(WEATHER_KINDS.indexOf(current) + 1) % WEATHER_KINDS.length];
    if (!this.session.weather.forceCurrentSlot(next, 0.8)) return;
    this.parkSettingChanged();
    this.toast(`Developer: weather set to ${next} for this slot`, 'routine');
  }

  /** What the save manager treats as the park's version: world edits plus calendar settings. */
  private saveVersion(): number {
    return this.settingsRevision * 2 ** 32 + this.world.version;
  }

  private parkSettingChanged(): void {
    this.settingsRevision += 1;
    updateUiSnapshot(this.calendarUi());
    this.publishWeatherUi();
  }

  /** Weather chip, forecast, hours and Pulse lines as primitives, written only when something visible changed. */
  private weatherUi(): WeatherUi {
    const session = this.session;
    const view = session.weatherViewInto(this.uiWeather);
    const calendar = session.calendar;
    const biome = session.world.biome;
    return weatherUiOf({
      enabled: view.enabled,
      kind: view.kind,
      intensity: view.intensity,
      severity: session.weather.severity,
      editable: calendar.isEditable,
      stormClosedRides: this.rides.stormClosedCount(),
      parkOpen: this.world.parkOpen,
      forecast: session.weatherForecast(),
      day: view.day,
      biomeId: biome.id,
      climate: climateKindOf(biome.temperature),
      climateLabel: biome.climateLabel,
      // Phase 30: the souvenir stall inspector's "Demand now" line uses the guests' own desire rule.
      sellingSouvenirs: SOUVENIR_KINDS.filter((kind) => souvenirSellsNow(kind, session.weather.conditions)),
      hours: {
        hoursEnabled: calendar.hoursEnabled,
        openHour: calendar.openHour,
        closeHour: calendar.closeHour,
        scheduleOpen: session.weather.conditions.scheduleOpen,
      },
    });
  }

  /** The current weather UI, or the very object already in the store when nothing visible changed. */
  private keyedWeatherUi(): WeatherUi {
    const ui = this.weatherUi();
    const current = useUiStore.getState().weatherUi;
    return weatherUiKey(ui) === weatherUiKey(current) ? current : ui;
  }

  private publishWeatherUi(): void {
    updateUiSnapshot({ weatherUi: this.keyedWeatherUi() });
  }

  /** The clock as primitives for the store; a pinned time of day shows as such. */
  private calendarUi(): CalendarUi {
    const calendar = this.session.calendar;
    return calendarUiOf(calendar.view(), calendar.dayLengthSeconds, calendar.isEditable, calendar.timeLock);
  }

  /**
   * Every developer command routes through here, so the flag is enforced at the command layer and
   * not only by hiding buttons — nothing reachable from a normal session can cheat.
   */
  private developerToolsAvailable(): boolean {
    if (DEVELOPER_MODE) return true;
    this.toast('Developer tools are disabled — turn them on in Settings');
    return false;
  }

  addMoney(): void {
    if (!this.developerToolsAvailable()) return;
    this.world.addMoney(5_000);
    this.toast('Developer grant: +$5,000', 'routine');
  }

  spawnGuests(): void {
    if (!this.developerToolsAvailable()) return;
    const spawned = this.guests.spawnGuests(25);
    this.syncUi();
    this.toast(`${spawned} test guests arrived`, 'routine');
  }

  /** Developer: fill the park to the guest cap in one go, for load testing. */
  fillGuests(): void {
    if (!this.developerToolsAvailable()) return;
    const spawned = this.guests.spawnGuests(GAME_CONFIG.guests.maximum);
    this.syncUi();
    this.toast(spawned > 0
      ? `${spawned} guests arrived · ${this.guests.guests.size} of ${GAME_CONFIG.guests.maximum}`
      : 'The park is already at the guest cap', spawned > 0 ? 'routine' : 'alert');
  }

  /**
   * Developer: a sandbox park that starts fully built — street grid, twelve rides, a coaster,
   * every service, bins, and a working budget — for testing at a thousand guests.
   */
  startDevPark(): void {
    if (!this.developerToolsAvailable()) return;
    this.startScenario(null);
    const report = seedDevPark(this.session);
    this.syncUi();
    this.toast(report.skipped.length > 0
      ? `Dev park started with ${report.skipped.length} plot(s) skipped — see the console`
      : `Dev park ready · ${report.rides} rides · ${report.services} services · $${DEV_PARK_CASH.toLocaleString()}`, 'routine');
    if (report.skipped.length > 0) console.warn('Dev park plots skipped:', report.skipped);
  }

  removeGuests(): void {
    if (!this.developerToolsAvailable()) return;
    const removed = this.guests.guests.size;
    this.guests.removeAll();
    this.syncUi();
    this.toast(`${removed} guests removed`, 'routine');
  }

  /** Phase 11 (PA-021): the player's own recentres (brand button, ⌂, the recentre key) pass `'ease'`; the rest snap. */
  focusEntrance(motion?: CameraMotion): void { this.renderer?.focusEntrance(motion); }

  /** Turns the building under the cursor a quarter turn; the blueprint follows immediately. */
  rotateBuild(): void {
    const state = useUiStore.getState();
    const definition = state.selectedDefinitionId ? BUILD_BY_ID.get(state.selectedDefinitionId) : undefined;
    if (!definition || definition.kind === 'path' || definition.custom) {
      this.toast('This piece has nothing to rotate');
      return;
    }
    state.rotateBuild();
    // Phase 40: a turn the player chose is not undone by the auto-facing while the pointer stays on this cell.
    this.manualFacingCell = this.renderer?.hoveredCell ? { ...this.renderer.hoveredCell } : null;
    const [width, depth] = footprintSize(definition, this.buildRotation());
    // Phase 40: every building faces one of four ways; say where its front now points on screen.
    const facing = hasMeaningfulFront(definition) ? ` · front ${facingOnScreen(this.buildRotation(), this.viewRotation)}` : '';
    this.toast(`${definition.name} · ${width}×${depth}${facing}`, 'routine');
    const hovered = this.renderer?.hoveredCell;
    if (hovered) this.handleHover(hovered);
  }

  /** Q / E and the on-screen buttons: turns the whole map view a quarter turn. The build rotation (R) is untouched. */
  rotateView(step: 1 | -1): void {
    const renderer = this.renderer;
    // Both renderers turn; the voxel one gives it up only on a GPU that could not build the view code.
    if (!renderer?.supportsViewRotation || !renderer.setViewRotation) {
      this.toast(VIEW_ROTATION_UNAVAILABLE);
      return;
    }
    // A held drag picked its cells in the current orientation; joining them to a cell picked in the
    // turned one would run a straight world line across the map. The turn waits for the release.
    if (renderer.gestureHeld) {
      this.toast('Release the mouse button to turn the view');
      return;
    }
    this.viewRotation = turnView(this.viewRotation, step);
    this.applyViewRotation(false);
    // The view rides in the save's app block: the autosave (and crash recovery) must pick it up even
    // on a paused park, without counting as an unsaved edit.
    this.saves.markAppStateChanged();
  }

  /** Sets the park's view (a load, a new park) and shows it immediately; the park's value survives a renderer that cannot turn. */
  private setParkViewRotation(rotation: ViewRotation): void {
    this.viewRotation = rotation;
    this.applyViewRotation(true);
  }

  /**
   * Pushes the park's view to the renderer and the store. `instant` (or reduced motion) skips the
   * turn animation. The picture and the compass change in the same call, so the compass never
   * disagrees with the map.
   */
  private applyViewRotation(instant: boolean): void {
    const renderer = this.renderer;
    const turning = renderer?.supportsViewRotation === true && renderer.setViewRotation !== undefined;
    if (turning) renderer.setViewRotation?.(this.viewRotation, instant || reducedMotion());
    // A renderer may give the rotation up while turning (a runtime failure puts the picture back at view 0).
    const gaveUp = turning && renderer.supportsViewRotation !== true;
    if (gaveUp) this.toast(VIEW_ROTATION_UNAVAILABLE);
    const shown: ViewRotation = turning && !gaveUp ? this.viewRotation : 0;
    if (useUiStore.getState().viewRotation !== shown) updateUiSnapshot({ viewRotation: shown });
  }

  private buildRotation(): Rotation {
    return useUiStore.getState().buildRotation;
  }

  setGridVisible(visible: boolean): void { this.renderer?.setGridVisible(visible); }

  /**
   * Centres the camera on one building and selects it, from the estate overview and (Phase 30) from a complaint link in
   * Park Pulse, the Activity tab or the guest inspector. The management dashboard closes so the inspector is visible
   * (the Phase 11 open item); the Pulse link needs no dashboard to be open in the first place.
   */
  /**
   * Phase 36: the HUD's cover of the world view in CSS px at the current UI scale (layoutModel `hudInsets`), with the
   * inspector beside Park Pulse when `inspector`.
   */
  private viewInsets(inspector: boolean): ReturnType<typeof hudInsets> {
    const width = typeof window === 'undefined' ? 0 : window.innerWidth;
    const height = typeof window === 'undefined' ? 0 : window.innerHeight;
    const ui = useUiStore.getState();
    return hudInsets(effectiveUiScale(getSettings().uiScale, width, height), inspector, ui.openWindows.length > 0, ui.dockOpen);
  }

  /** Phase 36: hands the camera clamp the HUD's cover (on mount, a resize or a UI scale change). */
  private readonly pushViewInsets = (): void => {
    this.renderer?.setViewInsets?.(this.viewInsets(false));
  };

  focusBuilding(objectId: number): void {
    const object = this.world.objects.get(objectId);
    if (!object) return;
    const ui = useUiStore.getState();
    // Inspecting from the Buildings tab is the pointer's job: the paint panel and the inspector share one slot.
    if (ui.tool === 'paint') ui.selectPointer();
    if (ui.managementOpen) ui.closeManagement();
    this.selectedGuestId = null;
    const footprint = this.world.objectFootprint(object);
    const centre = footprint.reduce(
      (total, cell) => ({ x: total.x + cell.x / footprint.length, y: total.y + cell.y / footprint.length }),
      { x: 0, y: 0 },
    );
    const definition = BUILD_BY_ID.get(object.definitionId);
    // A player-initiated move: the camera eases there (the voxel renderer; the classic one snaps). Phase 36: into the
    // middle of what the HUD leaves uncovered, beside the inspector it opens, not under it (at 1100x690 the inspector
    // hid the whole building).
    const opensInspector = definition?.kind === 'ride' || definition?.stats?.serviceType !== undefined;
    this.renderer?.focusCell(centre, 'ease', this.viewInsets(opensInspector));
    this.closeDemolishConfirmUnless(object.id);
    if (definition?.kind === 'ride') {
      this.selectedRideId = object.id;
      this.selectedServiceId = null;
    } else if (definition?.stats?.serviceType) {
      this.selectedServiceId = object.id;
      this.selectedRideId = null;
    } else {
      this.selectedRideId = null;
      this.selectedServiceId = null;
    }
    this.renderer?.selectObject(object);
    this.syncUi();
  }

  closeInspector(): void {
    this.selectedRideId = null;
    this.selectedServiceId = null;
    this.selectedGuestId = null;
    this.renderer?.selectObject(null);
    updateUiSnapshot({
      selectedRide: null, selectedColours: null, selectedCoasterLift: null, selectedService: null, selectedGuest: null,
      selectedDemolitionRefund: null, demolishConfirmId: null,
    });
  }

  /**
   * Phase 30: opens the guest inspector on one guest (the pointer's click on a figure, or the bridge). The ride and
   * stall selection and the renderer's highlight go; a guest who is not in the park is ignored.
   */
  selectGuest(guestId: number): void {
    if (this.guests.guestSnapshot(guestId) === null) return;
    const ui = useUiStore.getState();
    if (ui.tool === 'paint') ui.selectPointer();
    if (ui.demolishConfirmId !== null) ui.closeDemolishConfirm();
    this.selectedRideId = null;
    this.selectedServiceId = null;
    this.selectedGuestId = guestId;
    this.renderer?.selectObject(null);
    this.syncUi();
  }

  /** Phase 30: the inspected guest's live snapshot; a guest who has left closes the inspector (the id is dropped). */
  private selectedGuestUi(): GuestSnapshot | null {
    if (this.selectedGuestId === null) return null;
    const snapshot = this.guests.guestSnapshot(this.selectedGuestId);
    if (snapshot === null) this.selectedGuestId = null;
    return snapshot;
  }

  /** A selection change closes a demolish confirmation that belongs to another object. */
  private closeDemolishConfirmUnless(objectId: number): void {
    const open = useUiStore.getState().demolishConfirmId;
    if (open !== null && open !== objectId) useUiStore.getState().closeDemolishConfirm();
  }

  /**
   * Phase 11 (PA-015): the inspector's Demolish (and its confirmation, which Delete opens). One undo entry named after
   * the object ("Comet Coaster demolished"), the bulldozer's routine receipt, then the inspector closes. Refused while a
   * coaster layout is open: undoing the demolition swaps the session back, which would discard the layout.
   */
  demolishSelected(): void {
    const objectId = this.selectedObjectId();
    const object = objectId === null ? undefined : this.world.objects.get(objectId);
    if (!object || this.menuBlocksWorld()) return;
    if (this.coasterDraft.length > 0) {
      this.toast(DEMOLISH_DURING_DRAFT_MESSAGE);
      return;
    }
    // A gesture still pending (a pointer-up that never came) is committed first, as a new press would.
    this.finishPaintGesture();
    this.finishDemolitionGesture();
    this.undo.begin('demolition');
    // Phase 15: the refund pops where the building stood (its footprint centre, read before it goes).
    const footprint = this.world.objectFootprint(object);
    const centre = footprint.length === 0 ? object.anchor : footprint[Math.floor(footprint.length / 2)];
    const result = this.world.demolishObject(object.id);
    if (!result.removed) {
      this.undo.abandon();
      return;
    }
    const label = result.label ?? BUILD_BY_ID.get(object.definitionId)?.name ?? 'a building';
    this.feedback.money(result.refund, centre.x, centre.y);
    this.commitGesture(demolitionLabel([label]));
    this.toast(demolitionToast([label], result.refund), 'routine');
    this.closeInspector();
  }

  setSelectedRideOpen(open: boolean): void {
    if (this.selectedRideId === null) return;
    this.rides.setOpen(this.selectedRideId, open);
    this.syncUi();
  }

  adjustSelectedRidePrice(delta: number): void {
    if (this.selectedRideId === null) return;
    const ride = this.rides.getRide(this.selectedRideId);
    if (!ride) return;
    this.rides.setTicketPrice(this.selectedRideId, ride.ticketPrice + delta);
    this.syncUi();
  }

  /** The inspected object: a ride (coasters included) or a stall or facility. */
  private selectedObjectId(): number | null {
    return this.selectedRideId ?? this.selectedServiceId;
  }

  /** Phase 28: one swatch (or null for the default) into one slot of the inspected ride, coaster, stall or facility. */
  setSelectedObjectColour(slot: number, swatch: number | null): void {
    const objectId = this.selectedObjectId();
    const object = objectId === null ? undefined : this.world.objects.get(objectId);
    if (!object) return;
    const next = withSlotColour(object.definitionId, this.world.objectColours(object.id), slot, swatch);
    if (!next) return;
    this.recolour(object.id, () => this.world.setObjectColours(object.id, next));
  }

  /** Phase 28: the inspected object back to its default colours. */
  resetSelectedObjectColours(): void {
    const objectId = this.selectedObjectId();
    if (objectId === null || !this.world.objects.has(objectId)) return;
    this.recolour(objectId, () => this.world.clearObjectColours(objectId));
  }

  /** Where the park is played, for what a recolour costs: free in the Sandbox, priced in a Scenario or on The Map. */
  private colourCostMode(): ColourCostMode {
    return colourCostModeOf(this.session.mode);
  }

  /** The fee of recolouring `objects` things now (0 unless the config and the park's rule say otherwise). */
  private recolourFee(objects: number): number {
    return recolourCharge(this.colourCostMode(), objects, this.session.rules.recolourCostMultiplier);
  }

  /**
   * One colour edit as an undo gesture. The snapshot is taken before the edit, outside any batch; the
   * ring keeps it only if the stamp moved (a pick of the colour already there changes nothing and
   * leaves no entry). While the newest ring entry is this ride's own recolour, further picks join it
   * instead of taking a new one, so trying twenty swatches is one Undo and cannot push the player's
   * construction history out of a ring of twenty. A series is charged once (by the pick that opens it).
   */
  private recolour(objectId: number, edit: () => ColourEditResult): void {
    const open = this.recolourEntry;
    const joins = open !== null && open.objectId === objectId && !this.undo.hasPending
      && this.undo.newest?.id === open.entryId;
    const fee = joins ? 0 : this.recolourFee(1);
    if (fee > this.world.cash) {
      this.toast(`Not enough cash to recolour · $${fee.toLocaleString()} needed, $${Math.floor(this.world.cash).toLocaleString()} available`);
      return;
    }
    const began = !joins && this.undo.begin('recolour');
    const result = edit();
    if (!result.ok || !result.changed) {
      if (!joins) this.undo.abandon();
      return;
    }
    this.noteColourEdit();
    if (!joins) {
      const before = this.undo.newest;
      this.undo.commit(recolourLabel(BUILD_BY_ID.get(this.world.objects.get(objectId)?.definitionId ?? '')?.name ?? 'Ride'));
      const entry = this.undo.newest;
      // Only an entry this pick really opened may be joined: after a failed capture (no snapshot, no
      // entry) the newest entry is another gesture's, maybe another ride's recolour, and joining it
      // would let one Undo take back both rides.
      this.recolourEntry = began && entry !== before && entry?.kind === 'recolour' ? { entryId: entry.id, objectId } : null;
      if (fee > 0) {
        this.world.postTransaction(-fee, 'Repainting', 'construction');
        if (this.recolourEntry) this.recolourCharges.set(this.recolourEntry.entryId, fee);
        this.syncUi();
      }
    }
    this.publishUndoStatus();
  }

  // --- Phase 28 step 2: the Paint tool, presets and colour before placing ------------------------------------------

  /** What a Paint gesture needs of the app: the world, the undo ring, the cost mode, and how to tell the app a colour moved. */
  private paintHost(): PaintHost {
    return {
      world: this.world,
      undo: this.undo,
      mode: () => this.colourCostMode(),
      multiplier: () => this.session.rules.recolourCostMultiplier,
      onChanged: () => {
        this.noteColourEdit();
        // A paint entry is never joined by an inspector pick (those join only their own ride's entry).
        this.recolourEntry = null;
      },
      toast: (text) => this.toast(text),
    };
  }

  /** The record the next building of `definitionId` is placed with (the brush's colours), or null for its shipped colours. */
  private nextColours(definitionId: string | null): ObjectColours | null {
    return definitionId === null ? null : placementRecord(definitionId, useUiStore.getState().paintBrush);
  }

  /**
   * The cursor over the map with the Paint tool: what is under it, the outline (through the renderer's overlay
   * seam) and the readout of what a click would do. Nothing here changes the world.
   */
  private hoverPaint(cell: Cell): void {
    const state = useUiStore.getState();
    const picking = state.paintPicking;
    const title = picking ? 'Pick' : 'Paint';
    const target = resolvePaintTarget(this.world, cell);
    let readout: { title: string; detail: string; muted: boolean };
    if (!target) {
      this.renderer?.setPaintHover?.(null);
      readout = { title, detail: picking ? 'Click a building to copy its colours' : 'Click or drag over buildings', muted: true };
    } else {
      const current = target.kind === 'gate' ? this.world.gateColours : this.world.objectColours(target.objectId);
      if (picking) {
        const brush = pickBrush(this.world, target);
        this.renderer?.setPaintHover?.(brush ? { cells: target.cells, tint: null } : null);
        readout = brush
          ? { title: `${title} · ${target.name}`, detail: 'Click to copy its colours', muted: false }
          : { title: `${title} · ${target.name}`, detail: judgePaint(target, current, state.paintBrush, state.paintTarget).text, muted: true };
      } else {
        const verdict = judgePaint(target, current, state.paintBrush, paintTargetFor(state.paintTarget, this.shiftHeld));
        const paintable = verdict.kind !== 'skip';
        this.renderer?.setPaintHover?.(paintable ? { cells: target.cells, tint: brushPrimaryRgb(state.paintBrush) } : null);
        readout = { title: `${title} · ${target.name}`, detail: verdict.text, muted: !paintable || verdict.kind === 'same' };
      }
    }
    const previous = state.paintReadout;
    state.setHover(cell);
    if (!previous || previous.title !== readout.title || previous.detail !== readout.detail || previous.muted !== readout.muted) {
      updateUiSnapshot({ paintReadout: readout });
    }
  }

  /** The eyedropper's click: the object's colours become the brush. A pick changes no world state and makes no undo entry. */
  private pickColoursAt(cell: Cell): void {
    const target = resolvePaintTarget(this.world, cell);
    if (!target) return;
    const brush = pickBrush(this.world, target);
    if (!brush) {
      this.toast(judgePaint(target, null, { kind: 'default' }, 'primary').text, 'routine');
      return;
    }
    const ui = useUiStore.getState();
    ui.setPaintBrush(brush);
    ui.setPaintPicking(false);
    this.toast(`Picked the colours of ${target.name}`, 'routine');
  }

  /** Pointer up, a cancel, a tool change or the next pointer down: the gesture's changes become one undo entry and one charge. */
  private finishPaintGesture(): void {
    const gesture = this.paintGesture;
    if (!gesture) return;
    this.paintGesture = null;
    const outcome = gesture.end();
    if (outcome.charge > 0 && outcome.entryId !== null) this.recolourCharges.set(outcome.entryId, outcome.charge);
    this.recolourEntry = null;
    this.publishUndoStatus();
    if (outcome.changed > 0) {
      this.syncUi();
      if (!outcome.stoppedForCash) {
        this.toast(outcome.charge > 0 ? `${outcome.label} · -$${outcome.charge.toLocaleString()}` : outcome.label, 'routine');
      }
    } else if (outcome.lastSkip !== null && !outcome.stoppedForCash) {
      this.toast(outcome.lastSkip, 'routine');
    }
  }

  /**
   * "Apply to whole park": a named preset on every colourable object and the gate, as ONE undo entry (and one
   * charge for the things that really change). Objects that already match are neither counted nor charged.
   */
  applyPresetToPark(presetId: ColourPresetId): void {
    if (this.menuBlocksWorld()) return;
    const preset = COLOUR_PRESET_BY_ID.get(presetId);
    if (!preset) return;
    let wouldChange = sameObjectColours(this.world.gateColours, presetRecord(ENTRANCE_COLOUR_ID, presetId)) ? 0 : 1;
    for (const object of this.world.objects.values()) {
      if (!isColourable(object.definitionId)) continue;
      if (!sameObjectColours(object.colours, presetRecord(object.definitionId, presetId))) wouldChange += 1;
    }
    if (wouldChange === 0) {
      this.toast(`The park already wears ${preset.name}`, 'routine');
      return;
    }
    const fee = this.recolourFee(wouldChange);
    if (fee > this.world.cash) {
      this.toast(`Not enough cash to recolour the park · $${fee.toLocaleString()} needed, $${Math.floor(this.world.cash).toLocaleString()} available`);
      return;
    }
    this.finishPaintGesture();
    const began = this.undo.begin('recolour');
    const result = this.world.applyPresetToPark(presetId);
    if (result.changedCount === 0) {
      this.undo.abandon();
      return;
    }
    this.noteColourEdit();
    this.recolourEntry = null;
    const before = this.undo.newest;
    this.undo.commit(`${preset.name} colours for the park`);
    const entry = this.undo.newest;
    const charged = recolourCharge(this.colourCostMode(), result.changedCount, this.session.rules.recolourCostMultiplier);
    if (charged > 0) {
      this.world.postTransaction(-charged, 'Repainting', 'construction');
      if (began && entry !== before && entry?.kind === 'recolour') this.recolourCharges.set(entry.id, charged);
    }
    this.syncUi();
    this.toast(`${preset.name}: ${result.changedCount} thing${result.changedCount === 1 ? '' : 's'} recoloured${charged > 0 ? ` · -$${charged.toLocaleString()}` : ''}`, 'routine');
  }

  /** Redraws what depends on the paint state (the hover outline, the readout, the ghost) when the brush, the target or the mode changed. */
  private syncPaintState(): void {
    const state = useUiStore.getState();
    const toolChanged = state.tool !== this.lastTool;
    const paintChanged = state.paintBrush !== this.lastPaintBrush || state.paintTarget !== this.lastPaintTarget || state.paintPicking !== this.lastPaintPicking;
    if (!toolChanged && !paintChanged) return;
    const brushChanged = this.lastPaintBrush === null || !sameBrush(state.paintBrush, this.lastPaintBrush);
    const left = this.lastTool === 'paint' && state.tool !== 'paint';
    this.lastTool = state.tool;
    this.lastPaintBrush = state.paintBrush;
    this.lastPaintTarget = state.paintTarget;
    this.lastPaintPicking = state.paintPicking;
    if (left) {
      this.finishPaintGesture();
      this.renderer?.setPaintHover?.(null);
      if (state.paintReadout !== null) updateUiSnapshot({ paintReadout: null });
    }
    const hovered = this.renderer?.hoveredCell;
    if (state.tool === 'paint') {
      if (toolChanged) {
        this.renderer?.clearPreview();
        // The paint panel takes the inspector's slot: the inspector is never open while painting.
        if (this.selectedRideId !== null || this.selectedServiceId !== null || this.selectedGuestId !== null) this.closeInspector();
      }
      if (hovered) this.hoverPaint(hovered);
    } else if (state.tool === 'build' && brushChanged && state.selectedDefinitionId !== null) {
      // Colour before placing: the ghost takes the new brush at once, without waiting for a mouse move.
      if (this.coasterDraft.length > 0) this.refreshCoasterPreview();
      if (hovered) this.handleHover(hovered);
    }
  }

  /** Tracks Shift so the paint readout shows what a Shift-click would do; the gesture itself reads Shift at pointer down. */
  private readonly trackShift = (event: KeyboardEvent): void => {
    if (event.key !== 'Shift' || this.shiftHeld === event.shiftKey) return;
    this.shiftHeld = event.shiftKey;
    if (useUiStore.getState().tool !== 'paint') return;
    const hovered = this.renderer?.hoveredCell;
    if (hovered) this.hoverPaint(hovered);
  };

  /** A colour changed: the save layer sees a new version (autosave, unsaved-changes) and the undo stamp moves. */
  private noteColourEdit(): void {
    this.colourEdits += 1;
    this.settingsRevision += 1;
  }

  /** A one-shot was played (Phase 25): the save layer sees a new version and the undo stamp moves (design 3.3). */
  private noteCardPlay(): void {
    this.cardPlays += 1;
    this.settingsRevision += 1;
  }

  /** What the undo ring compares to decide that a gesture changed something. */
  private undoStamp(): number {
    return this.world.version + (this.colourEdits + this.cardPlays) * 2 ** 32;
  }

  setSelectedServiceOpen(open: boolean): void {
    if (this.selectedServiceId === null) return;
    this.shops.setOpen(this.selectedServiceId, open);
    this.syncUi();
  }

  adjustSelectedServicePrice(delta: number): void {
    if (this.selectedServiceId === null) return;
    const service = this.shops.getService(this.selectedServiceId);
    if (!service) return;
    this.shops.setPrice(this.selectedServiceId, service.itemPrice + delta);
    this.syncUi();
  }

  /**
   * The Undo press, from the dock button and from Ctrl+Z alike. Routes exactly as the keyboard
   * does, so the control cannot promise one thing and do another: a half-drawn track steps back one
   * piece first (the label says "Undo track piece"); otherwise the newest park snapshot is restored,
   * which rewinds the WHOLE park to just before that gesture, demolitions included.
   */
  requestUndo(): void {
    // The ring is empty at every stage boundary and nothing is edited between stages: undo never crosses into the run.
    if (this.runHold()) {
      this.toast('Undo works inside a level');
      return;
    }
    if (this.coasterDraft.length > 0 && this.currentCoasterType()) {
      this.coasterUndo();
      this.syncUi();
      return;
    }
    // Ctrl+Z mid-drag undoes the partial drag; the ring commits the pending snapshot itself.
    const paintPending = this.paintGesture !== null && this.undo.hasPending;
    const outcome = this.undo.requestUndo();
    this.demolishedInDrag = [];
    // The undone entry was the paint drag's own snapshot: the release must not name or charge those objects again.
    // (A pending snapshot with no change is dropped by the commit instead, and then the gesture owns nothing yet.)
    if (paintPending && outcome.kind === 'undone') this.paintGesture?.dropUndone();
    this.toast(this.undoToast(outcome), outcome.kind === 'undone' ? 'routine' : 'alert');
    this.publishUndoStatus();
  }

  private undoToast(outcome: UndoOutcome): string {
    switch (outcome.kind) {
      case 'undone':
        return outcome.rewoundSeconds >= 1
          ? `Undid ${outcome.target} · rewound ${formatRewind(outcome.rewoundSeconds)}`
          : `Undid ${outcome.target}`;
      case 'confirm':
        return outcome.strong
          ? `That is a long way back: ${formatRewind(outcome.rewindSeconds)} of the whole park. Press Undo again to confirm.`
          : `This rewinds ${formatRewind(outcome.rewindSeconds)} of the whole park. Press Undo again to confirm.`;
      case 'refused':
      case 'failed':
        return outcome.message;
    }
  }

  hireStaff(role: StaffRole): void {
    const block = this.operations.hireBlock(role);
    if (block !== null) {
      this.toast(block.reason === 'capacity'
        ? `Crew is full — ${block.capacity} ${role}s max at this park size`
        : `Wages must be covered first · ${shortfallMessage(block.required, block.available)}`);
      return;
    }
    const worker = this.operations.hireStaff(role);
    if (!worker) return;
    this.syncUi();
    this.toast(`${role === 'cleaner' ? 'Cleaner' : 'Mechanic'} hired`, 'routine');
  }

  trainStaff(role: StaffRole): void {
    const result = this.operations.trainStaff(role);
    if (!result.ok) {
      this.toast(result.reason === 'maxLevel'
        ? 'This crew is already fully trained'
        : result.reason === 'noStaff'
          ? `Hire a ${role} before paying for training`
          : 'Not enough cash for that training');
      return;
    }
    this.syncUi();
    this.toast(`${role === 'cleaner' ? 'Cleaners' : 'Mechanics'} trained to level ${result.level} · -$${result.cost.toLocaleString()}`, 'routine');
  }

  fireStaff(role: StaffRole): void {
    const worker = this.operations.fireStaff(role);
    if (!worker) {
      this.toast(`No ${role} to dismiss`);
      return;
    }
    this.syncUi();
    this.toast(`${role === 'cleaner' ? 'Cleaner' : 'Mechanic'} dismissed`, 'routine');
  }

  fireWorker(workerId: number): void {
    const worker = this.operations.fireStaffById(workerId);
    if (!worker) {
      this.toast('That worker has already left');
      return;
    }
    this.syncUi();
    this.toast(`${workerName(worker.id)} (${roleLabel(worker.role).toLowerCase()}) dismissed`, 'routine');
  }

  focusWorker(workerId: number): void {
    const worker = this.operations.staff.get(workerId);
    if (!worker) return;
    this.renderer?.focusCell(worker.currentCell, 'ease', this.viewInsets(false));
  }

  centreBuilding(objectId: number): void {
    const object = this.world.objects.get(objectId);
    if (!object) return;
    const footprint = this.world.objectFootprint(object);
    const centre = footprint.reduce(
      (total, cell) => ({ x: total.x + cell.x / footprint.length, y: total.y + cell.y / footprint.length }),
      { x: 0, y: 0 },
    );
    this.renderer?.focusCell(centre, 'ease', this.viewInsets(false));
  }

  setObjectsOpen(objectIds: readonly number[], open: boolean): void {
    let changed = 0;
    for (const objectId of objectIds) {
      if (this.rides.getRide(objectId)) {
        this.rides.setOpen(objectId, open);
        changed += 1;
      } else if (this.shops.getService(objectId)) {
        this.shops.setOpen(objectId, open);
        changed += 1;
      }
    }
    if (changed === 0) return;
    this.syncUi();
    if (objectIds.length > 1) this.toast(`${changed} building${changed === 1 ? '' : 's'} ${open ? 'opened' : 'closed'}`, 'routine');
  }

  adjustObjectPrice(objectId: number, delta: number): void {
    const ride = this.rides.getRide(objectId);
    if (ride) this.rides.setTicketPrice(objectId, ride.ticketPrice + delta);
    else {
      const service = this.shops.getService(objectId);
      if (!service) return;
      this.shops.setPrice(objectId, service.itemPrice + delta);
    }
    this.syncUi();
  }

  forceSelectedRideBreakdown(): void {
    if (!this.developerToolsAvailable()) return;
    if (this.selectedRideId === null) return;
    const forced = this.rides.forceBreakdown(this.selectedRideId, this.guests.guests);
    this.syncUi();
    this.toast(forced ? 'Test breakdown triggered' : 'Ride cannot break down right now', forced ? 'routine' : 'alert');
  }

  purchaseResearch(projectId: string): void {
    const result = this.progression.purchase(projectId);
    if (!result.ok) {
      const message = result.reason === 'locked'
        ? 'Research prerequisites are not complete'
        : result.reason === 'insufficient-rp'
          ? 'Not enough research points'
          : result.reason === 'insufficient-cash'
            ? 'Not enough cash for this research'
            : result.reason === 'completed'
              ? 'Research already completed'
              : 'Research project not found';
      this.toast(message);
      return;
    }
    this.handleProgressionEvents(this.progression.drainEvents());
    this.syncUi();
  }

  setSceneryInfluenceVisible(visible: boolean): void {
    // Phase 14: the two ground heatmaps are exclusive. Idempotent: the UI also sets the store before calling here.
    if (visible && useUiStore.getState().showCrowdHeatmap) this.setCrowdHeatmapVisible(false);
    this.renderer?.setSceneryInfluenceVisible(visible);
    useUiStore.getState().setSceneryInfluenceVisible(visible);
  }

  /**
   * Phase 35: the mute key. Master volume to 0 and back (`settings/muteToggle.ts`); the settings subscription hands the
   * new level to the audio engine, and the toast names the new state.
   */
  toggleMute(): void {
    const step = nextMuteStep(getSettings().masterVolume, this.unmutedMasterVolume);
    this.unmutedMasterVolume = step.remembered;
    updateSettings({ masterVolume: step.masterVolume });
    this.toast(muteToastText(step, step.muted ? keyLabel('toggleMute') : null), 'important');
  }

  /** True when the mounted renderer draws the crowd heatmap (voxel); before a renderer mounts, what the store says. */
  private crowdHeatmapSupported(): boolean {
    return this.renderer ? typeof this.renderer.setCrowdHeatmap === 'function' : useUiStore.getState().crowdHeatmapSupported;
  }

  /**
   * Phase 14: the crowd flow heatmap on or off. Turning it on turns the scenery heatmap off (both are ground layers). The
   * classic renderer cannot draw it: a press says so in a toast and the store stays off. Idempotent (the UI sets the
   * store itself and calls this as well).
   */
  setCrowdHeatmapVisible(visible: boolean): void {
    const state = useUiStore.getState();
    if (!this.crowdHeatmapSupported()) {
      if (state.showCrowdHeatmap) state.setCrowdHeatmapVisible(false);
      if (visible) this.toast(CROWD_CLASSIC_TOAST);
      return;
    }
    if (visible && state.showSceneryInfluence) this.setSceneryInfluenceVisible(false);
    if (useUiStore.getState().showCrowdHeatmap !== visible) useUiStore.getState().setCrowdHeatmapVisible(visible);
    this.pushCrowdHeatmap(true);
    this.publishCrowdHover();
  }

  /**
   * Phase 14, from a Neighborhoods row: centres the camera (eased; the classic renderer and reduced motion snap) on the
   * neighborhood's worst tile when it is busy or worse, else on its focus tile. A neighborhood with a bottleneck also
   * turns the crowd heatmap on, so the jam is visible where the camera lands.
   */
  focusNeighborhood(key: number): void {
    const view = this.session.crowdView();
    const neighborhood = view.neighborhoods.find((entry) => entry.key === key);
    if (!neighborhood) return;
    const worst = neighborhood.worst;
    this.renderer?.focusCell(worst !== null && worst.band >= 2 ? worst.cell : neighborhood.focus, 'ease', this.viewInsets(false));
    const bottleneck = worst?.bottleneck === true || view.bottlenecks.some((tile) => tile.neighborhoodKey === key);
    if (bottleneck && this.crowdHeatmapSupported() && !useUiStore.getState().showCrowdHeatmap) this.setCrowdHeatmapVisible(true);
  }

  /**
   * Phase 14: hands the renderer the crowd heatmap while it is shown. `crowdHeatmap(previous)` returns `previous` itself
   * while no displayed band moved, so a steady park costs nothing; `force` re-sends it (after a session swap or a mount the
   * renderer has forgotten the layer, even when the revision is the same).
   */
  private pushCrowdHeatmap(force = false): void {
    const renderer = this.renderer;
    if (!renderer?.setCrowdHeatmap) {
      this.crowdHeatmapShown = null;
      return;
    }
    if (!useUiStore.getState().showCrowdHeatmap) {
      if (this.crowdHeatmapShown !== null || force) renderer.setCrowdHeatmap(null);
      this.crowdHeatmapShown = null;
      return;
    }
    const view = this.session.crowdHeatmap(this.crowdHeatmapShown);
    if (view === this.crowdHeatmapShown && !force) return;
    renderer.setCrowdHeatmap(view);
    this.crowdHeatmapShown = view;
  }

  /** A member that is a stall (food, drink or toilet), for the Neighborhoods row subtitle. */
  private readonly isStall = (objectId: number): boolean => {
    const object = this.world.objects.get(objectId);
    return object !== undefined && BUILD_BY_ID.get(object.definitionId)?.stats?.serviceType !== undefined;
  };

  /** The CursorReadout crowd line: the pointer tool, the heatmap on and a hovered cell; null otherwise or off the paths. */
  private crowdHoverLine(): string | null {
    const state = useUiStore.getState();
    if (state.tool !== 'pointer' || !state.showCrowdHeatmap || !state.hoveredCell) return null;
    return crowdHoverText(this.session.crowdHoverAt(state.hoveredCell));
  }

  /** Re-reads only the hover line (a pointer move between two 4 Hz publishes); writes the store only when it changed. */
  private publishCrowdHover(): void {
    const crowd = useUiStore.getState().crowd;
    if (!crowd) return;
    const hover = this.crowdHoverLine();
    if (crowd.hover !== hover) updateUiSnapshot({ crowd: { ...crowd, hover } });
  }

  /**
   * Phase 14, on the 4 Hz cadence: steps the Park Pulse tracker, publishes the `crowd` UI (rows only while the
   * Neighborhoods tab is open; written only when something visible changed) and pushes the heatmap when it moved.
   * `crowdView()` is memoised per tick and world version, so a paused park re-reads the same object.
   */
  private publishCrowd(): void {
    const state = useUiStore.getState();
    const view = this.session.crowdView();
    const step = stepCrowdNotice(this.crowdNotice, { tick: this.world.tick, view });
    this.crowdNotice = step.state;
    const ui = buildCrowdUi({
      view,
      active: step.active,
      rowsOpen: state.managementOpen && state.managementTab === 'neighborhoods',
      hover: this.crowdHoverLine(),
      rowOptions: { isStall: this.isStall },
    });
    if (!crowdUiEqual(state.crowd, ui)) updateUiSnapshot({ crowd: ui });
    this.pushCrowdHeatmap();
  }

  /**
   * `startScenario(id, cards)`: an id starts that scenario in Scenario mode (the browser's loadout), a null id the Sandbox.
   * Phase 23: it no longer means The Map; runs start through `startRun`.
   */
  startScenario(scenarioId: string | null, cardIds: readonly string[] = [], mapId?: MapId, recipe?: MapRecipe): void {
    if (scenarioId === null) {
      this.startPark({ mode: 'sandbox', ...(mapId !== undefined ? { mapId } : {}), ...(recipe !== undefined ? { recipe } : {}) });
      return;
    }
    this.startPark({ mode: 'scenario', scenarioId: scenarioId as ScenarioId, cardIds });
  }

  /** The one entry every new non-run park goes through (Phase 22): validates, builds the session with the profile's grant, swaps it in. */
  startPark(request: ParkStartRequest, confirmedLeaveRun = false): void {
    const mode: GameMode = request.mode;
    const definition = request.mode === 'sandbox' ? null : SCENARIO_BY_ID.get(request.scenarioId);
    if (request.mode !== 'sandbox' && !definition) {
      this.toast('That park scenario does not exist');
      return;
    }
    if (definition && request.mode === 'scenario') {
      const availability = this.profile.scenarioAvailability(definition.id);
      if (!availability.unlocked) {
        this.toast(availability.conditionText ?? 'That scenario is locked');
        return;
      }
    }
    // Leaving a run that only the autosave holds asks first (Phase 23); the answer re-enters here with the confirmation.
    if (!confirmedLeaveRun && this.raiseLeaveRun(request.mode === 'scenario' ? 'scenario' : 'new-park', () => this.startPark(request, true))) return;
    // The loadout pool: the profile's collection in Scenario mode.
    const pool = new Set<string>(request.mode === 'scenario' ? this.profile.snapshot().collectionCardIds : []);
    const ownedSelection = request.mode === 'sandbox'
      ? []
      : request.cardIds.filter((cardId): cardId is PulseCardId => pool.has(cardId));
    const wasSweeping = this.sweepActive;
    // A sandbox on a chosen map (Phase 24); a scenario plays its own map, so the choice is ignored there.
    const sandboxMap = request.mode === 'sandbox' ? request.mapId : undefined;
    const recipe = request.mode === 'sandbox' ? request.recipe : undefined;
    const map = sandboxMap === undefined ? undefined : MAP_BY_ID.get(sandboxMap);
    if (sandboxMap !== undefined && map === undefined) {
      this.toast('That map does not exist');
      return;
    }
    // A generated sandbox (Phase 24 step 2): the recipe is validated, the map is built before anything is torn down.
    let generatedLayout: MapLayout | undefined;
    if (recipe !== undefined && request.mode === 'sandbox') {
      const checked = readRecipe(recipe);
      if ('problem' in checked) {
        this.toast('That generated map is not valid');
        return;
      }
      try {
        generatedLayout = generateMap(checked).layout;
      } catch {
        this.toast('That generated map could not be made');
        return;
      }
    }
    // The profile's gift is a snapshot taken now and saved with the park: loading never reads the live profile.
    const grant = this.profile.parkGrant(mode);
    const sessionOptions = {
      mode,
      grant,
      ...(generatedLayout !== undefined ? { layout: generatedLayout } : map === undefined ? {} : { mapId: map.id }),
    };
    this.swapSession(new ParkSession(definition ?? null, ownedSelection, sessionOptions), 'new-park', () => {
      // A new park is a new timeline: it must not inherit the park time of the one before it (the
      // start screen's preview carries the clock of the save it shows).
      this.clock.restore({ speed: 1, simulationTimeMs: 0 });
      this.clock.resetAccumulator();
      const ui = useUiStore.getState();
      ui.closeScenarioPicker();
      ui.closeLoadout();
      ui.resetScenarioResult();
      updateUiSnapshot({ speed: 1, rewardDraft: null });
      this.syncUi();
      this.leaveMenuForPlay();
      // A new park starts at view 0, like every new park starts at the entrance.
      this.setParkViewRotation(0);
    });
    // The sweep moved the camera; a new park starts where every new park starts.
    if (wasSweeping) this.renderer?.focusEntrance();
    this.parkChosen = true;
    this.profile.recordParkStarted(mode);
    this.saves.notifyParkStarted();
    this.recoveryController.parkStarted(this.parkInfoOf(this.session));
    this.toast(
      definition ? `${definition.name} started`
        : generatedLayout !== undefined && recipe !== undefined ? `${BIOME_BY_ID.get(recipe.biomeId)?.name ?? 'Park'} ${generatedMapName(recipe)} started`
          : map && map.id !== DEFAULT_MAP_ID ? `${map.name} started` : 'Sandbox park started',
      'routine',
    );
  }

  /** A fresh sandbox on a shipped map, from anywhere (the New park picker goes through `menuNewPark`). */
  startSandboxMap(mapId: MapId): void {
    this.startScenario(null, [], mapId);
  }

  /** A fresh sandbox on a map generated from `recipe` (Phase 24 step 2). */
  startGeneratedMap(recipe: MapRecipe): void {
    this.startScenario(null, [], undefined, recipe);
  }

  /** New park from the start screen on a generated map (the picker's Generate choice). */
  menuNewGenerated(recipe: MapRecipe): void {
    if (useUiStore.getState().menuKind !== 'start') return;
    if (this.recoveryController.snapshot().phase !== 'idle') return;
    this.startGeneratedMap(recipe);
  }

  /**
   * The one swap behind a new park, a load and an undo: tear down what belongs to the old park,
   * install `next`, let `apply` set what only the caller knows, and put the old park back if
   * anything throws. `next` is built BEFORE this runs, so everything that can fail (constructing a
   * session, `fromState`) has already happened and the live park was not touched by it.
   *
   * `mode` decides what is reset. A new park or a load drops the armed tool along with everything
   * else. A rewind keeps the armed tool, the selected definition and the rotation (the player is
   * placing a row of benches and presses Ctrl+Z; they still hold the bench) but resets what
   * refers to the old world: selection, ghost, drafts and the bulldozer's drag state.
   */
  private swapSession(next: ParkSession, mode: 'new-park' | 'loaded' | 'rewind', apply: () => void): void {
    const previousSession = this.session;
    const previousClock = this.clock.serialize();
    const previousView = this.viewRotation;
    this.swapping = true;
    this.recolourEntry = null;
    // Phase 11: the capacity tracker belongs to the park on screen (new park, load, undo rewind, recovery).
    this.capacityNotice = INITIAL_CAPACITY_NOTICE;
    if (useUiStore.getState().atCapacity) updateUiSnapshot({ atCapacity: false });
    // Phase 14: the neighborhood lines belong to the park on screen too, and the renderer forgets the crowd layer with it.
    this.crowdNotice = INITIAL_CROWD_NOTICE;
    this.crowdHeatmapShown = null;
    this.closeInspector();
    if (mode === 'rewind') this.resetGestureState();
    else this.cancelTool();
    this.clearCoasterDraft();
    this.unsubscribeWorld?.();
    try {
      this.session = next;
      this.feedback.attach(next);
      this.unsubscribeWorld = this.world.subscribe(this.onWorldChanged);
      this.sweep.setCentre(this.world.width / 2, this.world.height / 2);
      this.renderer?.setSession(next);
      // The renderer dropped its markers with the old park, and its crowd layer: push the new park's view (or null).
      this.hintKey = '';
      this.pushCrowdHeatmap(true);
      // Before `apply` publishes the new park: a different park has its own First Day history, so
      // the card re-seeds instead of celebrating steps that were done in the old one. An undo
      // rewind is the same park and keeps the epoch.
      if (mode !== 'rewind') {
        updateUiSnapshot({
          parkEpoch: useUiStore.getState().parkEpoch + 1,
          onboarding: next.onboardingSnapshot(),
          gateFacing: next.world.entranceFacing,
          mapOfferPending: false,
          scenarioRewards: null,
          ...this.modeUi(next),
        });
        // The run screens belong to the run of the park on screen; a view is opened by whatever started the park.
        updateUiSnapshot({ ...this.runUiOf(next), runView: null, runDrawer: null, runLoadoutSelection: [], runRewards: null, leaveRunPrompt: null });
      }
      apply();
    } catch (error) {
      this.unsubscribeWorld?.();
      this.session = previousSession;
      this.clock.restore(previousClock);
      this.setParkViewRotation(previousView);
      this.unsubscribeWorld = this.world.subscribe(this.onWorldChanged);
      this.sweep.setCentre(this.world.width / 2, this.world.height / 2);
      this.renderer?.setSession(previousSession);
      this.hintKey = '';
      this.crowdHeatmapShown = null;
      this.pushCrowdHeatmap(true);
      updateUiSnapshot({ onboarding: previousSession.onboardingSnapshot(), gateFacing: previousSession.world.entranceFacing, ...this.modeUi(previousSession) });
      updateUiSnapshot(this.runUiOf(previousSession));
      throw error;
    } finally {
      this.swapping = false;
    }
    // After the swap, never before: a failed swap keeps the old park and its undo history. A rewind
    // keeps the older entries: they are earlier moments of this same timeline.
    if (mode !== 'rewind') {
      this.undo.clear(mode);
      this.recolourCharges.clear();
    }
    this.publishUndoStatus();
    this.publishCrowd();
  }

  /**
   * Phase 22: what the UI shows about the park's mode, bonuses and locked buildings. Mode and grant are fixed for a
   * park's life, so this is written at a swap only (never per frame) and an undo rewind keeps it.
   */
  private modeUi(session: ParkSession): Pick<UiState, 'sessionMode' | 'parkTitle' | 'activeBonuses' | 'profileLocks'> {
    const profileLocks: Record<string, string> = {};
    for (const lock of session.profileLocks()) profileLocks[lock.definitionId] = lock.text;
    return { sessionMode: session.mode, parkTitle: this.parkTitle(session), activeBonuses: session.activeBonusesSnapshot(), profileLocks };
  }

  /** Phase 33: the top bar's park name (fixed for a park's life, like the mode). */
  private parkTitle(session: ParkSession): string {
    return parkTitleOf({ mode: session.mode, scenarioName: session.scenarioDefinition?.name ?? null, mapName: session.map.name });
  }

  /** Subscribed to the profile: publishes its snapshot (the same object until the revision moves). */
  private readonly publishProfile = (): void => {
    if (this.destroyed) return;
    updateUiSnapshot({ profile: this.profile.snapshot() });
  };

  /** Another tab wrote the profile: merge it (nothing this tab holds is ever lost) and publish. */
  private readonly handleProfileStorage = (event: StorageEvent): void => {
    if (event.key !== PROFILE_STORAGE_KEY) return;
    this.profile.applyExternal(event.newValue);
  };

  /**
   * Loads a slot. The Save/Load dialog has already asked about unsaved changes. Everything that
   * can fail (reading, migrating, validating, building the session) happens before the live park is
   * touched; `installLoaded` is the only step that swaps anything.
   */
  async loadGame(slotId: Parameters<SaveManager['load']>[0], confirmedLeaveRun = false): ReturnType<SaveManager['load']> {
    // A load replaces the live park, and with it a run that only the autosave holds (Phase 23): ask first. The answer
    // loads for real (a failure then shows as a toast, since the dialog already got its answer).
    if (!confirmedLeaveRun && this.raiseLeaveRun('load', () => {
      void this.loadGame(slotId, true).then((result) => { if (!result.ok) this.toast(result.error.message); });
    }, slotId)) {
      // Not a failure: the load waits for the answer. The dialog is closed already and shows nothing for this code.
      return { ok: false, error: { code: 'deferred', message: 'Your run is waiting for an answer: leave it or keep playing.' } };
    }
    const result = await this.saves.load(slotId);
    // No toast here: the dialog toasts the result (with the balance note) and the save strip shows
    // the manager's notice, so a third copy would only stack.
    return result;
  }

  /**
   * Swaps a loaded session in exactly as `startPark` swaps a new one, then restores what only a
   * save knows: the clock and the view. The park loads PAUSED (the player should see it before it moves). If anything below
   * throws, the previous session is put back and the error propagates into a failed load.
   */
  private installLoaded(loaded: LoadedPark): void {
    this.swapSession(loaded.session, 'loaded', () => {
      this.clock.restore(loaded.save.app.clock);
      this.clock.setSpeed(0);
      this.clock.resetAccumulator();
      // The saved view (absent in older saves: 0). The start screen's sweep shows the park as it was left.
      const savedView = loaded.save.app.viewRotation;
      this.setParkViewRotation(isViewRotation(savedView) ? savedView : 0);
      this.parkChosen = true;
      const ui = useUiStore.getState();
      ui.closeScenarioPicker();
      ui.closeLoadout();
      ui.closeSavesDialog();
      ui.resetScenarioResult();
      updateUiSnapshot({ speed: 0, rewardDraft: null });
      // syncUi refreshes management, progression, scenario, cards and buildings, so the first
      // painted frame of the loaded park already has real operations sections.
      this.syncUi();
      this.leaveMenuForPlay();
    });
    // A run park: the stage that ended without the run hearing of it is settled, and the right screen opens.
    const runPending = this.adoptRunPark();
    this.saves.notifyParkStarted();
    if (runPending) this.runChanged();
    this.recoveryController.parkStarted(this.parkInfoOf(loaded.session));
  }

  /** What the interrupted-session prompt names the park; only for the prompt. A Map stage is named by its level and has no shipped scenario id. */
  private parkInfoOf(session: ParkSession): RecoveryParkInfo {
    const definition = session.scenarioDefinition;
    return {
      parkName: definition?.name ?? 'Sandbox park',
      scenarioId: session.mode === 'run' || definition === null ? null : (definition.id as ScenarioId),
      mode: session.mode,
    };
  }

  /**
   * Undo of a recolour is cosmetic: only the colours go back to what the entry's snapshot says. No
   * session swap, no rewound clock, no returned cash, no lost guests. An object the snapshot did not
   * know keeps what it has; one it knew gets exactly its recorded colours or the defaults.
   */
  private restoreColours(entry: UndoEntry): void {
    const recorded = new Map(entry.state.world.objects.map((object) => [object.id, object.colours]));
    const edits: ColourEdit[] = [];
    for (const object of this.world.objects.values()) {
      if (!recorded.has(object.id)) continue;
      edits.push({ objectId: object.id, colours: normaliseObjectColours(object.definitionId, recorded.get(object.id)) });
    }
    // The entrance gate is part of the park state too (a whole-park preset or a paint on the gate is in the entry).
    edits.push({ gate: true, colours: normaliseObjectColours(ENTRANCE_COLOUR_ID, entry.state.world.gateColours) });
    this.world.recolourBatch(edits);
    this.noteColourEdit();
    this.recolourEntry = null;
    // A priced recolour comes back with its colours: the same amount is posted back as a refund.
    const charged = this.recolourCharges.get(entry.id) ?? 0;
    this.recolourCharges.delete(entry.id);
    if (charged > 0) this.world.postTransaction(charged, 'Repainting refunded', 'refund');
    this.syncUi();
  }

  /**
   * Restores one ring entry: the same swap as a load, to a fresh `ParkSession.fromState`, never
   * `restoreState` in place. Why: `fromState` finishes before the live park is touched (atomic,
   * and the entry is neither consumed nor mutated, so a failure leaves it intact), and the swap
   * rebuilds every cache keyed by world identity or version, which would otherwise see the version
   * run backwards. The clock is restored from the entry and the CURRENT speed is kept: undo does
   * not pause. The accumulator is dropped so the first frame runs no catch-up burst.
   */
  private restoreSnapshot(entry: UndoEntry): void {
    if (entry.kind === 'recolour') {
      this.restoreColours(entry);
      return;
    }
    const next = ParkSession.fromState(entry.state);
    // The ring image predates any skip or dismiss made since, and those are the player's choices, not
    // park history: carry them over (add-only) so undo never brings dismissed hints back.
    const liveOnboarding = this.session.onboardingSnapshot();
    if (liveOnboarding) next.onboarding?.adoptDismissals(liveOnboarding);
    // The calendar position rewinds with the park, but day length and fixed time are how the player
    // chose to play: carried over like the dismissals (a no-op when nothing changed, and in a scenario).
    // The same goes for opening hours and the weather switches; the drawn weather itself rewinds.
    next.adoptSettings(this.session.settings());
    // Phase 14: a rule-off park's crowd field is presentation only (never saved): carry it over so the heatmap does not
    // blank on undo. A no-op for a feedback park, whose field rewinds with the save.
    next.crowd.adoptDisplay(this.session.crowd);
    const speed = this.clock.speed;
    this.swapSession(next, 'rewind', () => {
      this.clock.restore(entry.clock);
      this.clock.setSpeed(speed);
      this.clock.resetAccumulator();
      updateUiSnapshot({ rewardDraft: null });
      this.syncUi();
      // The ghost was cleared by the swap; redraw it so its validity and cost describe the rewound world.
      const hovered = this.renderer?.hoveredCell;
      if (hovered) this.handleHover(hovered);
    });
  }

  /**
   * The pre-gesture park for the undo ring. Same capture as an autosave (sync first, one retry on
   * `unsynced`) plus the clock, which a save keeps in its envelope.
   */
  private captureForUndo(): UndoCapture {
    const park = this.capturePark();
    return {
      state: park.state,
      clock: this.clock.serialize(),
      cash: park.cash,
      guestCount: park.guestCount,
      // The undo ring compares against the plain world version, not the save token.
      worldVersion: this.undoStamp(),
    };
  }

  /** What the save manager sees of the game. No simulation or rendering types leak through it. */
  private readonly saveHost: SaveHost = {
    hasPark: () => !this.destroyed && !this.menuHold && (this.parkChosen || this.world.version !== this.pristineWorldVersion),
    worldVersion: () => this.saveVersion(),
    tick: () => this.world.tick,
    isRunning: () => this.clock.speed !== 0 && !this.runHold() && (this.session.scenario?.currentStatus ?? 'running') === 'running',
    capture: () => this.capturePark(),
    installLoaded: (loaded) => this.installLoaded(loaded),
    now: () => Date.now(),
  };

  /**
   * Serializes the park at a step boundary (the ticker after `clock.update`, or a DOM handler:
   * neither can interleave with a synchronous step or edit). Syncing first is cheap when nothing
   * changed; if serialize still reports an unsynced owner, one more sync and one retry, then the
   * error surfaces as a failed save rather than a swallowed one.
   */
  private capturePark(): CapturedPark {
    this.session.syncWithWorld();
    let state;
    try {
      state = this.session.serialize();
    } catch (error) {
      if (!(error instanceof SaveError) || error.code !== 'unsynced') throw error;
      this.session.syncWithWorld();
      state = this.session.serialize();
    }
    // Read from the last UI snapshot: management.snapshot() advances its transaction cursor, so
    // calling it here would change simulation state as a side effect of saving.
    const rating = useUiStore.getState().management?.rating.score ?? 0;
    return {
      state,
      // `tourNodeId` stays in the format (older builds read it) and is always null since the Park Tour was retired.
      app: { clock: this.clock.serialize(), tourNodeId: null, viewRotation: this.viewRotation },
      scenarioName: this.session.scenarioDefinition?.name ?? DEFAULT_SANDBOX_NAME,
      ...mapMetaOf(state.map),
      ...(this.session.run === null ? {} : { run: runSummaryOf(this.session.run) }),
      guestCount: this.guests.guests.size,
      cash: this.world.cash,
      rating: Math.min(100, Math.max(0, Math.round(rating))),
      worldVersion: this.saveVersion(),
      tick: this.world.tick,
    };
  }

  restartScenario(): void {
    // The Map has no retries (a failed level ends the run); "Try this seed again" is `runEndAction('same-seed')`.
    if (this.session.mode === 'run') {
      this.toast('A level of The Map cannot be restarted. Start the seed again from the run screen.');
      return;
    }
    // A sandbox restarts on the same shipped map (a custom map has no shipped id: the Meadow Garden).
    const definition = this.session.scenarioDefinition;
    if (definition === null || this.session.mode === 'sandbox') {
      const sandboxMapId = isMapId(this.session.map.id) ? this.session.map.id : undefined;
      this.startPark({ mode: 'sandbox', ...(sandboxMapId !== undefined ? { mapId: sandboxMapId } : {}) });
      return;
    }
    // Same scenario, same cards, same MODE (the grant is read from the profile again, like any new park).
    this.startPark({
      mode: this.session.mode,
      scenarioId: definition.id as ScenarioId,
      cardIds: this.session.activeCards.map((card) => card.id),
    });
  }

  chooseRewardCard(cardId: string): void {
    const draft = useUiStore.getState().rewardDraft;
    if (!draft || !draft.includes(cardId)) return;
    const card = CARD_BY_ID.get(cardId as PulseCardId);
    const added = card !== undefined && this.profile.addDiscoveredCard(card.id);
    // The draft always closes, even when the card could not be added. Leaving it open on a
    // rejected pick would strand the player behind an overlay that refuses every choice.
    updateUiSnapshot({ rewardDraft: null });
    this.toast(added
      ? `${card?.name ?? 'Card'} added to your collection`
      : 'That card is already in your collection', added ? 'routine' : 'alert');
  }

  /** Skips the current First Day step. The choice is the player's, not park history: no undo entry. */
  skipOnboardingStep(): void {
    this.session.onboarding?.skipCurrent();
    this.publishOnboardingChoice();
  }

  /** Hides the First Day hints for this park for good. */
  dismissOnboarding(): void {
    this.session.onboarding?.dismissAll();
    this.publishOnboardingChoice();
  }

  /** The player answered "Ready for The Map?": remember it for good, hide it, optionally open The Map's setup. */
  resolveMapOffer(openMap: boolean): void {
    this.profile.markTourOffered();
    const state = useUiStore.getState();
    state.setMapOfferPending(false);
    if (openMap) this.openMapSetupFromPark();
  }

  private publishOnboardingChoice(): void {
    updateUiSnapshot({ onboarding: this.session.onboardingSnapshot() });
    this.refreshHints();
  }

  /**
   * Re-reads where the current step points and tells the renderer if the markers changed, then
   * checks whether the one-time Map offer is due. Runs at 4 Hz and after each sync, never per
   * frame.
   */
  private refreshHints(): void {
    this.hintFocus = this.session.onboarding ? this.session.onboardingFocus() : [];
    this.applyHints();
    const state = useUiStore.getState();
    if (shouldOfferMap({
      snapshot: state.onboarding,
      offered: this.profile.uiFlags().tourOffered,
      isSandbox: this.session.scenarioDefinition === null,
      pending: state.mapOfferPending,
    })) {
      // Remembered only when the player answers it (resolveMapOffer), so an offer that was never
      // seen (clean view, a modal, a reload, another park) is made again.
      state.setMapOfferPending(true);
    }
  }

  /** Pure decision in hintMarkers.ts; the renderer is told only when the markers actually change. */
  private applyHints(): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const state = useUiStore.getState();
    const markers = selectHintMarkers({
      onboarding: state.onboarding,
      focusCells: this.hintFocus,
      cleanView: state.cleanView,
      context: activeInputContext(state),
      rideSelected: state.selectedRide !== null,
    });
    const key = hintMarkerKey(markers);
    if (key === this.hintKey) return;
    this.hintKey = key;
    renderer.setHintMarkers(markers);
  }

  // --- Start screen, camera sweep and pause menu (Phase 18 step 2) ------------------------------

  /** World input is inert while any menu is up: a click, drag or key must not reach the park behind it. */
  private menuBlocksWorld(): boolean {
    return useUiStore.getState().menuKind !== null || this.runHold();
  }

  /**
   * Boot has the save list and the recovery decision: the park behind the start screen is chosen (a first run too; only
   * `&menu=0` skips the menu).
   */
  private onBootReady(): void {
    if (this.destroyed) return;
    if (this.menuHold) {
      const decision = bootMenuDecision({ enabled: this.startMenuEnabled });
      if (decision === 'menu') {
        void this.refreshMenuPreview();
        return;
      }
      // Back to the straight-to-the-park boot this page would have had without a menu.
      this.menuHold = false;
      this.clock.setSpeed(1);
      updateUiSnapshot({ speed: 1, menuKind: null, menuPanel: 'main', menuNotice: null, menuPreview: NO_MENU_PREVIEW });
    }
  }

  /**
   * The start screen is up and the park behind it is a still, paused, read-only backdrop: the clock is
   * stopped, the save manager sees no park (no autosave, no dirty state), no recovery marker or lock
   * exists, and every world input is refused. The card itself waits for `refreshMenuPreview`.
   */
  private enterStartMenu(): void {
    this.menuHold = true;
    this.menuPausedSpeed = null;
    this.preview = null;
    this.previewWaitsForRecovery = false;
    this.previewToken += 1;
    this.stopSweep();
    this.clock.setSpeed(0);
    updateUiSnapshot({ speed: 0, menuKind: 'start', menuPanel: 'main', menuNotice: null, menuPreview: NO_MENU_PREVIEW });
  }

  /**
   * Chooses the park behind the start screen: re-lists the slots, then reads the newest readable
   * one into a fresh session (up to three tries, newest first, so one damaged save does not hide the
   * others) and installs it paused. A save that cannot be read is flagged unreadable by the manager
   * and named in the notice; with nothing readable the empty starter map shows. A recovery offer that
   * is still open parks the preview on the starter map until it is answered, because Resume or Not now
   * decides which save is the latest.
   */
  private async refreshMenuPreview(): Promise<void> {
    const token = ++this.previewToken;
    const stale = (): boolean => (
      token !== this.previewToken || this.destroyed || useUiStore.getState().menuKind !== 'start'
    );
    // A card that is already showing (a recovery offer was just answered) stays; only a fresh menu waits behind its scrim.
    await this.saves.refresh();
    if (stale()) return;
    if (this.recoveryController.snapshot().phase !== 'idle') {
      this.previewWaitsForRecovery = true;
      this.showStarterMap();
      this.publishPreview(null, null, null);
      return;
    }
    this.previewWaitsForRecovery = false;
    const failed: string[] = [];
    let shown: { park: ParkPreview; name: string } | null = null;
    // The candidates are re-read after every failure: a preview that fails flags its slot unreadable, and when that was
    // the autosave the previous autosave generation becomes the newest candidate (Phase 31, `continuableSlots`).
    const tried = new Set<string>();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const meta = slotsNewestFirst(this.saves.snapshot().slots).find((row) => !tried.has(row.id));
      if (meta === undefined) break;
      tried.add(meta.id);
      const result = await this.saves.loadPreview(meta.id);
      if (stale()) return;
      if (result.ok) {
        shown = { park: result.value, name: slotDisplayName(meta) };
        break;
      }
      // A busy manager says nothing about the save; do not name it as damaged.
      if (result.error.code === 'busy') break;
      failed.push(slotDisplayName(meta));
    }
    const notice = failed.length > 0 ? describeUnreadableLatest(failed, shown?.name ?? null) : null;
    if (shown === null) {
      this.showStarterMap();
      this.publishPreview(null, null, notice);
      return;
    }
    this.installPreview(shown.park);
    this.publishPreview(shown.park.slotId, shown.park.revision, notice);
  }

  private publishPreview(slotId: ParkPreview['slotId'] | null, revision: number | null, notice: string | null): void {
    // The manager publishes its snapshot on a short throttle; the card must not appear before the slot list it is built
    // from (Continue would arrive a moment later and move every entry), so hand the store the current one first.
    useUiStore.getState().setSavesSnapshot(this.saves.snapshot());
    updateUiSnapshot({ menuPreview: { phase: 'ready', slotId, revision }, menuNotice: notice });
    this.startSweep();
  }

  /** The empty starter map behind a menu with nothing to continue; swaps only if something else is showing. */
  private showStarterMap(): void {
    this.preview = null;
    // The boot session is an empty starter too, but the backdrop is the developer park: it is built once.
    if (this.starterShown && this.starterIsDevPark) return;
    this.swapSession(this.starterPark(), 'new-park', () => {
      this.clock.restore({ speed: 0, simulationTimeMs: 0 });
      this.clock.resetAccumulator();
      this.setParkViewRotation(0);
      updateUiSnapshot({ speed: 0, rewardDraft: null });
      useUiStore.getState().resetScenarioResult();
      this.syncUi();
    });
    this.starterShown = true;
    // The drift circles the built park, not the empty middle of the map.
    if (this.starterIsDevPark) this.sweep.setCentre(DEV_PARK_CENTRE.x, DEV_PARK_CENTRE.y);
  }

  /**
   * The park behind a menu with nothing to continue (a first visit): the developer park, so there is something to look
   * at. It is only a backdrop; New park starts a fresh session. An empty park if the layout cannot be stamped.
   */
  private starterPark(): ParkSession {
    const session = new ParkSession(null);
    try {
      seedDevPark(session);
      this.starterIsDevPark = true;
      return session;
    } catch (error) {
      console.warn('The start screen could not build the developer park:', error);
      this.starterIsDevPark = false;
      return new ParkSession(null);
    }
  }

  /**
   * Puts a read save on screen as the start screen's backdrop through the same atomic swap a load
   * uses, but WITHOUT the load's bookkeeping: nothing is chosen, started or registered until Continue.
   */
  private installPreview(preview: ParkPreview): void {
    const { loaded } = preview;
    this.swapSession(loaded.session, 'loaded', () => {
      this.clock.restore(loaded.save.app.clock);
      this.clock.setSpeed(0);
      this.clock.resetAccumulator();
      // The saved view (absent in older saves: 0). The start screen's sweep shows the park as it was left.
      const savedView = loaded.save.app.viewRotation;
      this.setParkViewRotation(isViewRotation(savedView) ? savedView : 0);
      updateUiSnapshot({ speed: 0, rewardDraft: null });
      useUiStore.getState().resetScenarioResult();
      this.syncUi();
    });
    this.preview = preview;
    this.starterShown = false;
  }

  /** Whether the sweep may run: a renderer that can place the camera, and no voxel failure (a software or broken GPU). */
  private sweepAllowed(): boolean {
    if (!this.renderer?.setCameraCentre) return false;
    return !(window as unknown as { __voxelFailure?: string }).__voxelFailure;
  }

  private startSweep(): void {
    this.stopSweep();
    if (!this.sweepAllowed()) return;
    this.sweep.reset();
    this.sweepStill = reducedMotion();
    this.stopWatchingMotion = onReducedMotionChange((reduced) => { this.sweepStill = reduced; });
    this.sweepActive = true;
    this.sweepLastX = Number.NaN;
    this.sweepLastY = Number.NaN;
    this.sweepLastZoom = Number.NaN;
    this.sweepBaseZoom = this.renderer?.cameraZoom ?? null;
    this.sweepStartPhase = this.session.calendar.viewInto(this.frameCalendar, this.world.tick + this.clock.stepFraction).effectiveFraction;
    this.driveSweep(0);
  }

  private stopSweep(): void {
    this.sweepActive = false;
    this.stopWatchingMotion?.();
    this.stopWatchingMotion = null;
    // The sweep's zoom steps were presentation for the menu: the park is handed back at the zoom it had.
    if (this.sweepBaseZoom !== null && this.renderer?.cameraZoom !== this.sweepBaseZoom) this.renderer?.setCameraZoom?.(this.sweepBaseZoom);
    this.sweepBaseZoom = null;
  }

  /** The time of day the sweep shows, or null when the park's own clock decides (no sweep, or a still one). */
  private sweepTimeOfDay(): number | null {
    if (!this.sweepActive || this.sweepStill) return null;
    return sweepDayPhase(this.sweep.elapsedSeconds, this.sweepStartPhase);
  }

  /** One frame of the drift. Allocation-free; under reduced motion it holds the centre and writes nothing after the first frame. */
  private driveSweep(deltaMs: number): void {
    const renderer = this.renderer;
    if (!renderer?.setCameraCentre) return;
    const point = this.sweepStill ? this.sweep.current(this.sweepPoint) : this.sweep.advance(deltaMs, this.sweepPoint);
    if (this.sweepBaseZoom !== null && renderer.setCameraZoom) {
      const zoom = this.sweepBaseZoom + (this.sweepStill ? 0 : sweepZoomStep(this.sweep.elapsedSeconds));
      if (zoom !== this.sweepLastZoom) {
        this.sweepLastZoom = zoom;
        renderer.setCameraZoom(zoom);
        // A new zoom moves the view about the old centre; the centre below must be written again.
        this.sweepLastX = Number.NaN;
      }
    }
    if (point.x === this.sweepLastX && point.y === this.sweepLastY) return;
    this.sweepLastX = point.x;
    this.sweepLastY = point.y;
    renderer.setCameraCentre(point.x, point.y);
  }

  /** Every way out of the menu except Resume: the park is chosen, loaded or new, and the clock is theirs to set. */
  private leaveMenuForPlay(): void {
    this.stopSweep();
    this.preview = null;
    this.previewToken += 1;
    this.previewWaitsForRecovery = false;
    this.menuHold = false;
    this.menuPausedSpeed = null;
    this.starterShown = false;
    updateUiSnapshot({ menuKind: null, menuPanel: 'main', menuNotice: null, menuPreview: NO_MENU_PREVIEW });
  }

  /**
   * Continue. Reuses the park already built for the sweep when its slot is still the newest and has
   * not been rewritten (same revision), so what starts is exactly the parked state; otherwise it takes
   * the normal load path. Like Load, the park starts paused.
   */
  async menuContinue(): Promise<void> {
    const ui = useUiStore.getState();
    if (ui.menuKind !== 'start' || ui.menuPreview.phase !== 'ready') return;
    if (this.recoveryController.snapshot().phase !== 'idle' || this.saves.snapshot().busy.loading !== null) return;
    const latest = latestSave(this.saves.snapshot().slots);
    if (latest === null) return;
    const preview = this.preview;
    if (preview !== null && preview.slotId === latest.id && preview.revision === latest.revision) {
      this.commitPreview(preview);
      return;
    }
    updateUiSnapshot({ menuNotice: null });
    const result = await this.loadGame(latest.id);
    if (!result.ok) updateUiSnapshot({ menuNotice: result.error.message });
  }

  /** The previewed park becomes the live one: the clock, undo ring, autosave schedule and recovery lock start now. */
  private commitPreview(preview: ParkPreview): void {
    const { loaded } = preview;
    this.leaveMenuForPlay();
    this.parkChosen = true;
    const ui = useUiStore.getState();
    ui.closeScenarioPicker();
    ui.closeLoadout();
    ui.closeSavesDialog();
    const runPending = this.adoptRunPark();
    this.saves.notifyParkStarted();
    const summary = this.saves.adoptPreview(preview);
    if (runPending) this.runChanged();
    this.recoveryController.parkStarted(this.parkInfoOf(loaded.session));
    this.publishUndoStatus();
    this.toast(describeLoadResult(summary), 'routine');
  }

  /** New park from the start screen (the picker's choice; the Meadow Garden when none): a fresh sandbox with the First Day hints. */
  menuNewPark(mapId?: MapId): void {
    if (useUiStore.getState().menuKind !== 'start') return;
    if (this.recoveryController.snapshot().phase !== 'idle') return;
    this.startScenario(null, [], mapId);
  }

  /** True while a park-starting menu action may run: not behind an unanswered recovery offer. */
  private menuMayStartPark(): boolean {
    return this.recoveryController.snapshot().phase === 'idle';
  }

  /**
   * The Map entry, from the start screen or the pause menu: the setup panel (New run, Continue run), or, in the pause menu of a
   * park that is a stage of a run, that run's map.
   */
  menuOpenTheMap(): void {
    const ui = useUiStore.getState();
    if (ui.menuKind === null || !this.menuMayStartPark()) return;
    if (ui.menuKind === 'pause' && this.session.run !== null) {
      this.closePauseMenuKeepingPause();
      this.openRunMap();
      return;
    }
    updateUiSnapshot({ menuPanel: 'the-map', menuNotice: null });
  }

  /** The pause menu closes without giving the speed back: the park stays paused behind the screen that follows. */
  private closePauseMenuKeepingPause(): void {
    if (useUiStore.getState().menuKind !== 'pause') return;
    this.menuPausedSpeed = null;
    updateUiSnapshot({ menuKind: null, menuPanel: 'main', menuNotice: null });
  }

  /** "Open The Map" on the one-time offer in a park: the pause menu on the setup panel. */
  private openMapSetupFromPark(): void {
    this.openPauseMenu();
    if (useUiStore.getState().menuKind !== 'pause') return;
    updateUiSnapshot({ menuPanel: 'the-map' });
  }

  /** A Scenario-mode park from the browser's loadout (the unlock is checked by `startPark`). */
  menuStartScenario(scenarioId: string, cardIds: readonly string[]): void {
    if (!this.menuMayStartPark()) return;
    this.startPark({ mode: 'scenario', scenarioId: scenarioId as ScenarioId, cardIds });
  }

  /**
   * Opens the park chooser on a panel: from the result overlay (no menu is up: the result closes and the pause menu
   * opens on the panel), from the pause menu, or from the start screen.
   */
  openParksChooser(panel: 'modes' | 'scenarios' | 'collection'): void {
    if (this.destroyed || !this.renderer) return;
    const ui = useUiStore.getState();
    if (ui.menuKind === null) {
      // A reward draft must be answered first (the card is the reward); Escape never closes it either.
      if (ui.rewardDraft !== null) return;
      ui.dismissScenarioResult();
      this.openPauseMenu();
      if (useUiStore.getState().menuKind === null) return;
    }
    // Phase 30: from the pause menu the chooser replaces the park being played, so a park with changes no save holds
    // asks first, exactly as Quit to menu does (same panel, same choices); Save or Quit without saving then leaves for
    // the start screen on the chosen panel, Cancel stays in the park.
    if (useUiStore.getState().menuKind === 'pause' && planQuit(this.saves.snapshot().unsavedChanges) === 'confirm') {
      this.chooserAfterQuit = panel;
      updateUiSnapshot({ menuPanel: 'quit', menuNotice: null });
      return;
    }
    updateUiSnapshot({ menuPanel: panel, menuNotice: null });
  }

  setUseBonuses(mode: GameMode, on: boolean): void {
    this.profile.setUseBonuses(mode, on);
  }

  dismissProfileNotice(): void {
    this.profile.dismissNotice();
  }

  /** Resume a saved park from the chooser: the same path as Load (the park starts paused). */
  async menuLoadSlot(slotId: string): Promise<void> {
    if (!this.menuMayStartPark() || this.saves.snapshot().busy.loading !== null) return;
    updateUiSnapshot({ menuNotice: null });
    const result = await this.loadGame(slotId as Parameters<SaveManager['load']>[0]);
    // 'deferred': "Leave the run?" is up and the load follows its answer; nothing failed.
    if (!result.ok && result.error.code !== 'deferred') updateUiSnapshot({ menuNotice: result.error.message });
  }

  /**
   * Esc with nothing else to close, or the Menu button: pauses the clock and shows the pause menu.
   * The speed is remembered and given back by Resume (not by a load or a new park, which set their own).
   */
  openPauseMenu(): void {
    const ui = useUiStore.getState();
    if (this.destroyed || !this.renderer || ui.menuKind !== null || isRecoveryPromptOpen(ui.recovery.phase)) return;
    // The button is reachable by keyboard behind a modal: a result overlay, a reward draft, the Parks map, a loadout, Settings or
    // Save / Load owns the screen, and a pause menu opened underneath it would stop the clock behind the player's back.
    if (OVERLAY_CONTEXTS.has(activeInputContext(ui))) return;
    // A drag or a half-laid path in progress ends here; nothing may continue behind the menu. A paint drag is
    // settled as itself (its label and its charge) before the bulldozer's settle commits whatever is pending.
    this.finishPaintGesture();
    this.finishDemolitionGesture();
    this.resetGestureState();
    this.renderer.clearPreview();
    ui.setHover(null);
    this.chooserAfterQuit = null;
    this.menuPausedSpeed = this.clock.speed;
    this.setSpeed(0);
    updateUiSnapshot({ menuKind: 'pause', menuPanel: 'main', menuNotice: null });
  }

  resumeFromMenu(): void {
    if (useUiStore.getState().menuKind !== 'pause') return;
    const speed = this.menuPausedSpeed;
    this.menuPausedSpeed = null;
    this.chooserAfterQuit = null;
    updateUiSnapshot({ menuKind: null, menuPanel: 'main', menuNotice: null });
    if (speed !== null && speed !== this.clock.speed) this.setSpeed(speed);
  }

  menuQuickSave(): void {
    this.quickSave();
  }

  /** Quit to menu: straight away when nothing is unsaved, otherwise the menu asks first. */
  requestQuitToMenu(): void {
    if (useUiStore.getState().menuKind !== 'pause') return;
    this.chooserAfterQuit = null;
    if (planQuit(this.saves.snapshot().unsavedChanges) === 'quit-now') {
      void this.quitToMenu();
      return;
    }
    updateUiSnapshot({ menuPanel: 'quit', menuNotice: null });
  }

  /** The answer to "save before you leave?". A save that fails keeps the player in the park with the reason. */
  async confirmQuitToMenu(choice: Exclude<QuitChoiceId, 'cancel'>): Promise<void> {
    if (useUiStore.getState().menuKind !== 'pause') return;
    if (choice === 'save') {
      const result = await this.saves.quickSave();
      // Cancel (or Escape) while the save was in flight means "stay": the save stands, the park is not left.
      if (this.destroyed || useUiStore.getState().menuKind !== 'pause' || useUiStore.getState().menuPanel !== 'quit') return;
      if (!result.ok) {
        updateUiSnapshot({ menuNotice: `${result.error.message} The park was not left.` });
        // Every slot taken and none chosen: let the player pick which to replace.
        if (result.error.code === 'invalid-slot') {
          useUiStore.getState().openSavesDialog();
          void this.saves.refresh();
        }
        return;
      }
    }
    await this.quitToMenu();
  }

  /**
   * Back to the start screen. The park stops being played (no marker or lock, no autosave), the start
   * screen opens over the sweep of the NEW latest park (the save that was just written, if there was
   * one) and nothing of the old session stays live.
   */
  private async quitToMenu(): Promise<void> {
    this.recoveryController.markClean();
    this.parkChosen = false;
    this.enterStartMenu();
    // "New run" on a run's end screen leaves for the setup panel (Phase 23).
    if (this.quitPanel !== null) {
      updateUiSnapshot({ menuPanel: this.quitPanel });
      this.quitPanel = null;
    } else if (this.chooserAfterQuit !== null) {
      // Phase 30: the Parks chooser the pause menu's question stood in for.
      updateUiSnapshot({ menuPanel: this.chooserAfterQuit });
    }
    this.chooserAfterQuit = null;
    this.closeInspector();
    await this.refreshMenuPreview();
  }

  destroy(): void {
    this.destroyed = true;
    this.previewToken += 1;
    this.stopSweep();
    this.unsubscribeWorld?.();
    this.unsubscribeUi?.();
    registerGameCommands(null);
    registerRunCommands(null);
    registerSaveCommands(null);
    registerRecoveryCommands(null);
    this.unsubscribeRecovery?.();
    this.stopWatchingAutosaveSetting?.();
    this.stopWatchingAutosaveSetting = null;
    window.removeEventListener('pageshow', this.handlePageShow);
    window.removeEventListener('resize', this.pushViewInsets);
    window.removeEventListener('storage', this.handleProfileStorage);
    this.unsubscribeProfile?.();
    this.unsubscribeProfile = null;
    this.recoveryController.markClean();
    this.recoveryController.dispose();
    window.removeEventListener('pointerdown', this.unlockAudio, true);
    window.removeEventListener('keydown', this.unlockAudio, true);
    this.stopWatchingVolumes?.();
    this.stopWatchingVolumes = null;
    this.audio.setSuspended(true);
    window.removeEventListener('keydown', this.handleShortcuts);
    window.removeEventListener('keydown', this.handlePeekKey);
    window.removeEventListener('keydown', this.trackShift);
    window.removeEventListener('keyup', this.trackShift);
    window.removeEventListener('keyup', this.handlePeekKey);
    window.removeEventListener('blur', this.releasePeek);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('pagehide', this.handlePageHide);
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    this.undo.clear('disposed');
    this.saves.dispose();
    this.renderer?.destroy();
  }

  private appTicker(renderer: RendererPort): void {
    renderer.onFrame((deltaMs) => {
      // Phase 19: after a fatal error the park stays stopped and the error screen is up; nothing runs again.
      if (this.fatal) return;
      try {
        this.frame(renderer, deltaMs);
      } catch (error) {
        this.enterFatal(error);
      }
    });
  }

  /** One frame of the app: the clock, the presentation, the 4 Hz publish (see appTicker). */
  private frame(renderer: RendererPort, deltaMs: number): void {
    this.elapsedMs += deltaMs;
    this.clock.update(deltaMs);
    // Phase 15: what the park did this frame, as feedback cues (presentation only; a cheap no-op on a still tick).
    if (!this.sweepActive) this.feedback.observe();
    if (this.sweepActive) this.driveSweep(deltaMs);
    this.saves.frame(deltaMs);
    this.pathfindingAccumulator += deltaMs;
    if (this.pathfindingAccumulator >= 1_000) {
      this.pathfindingAccumulator -= 1_000;
      this.pathfindingRequestsPerSecond = this.guests.navigation.consumeRequestCount()
        + this.operations.navigation.consumeRequestCount();
    }
    const renderStart = performance.now();
    // Presentation only: the clock fraction, smoothed between fixed steps and frozen while paused
    // (stepFraction is). Read-only; nothing here can reach the simulation.
    const stepFraction = this.clock.stepFraction;
    renderer.setTimeOfDay(
      TIME_OVERRIDE ?? this.sweepTimeOfDay() ?? this.session.calendar.viewInto(this.frameCalendar, this.world.tick + stepFraction).effectiveFraction,
    );
    renderer.setMachineryPaused?.(this.clock.speed === 0);
    renderer.setWeather?.(this.session.weatherViewInto(this.frameWeather, this.world.tick + stepFraction));
    renderer.update(deltaMs, this.elapsedMs, stepFraction);
    if (this.resolveFirstFrame !== null) {
      this.resolveFirstFrame();
      this.resolveFirstFrame = null;
    }
    this.uiAccumulator += deltaMs;
    if (this.uiAccumulator >= 250) {
      this.uiAccumulator = 0;
      const performanceStats = renderer.getPerformance();
      // The estate list is only rendered inside the dashboard; while it is closed the rows
      // from the last construction change are still accurate enough to open onto.
      // Phase 42: the Buildings window lists them too, and the Staff window its workers (each only while open).
      const ui = useUiStore.getState();
      const buildings = ui.managementOpen || ui.openWindows.length > 0
        ? this.session.buildingsSnapshot()
        : undefined;
      const workers = ui.openWindows.includes('staff') ? this.operations.workersSnapshot() : undefined;
      updateUiSnapshot({
        tick: this.world.tick,
        ...this.calendarUi(),
        weatherUi: this.keyedWeatherUi(),
        guestCount: this.guests.guests.size,
        cash: this.world.cash,
        selectedRide: this.selectedRideId === null ? null : this.rides.snapshot(this.selectedRideId),
        selectedCoasterLift: this.selectedCoasterLift(),
        selectedService: this.selectedServiceId === null ? null : this.shops.snapshot(this.selectedServiceId),
        selectedGuest: this.selectedGuestUi(),
        ...this.parkReadsUi(),
        pulseInsights: this.guests.thoughtInsights(),
        management: this.management.snapshot(),
        ...(buildings ? { buildings } : {}),
        ...(workers ? { workers } : {}),
        progression: this.progression.snapshot(),
        onboarding: this.session.onboardingSnapshot(),
        gateFacing: this.world.entranceFacing,
        scenery: this.scenery.snapshot(),
        scenario: this.session.scenarioSnapshot(),
        activeCards: this.cardFaces(),
        performance: {
          fps: Math.round(performanceStats.fps),
          simulationMs: this.clock.lastStepDurationMs,
          renderMs: performance.now() - renderStart,
          entities: performanceStats.entities,
          pathfindingRequests: this.pathfindingRequestsPerSecond,
        },
      });
      this.stepCapacityNotice();
      this.publishCrowd();
      this.refreshAmbience();
      this.noticeDegradation();
      this.refreshHints();
      // The label counts simulated seconds ("rewinds 42 s") and the arm expires on a timer, so
      // the control is refreshed on this cadence, and written only when something changed.
      this.publishUndoStatus();
    }
  }

  /**
   * Phase 19: the frame loop threw. The park stops, an emergency autosave is attempted (the same flush as a hidden page:
   * it writes only a park that changed), and the error screen takes over with Reload, Reload and recover, and the
   * feedback report. Never throws itself.
   */
  private enterFatal(error: unknown): void {
    if (this.fatal) return;
    this.fatal = true;
    console.error(error);
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    try { this.clock.setSpeed(0); } catch { /* the clock may be what broke */ }
    try { this.saves.flushOnHide(); } catch (saveError) { console.error(saveError); }
    try { this.audio.setSuspended(true); } catch { /* nothing to silence */ }
    updateUiSnapshot({ fatalError: message });
  }

  /** Phase 19: the feedback report (see GameCommands.buildFeedbackReport). */
  buildFeedbackReport(message: string, includePark: boolean): FeedbackReport {
    let save: ParkSave | null = null;
    if (includePark && this.canAttachPark()) {
      try {
        const captured = this.capturePark();
        save = createParkSave(captured.state, captured.app, Date.now());
      } catch (error) {
        console.error(error);
      }
    }
    return buildFeedbackReport(message, {
      gameVersion: GAME_VERSION,
      renderer: this.renderer === null ? null : this.renderer.kind === 'classic' ? 'classic' : 'voxel',
      userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
      screen: {
        width: typeof window === 'undefined' ? 0 : window.innerWidth,
        height: typeof window === 'undefined' ? 0 : window.innerHeight,
        pixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
      },
      createdAt: new Date().toISOString(),
      fatalError: useUiStore.getState().fatalError,
    }, getSettings(), save);
  }

  /**
   * Phase 19: waits for the start screen to pick the newest save, then continues it (as the Continue entry does). With
   * no save there is nothing to recover and the start screen simply stays.
   */
  private recoverWhenReady(): void {
    let done = false;
    const attempt = (): boolean => {
      if (done) return true;
      const ui = useUiStore.getState();
      if (this.destroyed || ui.menuKind !== 'start') return (done = true);
      if (ui.menuPreview.phase !== 'ready') return false;
      done = true;
      if (ui.menuPreview.slotId !== null) void this.menuContinue();
      return true;
    };
    if (attempt()) return;
    const stop = useUiStore.subscribe(() => {
      if (attempt()) stop();
    });
  }

  /** Phase 19: a park is running (not the backdrop behind the start screen). */
  canAttachPark(): boolean {
    return this.saveHost.hasPark();
  }

  /**
   * Phase 16: the placement readout's theme line. `previewThemeBonus` is pure but walks every same-theme destination, and
   * a pointer move fires on every pixel, so it runs only when the hovered cell, the armed piece, its rotation or the world
   * (its version, or a different park) changes; the store is written only when the view changed.
   */
  private themePreviewKey: string | null = null;
  private themePreviewWorld: GameWorld | null = null;

  private publishThemePreview(definition: BuildDefinition | undefined, cell: Cell | null, rotation: Rotation): void {
    const themed = cell !== null && definition?.kind === 'scenery' && definition.theme !== undefined ? definition : null;
    const key = themed === null || cell === null ? null : `${themed.id}|${cell.x},${cell.y}|${rotation}|${this.world.version}`;
    if (key === this.themePreviewKey && (key === null || this.themePreviewWorld === this.world)) return;
    this.themePreviewKey = key;
    this.themePreviewWorld = key === null ? null : this.world;
    const view = themed === null || cell === null ? null : placementThemeViewOf(this.scenery.previewThemeBonus(themed.id, cell, rotation));
    if (!samePlacementThemeView(view, useUiStore.getState().previewTheme)) updateUiSnapshot({ previewTheme: view });
  }

  /** The hand, with the Research Grant line printed at this park's research cost scale (Phase 16). */
  private cardFaces(): ActiveCardSnapshot[] {
    return researchCardFaces(this.session.cardsSnapshot(), researchCostScaleOf(this.session.rules));
  }

  private handleHover(cell: Cell | null): void {
    if (this.menuBlocksWorld()) return;
    this.handleHoverCell(cell);
    this.publishCrowdHover();
    // Every branch below ends here: only an object placement of a themed scenery piece keeps a theme preview.
    const state = useUiStore.getState();
    const definition = cell !== null && state.tool === 'build' && state.selectedDefinitionId ? BUILD_BY_ID.get(state.selectedDefinitionId) : undefined;
    this.publishThemePreview(definition, cell, this.buildRotation());
  }

  private handleHoverCell(cell: Cell | null): void {
    if (!cell) {
      if (useUiStore.getState().tool === 'paint') this.renderer?.setPaintHover?.(null);
      else this.renderer?.clearPreview();
      useUiStore.getState().setHover(null);
      return;
    }
    const state = useUiStore.getState();
    if (state.tool === 'paint') {
      this.hoverPaint(cell);
      return;
    }
    if (state.tool === 'pointer') {
      this.renderer?.clearPreview();
      // Phase 21: unowned land names itself under the pointer (never silently unbuildable).
      const land = this.landHoverText(cell);
      if (land === null) state.setHover(cell);
      else state.setHover(cell, 0, true, land.detail, land.title);
      return;
    }
    if (state.tool === 'bulldoze') {
      this.hoverBulldoze(cell);
      return;
    }
    if (state.tool === 'land') {
      this.hoverLand(cell);
      return;
    }
    const definition = state.selectedDefinitionId ? BUILD_BY_ID.get(state.selectedDefinitionId) : undefined;
    if (!definition) {
      this.renderer?.clearPreview();
      state.setHover(cell);
      return;
    }
    if (definition.custom === 'coaster') {
      // Switching coaster type keeps the layout. Anything the new type disallows — a height over
      // its limit, a special it cannot fit — is reported by validation instead of thrown away.
      this.coasterTypeId = definition.id;
      this.renderer?.clearPreview();
      state.setHover(cell, 0, true, this.coasterHeightLine(cell));
      this.refreshCoasterPreview();
      return;
    }
    if (definition.kind === 'path') {
      if (this.draftPath.length > 0) return;
      const placeable = this.world.canPlacePath(cell);
      const affordable = this.world.cash >= this.world.pathCost;
      this.renderer?.drawPreview([cell], definition, placeable && affordable);
      state.setHover(cell, this.world.pathCost, placeable && affordable, affordable
        ? placeable ? null : pathBlockedMessage(this.world, cell)
        : shortfallMessage(this.world.pathCost, this.world.cash));
      return;
    }
    // Phase 40: arriving beside a path, a front-only building turns its front toward it by itself; R wins on the cell it
    // was pressed on (until the pointer moves to another cell).
    if (this.manualFacingCell !== null && !sameCell(cell, this.manualFacingCell)) this.manualFacingCell = null;
    if (this.manualFacingCell === null && this.world.frontAccessFor(definition)) {
      const facing = this.world.facingRotation(definition, cell, this.buildRotation());
      if (facing !== this.buildRotation()) useUiStore.setState({ buildRotation: facing });
    }
    const rotation = this.buildRotation();
    const cells = this.world.footprintCells(definition, cell, rotation);
    const effectiveCost = this.world.objectCost(definition);
    // The readout and the click toast read the same check, so they can never name different
    // reasons for the same refusal.
    const check = this.world.checkObjectBuild(definition.id, cell, rotation);
    this.renderer?.drawPreview(cells, definition, check.ok, false, rotation, this.nextColours(definition.id));
    // Suppress the readout on the exact cell a toast just explained: one message per refusal.
    const explainedByToast = this.blockToastCell !== null && sameCell(cell, this.blockToastCell);
    // Phase 40: buildable, but with its front to no path guests could never use it: say so (it can still be built).
    const frontWarning = check.ok && this.world.frontAccessFor(definition) && !this.world.frontFacesPath(definition, cell, rotation)
      ? FRONT_FACES_NO_PATH
      : null;
    state.setHover(
      cell,
      effectiveCost,
      check.ok,
      check.ok || explainedByToast
        ? frontWarning
        : placementBlockReason(this.world, check.reason, definition, cell, rotation, check.reason === 'locked' ? this.session.buildLockOf(definition.id) : null),
    );
    if (!explainedByToast) this.blockToastCell = null;
  }

  private handleStart(cell: Cell, modifiers?: PointerModifiers): void {
    if (this.menuBlocksWorld()) return;
    const state = useUiStore.getState();
    // A drag whose pointer-up never arrived must not leak its snapshot into the next gesture. The paint drag goes
    // first: `finishDemolitionGesture` commits ANY pending snapshot, and would name (and not charge) a paint drag.
    this.finishPaintGesture();
    this.finishDemolitionGesture();
    if (state.tool === 'paint') {
      if (state.paintPicking) this.pickColoursAt(cell);
      else {
        this.paintGesture = new PaintGesture(this.paintHost(), state.paintBrush, state.paintTarget, modifiers?.shift ?? false);
        this.paintGesture.start(cell);
      }
      return;
    }
    if (state.tool === 'bulldoze') {
      this.bulldozed.clear();
      this.refusedProps.clear();
      this.lastBulldozeCell = null;
      this.bulldozeTo(cell, true);
      return;
    }
    if (state.tool === 'land') {
      this.buyParcelAt(cell);
      return;
    }
    // Inspecting is the pointer tool's job alone. An armed build tool stays armed no matter what
    // the click lands on, so routing a path past a 3×3 ride can never disarm it.
    if (state.tool === 'pointer') {
      this.selectObjectAt(cell);
      return;
    }
    const definition = state.selectedDefinitionId ? BUILD_BY_ID.get(state.selectedDefinitionId) : undefined;
    if (definition?.custom === 'coaster') {
      const before = this.coasterDraft.length;
      // A press on a piece that sits on a climb (not the one the track continues from) flips that
      // lift instead of starting a drag.
      const pressed = this.draftIndexAt(cell);
      if (pressed >= 0 && pressed < before - 1) {
        const run = liftRunAtPiece(this.coasterDraft, pressed);
        if (run) {
          this.coasterLastCell = null;
          this.flipDraftRun(run.start);
          return;
        }
      }
      this.appendCoasterCells([cell]);
      // A layout that survived a tool change is still contiguous track: say so rather than
      // letting the click do nothing.
      if (before > 0 && this.coasterDraft.length === before) {
        this.toast('Track has to continue from the last piece');
      }
      this.coasterLastCell = cell;
      return;
    }
    if (definition?.kind === 'path') {
      this.draftPath = [cell];
      this.lastDraftCell = cell;
      this.previewDraftPath();
    }
  }

  private handleMove(cell: Cell): void {
    if (this.menuBlocksWorld()) return;
    const state = useUiStore.getState();
    if (state.tool === 'bulldoze') {
      this.bulldozeTo(cell);
      return;
    }
    if (state.tool === 'paint') {
      this.paintGesture?.move(cell);
      return;
    }
    if (state.tool === 'pointer') return;
    const definition = state.selectedDefinitionId ? BUILD_BY_ID.get(state.selectedDefinitionId) : undefined;
    if (definition?.custom === 'coaster') {
      if (!this.coasterLastCell || sameCell(cell, this.coasterLastCell)) return;
      this.appendCoasterCells(lineCells(this.coasterLastCell, cell).slice(1));
      this.coasterLastCell = cell;
      return;
    }
    if (definition?.kind !== 'path' || !this.lastDraftCell || sameCell(cell, this.lastDraftCell)) return;
    // Phase 37: a cell already in the draft cuts it back there, so pulling back takes the path back with it.
    extendPathDraft(this.draftPath, this.lastDraftCell, cell);
    this.lastDraftCell = cell;
    this.previewDraftPath();
  }

  private handleEnd(cell: Cell): void {
    if (this.menuBlocksWorld()) return;
    const state = useUiStore.getState();
    if (state.tool === 'bulldoze') {
      // The drag is over: whatever it took out is one undo entry, however many tiles it crossed.
      this.finishDemolitionGesture();
      this.bulldozed.clear();
      this.lastBulldozeCell = null;
      return;
    }
    if (state.tool === 'paint') {
      this.finishPaintGesture();
      this.hoverPaint(cell);
      return;
    }
    if (state.tool === 'pointer') return;
    const definition = state.selectedDefinitionId ? BUILD_BY_ID.get(state.selectedDefinitionId) : undefined;
    if (!definition) return;
    if (definition.custom === 'coaster') {
      this.coasterLastCell = null;
      return;
    }
    if (definition.kind === 'path') {
      if (this.lastDraftCell && !sameCell(cell, this.lastDraftCell)) this.handleMove(cell);
      // A mid-drag Ctrl+Z emptied the draft while the pointer was still down: nothing to build, no
      // capture, and no "cannot be built" toast over the undo toast.
      if (this.draftPath.length === 0) {
        this.lastDraftCell = null;
        return;
      }
      const buildable = this.draftPath.filter((draft) => this.world.canPlacePath(draft));
      const allValid = this.draftPath.every((draft) => this.world.paths.has(`${draft.x},${draft.y}`) || this.world.canPlacePath(draft));
      const cost = buildable.length * this.world.pathCost;
      const affordable = cost <= this.world.cash;
      const willBuild = allValid && affordable;
      // The snapshot is taken immediately BEFORE the first mutation, and only for a drag that will
      // try to build: a refused drag costs no capture. Outside any world.batch (serialize throws in one).
      if (willBuild) this.undo.begin('paths');
      const result = willBuild
        ? this.world.buildPaths(this.draftPath)
        : { built: 0, spent: 0, added: [] };
      if (result.built > 0) {
        const last = result.added[result.added.length - 1];
        this.feedback.money(-result.spent, last.x, last.y);
        this.commitGesture(pathsBuiltLabel(result.built));
        this.toast(`${result.built} path tile${result.built === 1 ? '' : 's'} built · -$${result.spent}`, 'routine');
      } else {
        this.undo.abandon();
        this.blockToastCell = { ...cell };
        this.toast(affordable ? this.draftBlockedMessage() : shortfallMessage(cost, this.world.cash));
      }
      this.draftPath = [];
      this.lastDraftCell = null;
      this.handleHover(cell);
      return;
    }
    const rotation = this.buildRotation();
    const check = this.world.checkObjectBuild(definition.id, cell, rotation);
    if (check.ok) this.undo.begin('object');
    // Colour before placing: the brush's colours go onto the new object in the same batch (one renderer sync,
    // one undo entry, free: a recolour fee is for changing what is already there).
    const colours = this.nextColours(definition.id);
    const placed = check.ok
      ? this.world.batch(() => {
        // Phase 40: the player gets exactly the turn the ghost showed (the world turns only non-player placements).
        const built = this.world.buildObject(definition.id, cell, rotation, { exactRotation: true });
        if (built && colours) this.world.setObjectColours(built.id, colours);
        return built;
      })
      : null;
    if (placed) {
      const spent = this.world.objectCost(definition);
      this.feedback.build(0, 0, placed.id);
      this.feedback.money(-spent, 0, 0, placed.id);
      this.commitGesture(objectBuiltLabel(definition.name));
      this.toast(`${definition.name} built · -$${spent.toLocaleString()}`, 'routine');
    } else {
      this.undo.abandon();
      const reason = check.ok ? 'blocked' : check.reason;
      this.blockToastCell = { ...cell };
      this.toast(placementBlockToast(this.world, reason, definition, cell, rotation, reason === 'locked' ? this.session.buildLockOf(definition.id) : null));
    }
    this.handleHover(cell);
  }

  private previewDraftPath(): void {
    const definition = BUILD_BY_ID.get('sunstone-path')!;
    const placeable = this.draftPath.filter((cell) => this.world.canPlacePath(cell));
    const cost = placeable.length * this.world.pathCost;
    const affordable = cost <= this.world.cash;
    const blocked = blockedDraftCells(this.draftPath, (cell) => this.world.paths.has(`${cell.x},${cell.y}`) || this.world.canPlacePath(cell));
    const valid = placeable.length > 0 && blocked.length === 0 && affordable;
    // Phase 37: the cells that cannot take a path are drawn red and the rest normally, so the player sees what to
    // steer round; a draft the park cannot afford is all red, as before.
    const allRed = !affordable || placeable.length === 0;
    this.renderer?.drawPreview(this.draftPath, definition, !allRed, false, 0, null, allRed ? null : blocked);
    useUiStore.getState().setHover(this.lastDraftCell, cost, valid, valid
      ? null
      : cost > this.world.cash ? shortfallMessage(cost, this.world.cash) : this.draftBlockedMessage());
  }

  /** Why the draft path cannot be built: the first cell it cannot take, named (a prop, water, a building), else the plain refusal. */
  private draftBlockedMessage(): string {
    for (const cell of this.draftPath) {
      if (this.world.paths.has(`${cell.x},${cell.y}`) || this.world.canPlacePath(cell)) continue;
      return pathBlockedMessage(this.world, cell);
    }
    return PATH_BLOCKED_MESSAGE;
  }

  /**
   * Clears every tile the pointer actually crossed, not just the ones a pointermove happened to
   * land on, and does it as a single world change so a drag costs one scene rebuild.
   */
  private bulldozeTo(cell: Cell, press = false): void {
    const from = this.lastBulldozeCell;
    const cells = from && !sameCell(from, cell) ? lineCells(from, cell).slice(1) : [cell];
    this.lastBulldozeCell = cell;
    // Phase 11 (PA-015): one track cell takes out the whole coaster, so the first press only arms it (nothing removed,
    // no undo entry) and a second press on any of its cells demolishes it below. Any other press disarms.
    if (press) {
      const coaster = this.wholeCoasterAt(cell);
      if (coaster !== undefined && coaster.id !== this.armedCoasterId) {
        this.armCoaster(coaster, cell);
        return;
      }
      this.armedCoasterId = null;
    }
    // One snapshot per drag, taken right before the first thing is actually demolished and
    // outside the batch below: a drag over empty ground captures nothing, and the snapshot is
    // never staler than the first removal. (`begin` is idempotent while the drag is pending.)
    if (cells.some((target) => this.canDemolishAt(target, press))) this.undo.begin('demolition');
    const removedLabels: string[] = [];
    const clearedLabels: string[] = [];
    let refunded = 0;
    let spent = 0;
    this.world.batch(() => {
      for (const target of cells) {
        const key = `${target.x},${target.y}`;
        if (this.bulldozed.has(key)) continue;
        // A drag never demolishes a coaster: its cells are skipped (a path under the track still goes, being no coaster cell).
        if (!press && this.wholeCoasterAt(target) !== undefined) continue;
        this.bulldozed.add(key);
        const prop = this.world.propAt(target);
        const result = this.world.bulldoze(target);
        if (result.refused !== undefined && prop !== undefined) this.explainClearRefusal(prop.id, prop.kind, result.refused, this.world.clearCost(prop), target);
        if (!result.removed) continue;
        // Phase 15: what this stroke paid back or cost, where it happened.
        this.feedback.money(result.refund - (result.cost ?? 0), target.x, target.y);
        removedLabels.push(result.label ?? 'a tile');
        refunded += result.refund;
        // Phase 24: a prop cleared for its price (the ledger's land-clearing row), not a demolition.
        if (result.cost !== undefined) {
          clearedLabels.push(result.label ?? 'an obstacle');
          spent += result.cost;
        }
      }
    });
    if (removedLabels.length > 0) {
      this.demolishedInDrag.push(...removedLabels);
      this.clearedInDrag += clearedLabels.length;
      // Named as it grows, so Ctrl+Z mid-drag (which commits the pending entry) reads correctly.
      this.undo.setPendingLabel(demolitionLabel(this.demolishedInDrag, this.clearedInDrag));
      this.toast(demolitionToast(removedLabels, refunded, spent, clearedLabels), 'routine');
    }
    const coasterHere = this.wholeCoasterAt(cell);
    if (coasterHere !== undefined) {
      this.drawCoasterBulldozePreview(coasterHere, cell);
      return;
    }
    // The diamond turns slate only over a prop the bulldozer refused and left standing; an emptied or empty cell keeps
    // the demolition red it always had.
    const standing = this.world.propAt(cell);
    this.renderer?.drawPreview(standing === undefined ? [cell] : this.world.propFootprint(standing), null,
      removedLabels.length > 0 || standing === undefined || this.world.checkClear(cell).ok, true);
  }

  /** One toast per refused prop in a drag: too little cash names the shortfall, a permanent prop says it stays. */
  private explainClearRefusal(propId: number, kindId: string, refused: 'permanent' | 'funds' | 'unowned', cost: number | null, cell: Cell): void {
    if (this.refusedProps.has(propId)) return;
    this.refusedProps.add(propId);
    const name = PROP_KIND_BY_ID.get(kindId as PropKindId)?.name ?? 'That';
    if (refused === 'unowned') {
      this.toast(unownedLandMessage(this.world, cell) ?? 'Not your land');
      return;
    }
    this.toast(refused === 'funds' && cost !== null ? shortfallMessage(cost, this.world.cash) : permanentPropText(name));
  }

  /**
   * Phase 21: what the pointer says over land the park does not own: "For sale · $1,230" next to owned land, else "Not
   * your land". Null over owned land (and on a wholly owned map), so the pointer readout stays as it was.
   */
  private landHoverText(cell: Cell): { title: string; detail: string } | null {
    if (!this.world.land.restricted || !this.world.isInside(cell) || this.world.isOwned(cell)) return null;
    const parcel = this.world.land.parcelOfCell(cell);
    const key = keyLabel('landTool');
    const tool = key === '—' ? 'the Land tool' : `the Land tool (${key})`;
    return this.world.land.isForSale(parcel)
      ? { title: `For sale · $${this.world.parcelPrice(parcel).toLocaleString()}`, detail: `Buy this parcel with ${tool}` }
      : { title: 'Not your land', detail: 'Buy the land between first' };
  }

  /** Phase 21: the Land tool's hover: the whole parcel under the cursor, its price and whether it can be bought now. */
  private hoverLand(cell: Cell): void {
    const state = useUiStore.getState();
    if (!this.world.isInside(cell)) {
      this.renderer?.clearPreview();
      state.setHover(cell);
      return;
    }
    const parcel = this.world.land.parcelOfCell(cell);
    const check = this.world.checkParcelPurchase(parcel);
    const rect = parcelRect(this.world.land.grid, parcel);
    const cells: Cell[] = [];
    for (let y = rect.y0; y <= rect.y1; y += 1) for (let x = rect.x0; x <= rect.x1; x += 1) cells.push({ x, y });
    this.renderer?.drawPreview(cells, null, check.ok, false);
    const price = check.price ?? 0;
    state.setHover(cell, price, check.ok, check.ok ? null : landRefusalText(this.world, check), landHoverTitle(check));
  }

  /** Phase 21: one click of the Land tool buys the parcel under it (one undo entry), or says why it cannot. */
  private buyParcelAt(cell: Cell): void {
    if (!this.world.isInside(cell)) return;
    const parcel = this.world.land.parcelOfCell(cell);
    const check = this.world.checkParcelPurchase(parcel);
    if (!check.ok) {
      this.toast(landRefusalText(this.world, check));
      return;
    }
    this.undo.begin('land');
    const bought = this.world.buyParcel(parcel);
    if (!bought.ok) {
      this.undo.abandon();
      this.toast(landRefusalText(this.world, bought));
      return;
    }
    const centre = parcelCentre(this.world.land.grid, parcel);
    this.feedback.money(-bought.price, centre.x, centre.y);
    this.commitGesture('Land bought');
    this.toast(`Bought a parcel of land · -$${bought.price.toLocaleString()}`, 'routine');
    this.syncUi();
    this.handleHover(cell);
  }

  /** The bulldozer's hover: what it would take out, or what it cannot (a clearable prop shows its price; a permanent one says so). */
  private hoverBulldoze(cell: Cell): void {
    const state = useUiStore.getState();
    const coaster = this.wholeCoasterAt(cell);
    if (coaster !== undefined) {
      const name = this.objectName(coaster);
      if (coaster.id === this.armedCoasterId) {
        const text = coasterArmedText(name, this.world.demolitionRefund(coaster.id) ?? 0);
        state.setHover(cell, 0, true, text, text);
      } else {
        state.setHover(cell, 0, true, null, coasterHoverText(name));
      }
      this.drawCoasterBulldozePreview(coaster, cell);
      return;
    }
    const prop = this.world.propAt(cell);
    if (prop === undefined || this.world.objectAt(cell) || this.world.paths.has(`${cell.x},${cell.y}`)) {
      this.renderer?.drawPreview([cell], null, true, true);
      state.setHover(cell, 0, Boolean(this.world.objectAt(cell) || this.world.paths.has(`${cell.x},${cell.y}`)));
      return;
    }
    const name = PROP_KIND_BY_ID.get(prop.kind)?.name ?? 'Obstacle';
    const check = this.world.checkClear(cell);
    if (!check.ok && check.reason === 'permanent') {
      this.renderer?.drawPreview(this.world.propFootprint(prop), null, false, true);
      state.setHover(cell, 0, false, null, permanentPropText(name));
      return;
    }
    if (!check.ok && check.reason === 'unowned') {
      this.renderer?.drawPreview(this.world.propFootprint(prop), null, false, true);
      state.setHover(cell, 0, false, unownedLandMessage(this.world, cell), name);
      return;
    }
    const cost = check.cost ?? 0;
    this.renderer?.drawPreview(this.world.propFootprint(prop), null, check.ok, true);
    state.setHover(cell, cost, check.ok, check.ok ? null : shortfallMessage(cost, this.world.cash), clearHoverText(name, cost));
  }

  /**
   * Phase 11 (PA-015): the custom coaster a bulldozer stroke on this cell would remove whole, or undefined. A path on the
   * cell goes first (under elevated track), so a cell with a path is not a coaster cell for the two-click rule.
   */
  private wholeCoasterAt(cell: Cell): PlacedObject | undefined {
    if (this.world.paths.has(`${cell.x},${cell.y}`)) return undefined;
    const object = this.world.objectAt(cell);
    return object !== undefined && this.world.coasters.has(object.id) ? object : undefined;
  }

  private objectName(object: PlacedObject): string {
    return BUILD_BY_ID.get(object.definitionId)?.name ?? 'This coaster';
  }

  /** The first press on a coaster: arm it, preview the whole footprint red, and say what the second press does (an alert: it needs a decision). */
  private armCoaster(coaster: PlacedObject, cell: Cell): void {
    this.armedCoasterId = coaster.id;
    const text = coasterArmedText(this.objectName(coaster), this.world.demolitionRefund(coaster.id) ?? 0);
    useUiStore.getState().setHover(cell, 0, true, text, text);
    this.drawCoasterBulldozePreview(coaster, cell);
    this.toast(text, 'alert');
  }

  /** An armed coaster previews its whole footprint; an unarmed one only the cell under the cursor. */
  private drawCoasterBulldozePreview(coaster: PlacedObject, cell: Cell): void {
    this.renderer?.drawPreview(coaster.id === this.armedCoasterId ? this.world.objectFootprint(coaster) : [cell], null, true, true);
  }

  /** Whether the bulldozer would take anything out of this cell that it has not already crossed (a drag skips coasters). */
  private canDemolishAt(cell: Cell, press = false): boolean {
    if (this.bulldozed.has(`${cell.x},${cell.y}`) || sameCell(cell, this.world.entrance)) return false;
    if (!press && this.wholeCoasterAt(cell) !== undefined) return false;
    if (this.world.paths.has(`${cell.x},${cell.y}`) || this.world.objectAt(cell) !== undefined) return true;
    // A prop the park can afford to clear (a refused one changes nothing, so it must not start an undo entry).
    return this.world.checkClear(cell).ok;
  }

  /** Commits the pending snapshot under this name, if the gesture changed the world, and shows it. */
  private commitGesture(label: string): void {
    this.undo.commit(label);
    this.publishUndoStatus();
  }

  /** Ends a bulldozer drag: the pending snapshot becomes one ring entry if anything was demolished. */
  private finishDemolitionGesture(): void {
    if (!this.undo.hasPending) return;
    this.commitGesture(demolitionLabel(this.demolishedInDrag, this.clearedInDrag));
    this.demolishedInDrag = [];
    this.clearedInDrag = 0;
  }

  coasterAdjustHeight(delta: number): void {
    const type = this.currentCoasterType();
    if (!type) return;
    this.coasterHeight = Math.min(type.maximumHeight, Math.max(0, this.coasterHeight + Math.sign(delta)));
    this.refreshCoasterPreview();
  }

  coasterToggleSpecial(kind: CoasterSpecial): void {
    const type = this.currentCoasterType();
    const last = this.coasterDraft[this.coasterDraft.length - 1];
    if (!type || !last) return;
    if (!type.allowedSpecials.includes(kind)) {
      this.toast(COASTER_VALIDATION_TEXT['special-not-allowed']);
      return;
    }
    last.special = last.special === kind ? undefined : kind;
    normaliseLiftFlags(this.coasterDraft);
    this.refreshCoasterPreview();
  }

  /**
   * Phase 38: the hover line while laying track: the level the next piece would take, and what is already in this cell
   * (track of this layout or another coaster, at its levels), so a crossing can be planned before it is refused.
   */
  private coasterHeightLine(cell: Cell): string | null {
    const last = this.coasterDraft[this.coasterDraft.length - 1];
    const target = Math.min(this.coasterHeight, this.currentCoasterType()?.maximumHeight ?? 0);
    const next = last === undefined ? 0 : last.height + Math.sign(target - last.height);
    const here = [
      ...this.coasterDraft.filter((piece) => sameCell(piece.cell, cell)).map((piece) => piece.height),
      ...this.world.trackHeightsAt(cell),
    ].sort((a, b) => a - b);
    const below = here.length > 0 ? ` · track here at level ${[...new Set(here)].join(' and ')}` : '';
    return `Next piece at level ${next}${below}`;
  }

  /** The draft piece under the cursor, or null. */
  private hoveredDraftIndex(): number | null {
    const cell = this.renderer?.hoveredCell;
    if (!cell) return null;
    const index = this.draftIndexAt(cell);
    return index >= 0 ? index : null;
  }

  /** Phase 38: the draft piece in a cell, the top-most where the track crosses itself there; -1 if none. */
  private draftIndexAt(cell: Cell): number {
    let found = -1;
    this.coasterDraft.forEach((piece, index) => {
      if (sameCell(piece.cell, cell) && (found < 0 || piece.height >= this.coasterDraft[found].height)) found = index;
    });
    return found;
  }

  /** Flips the lift under the cursor, else the one holding the last piece, else the last lift. */
  coasterToggleLift(): void {
    if (!this.currentCoasterType()) return;
    const run = liftRunForTarget(this.coasterDraft, this.hoveredDraftIndex());
    if (!run) {
      this.toast('No climb here to chain.');
      return;
    }
    this.flipDraftRun(run.start);
  }

  coasterSetLift(runStart: number, chained: boolean): void {
    if (!this.currentCoasterType()) return;
    const run = liftRuns(this.coasterDraft).find((candidate) => candidate.start === runStart);
    if (!run || run.chained === chained) return;
    this.flipDraftRun(run.start);
  }

  private flipDraftRun(runStart: number): void {
    setLiftRunChained(this.coasterDraft, runStart, !liftRuns(this.coasterDraft).find((run) => run.start === runStart)?.chained);
    normaliseLiftFlags(this.coasterDraft);
    this.coasterLiftHistory = recordLiftToggle(this.coasterLiftHistory, {
      pieceCount: this.coasterDraft.length,
      runStart,
    });
    this.refreshCoasterPreview();
  }

  /** One undo step in the designer: the newest lift toggle if it came after the newest piece, else that piece. */
  coasterUndo(): void {
    const step = planDraftUndo(this.coasterLiftHistory, this.coasterDraft.length);
    this.coasterLiftHistory = step.history;
    if (step.kind === 'revert-toggle') {
      toggleLiftRun(this.coasterDraft, step.entry.runStart);
    } else {
      this.coasterDraft.pop();
      normaliseLiftFlags(this.coasterDraft);
    }
    this.coasterLastCell = null;
    this.refreshCoasterPreview();
  }

  coasterClear(): void {
    this.coasterDraft = [];
    this.coasterLiftHistory = EMPTY_LIFT_HISTORY;
    this.coasterLastCell = null;
    this.refreshCoasterPreview();
  }

  coasterBuild(): void {
    const type = this.currentCoasterType();
    if (!type) return;
    const { validation } = checkCoasterDesign(this.coasterDraft, type);
    if (!validation.ok) {
      this.toast(COASTER_VALIDATION_TEXT[validation.reason]);
      return;
    }
    const stats = deriveCoasterStats(this.coasterDraft, type);
    this.undo.begin('coaster');
    const colours = this.nextColours(type.definitionId);
    const result = this.world.batch(() => {
      const placedCoaster = this.world.placeCoaster(
        type.definitionId,
        this.coasterDraft,
        stats,
        coasterBaseCost(this.coasterDraft, type, this.session.rules.chainLiftCostMultiplier),
      );
      if (!('error' in placedCoaster) && colours) this.world.setObjectColours(placedCoaster.id, colours);
      return placedCoaster;
    });
    if ('error' in result) {
      this.undo.abandon();
      this.toast(result.error === 'funds'
        ? 'Not enough cash for this coaster'
        : result.error === 'blocked'
          ? 'The track crosses paths, buildings, other track or land you do not own'
          : result.error === 'locked'
            ? 'Complete its research project first'
            : 'The coaster could not be built');
      return;
    }
    const record = this.world.coasters.get(result.id);
    const name = BUILD_BY_ID.get(type.definitionId)?.name ?? 'Coaster';
    const station = record?.pieces[0]?.cell ?? result.anchor;
    this.feedback.money(-(record?.paidCost ?? 0), station.x, station.y);
    this.commitGesture(objectBuiltLabel(name));
    this.toast(`${name} built · ${stats.pieces} pieces · -$${(record?.paidCost ?? 0).toLocaleString()}`, 'routine');
    this.clearCoasterDraft();
  }

  private currentCoasterType(): CoasterTypeDefinition | undefined {
    const selectedId = useUiStore.getState().selectedDefinitionId;
    return selectedId ? COASTER_TYPE_BY_ID.get(selectedId) : undefined;
  }

  private appendCoasterCells(cells: readonly Cell[]): void {
    for (const cell of cells) {
      if (!this.world.isInside(cell)) continue;
      const last = this.coasterDraft[this.coasterDraft.length - 1];
      if (last && Math.abs(cell.x - last.cell.x) + Math.abs(cell.y - last.cell.y) !== 1) continue;
      // The track climbs toward the selected height one level per piece.
      const target = Math.min(this.coasterHeight, this.currentCoasterType()?.maximumHeight ?? 0);
      const height = last === undefined
        ? 0
        : last.height + Math.sign(target - last.height);
      // Phase 38: the track may run over or under itself where the two pieces are far enough apart in height and
      // neither is a station piece, a special or under a loop ring; any other repeat is refused, as before.
      const crossed = this.coasterDraft
        .map((piece, index) => ({ piece, index }))
        .filter(({ piece }) => sameCell(piece.cell, cell));
      if (crossed.length > 0) {
        const tooClose = crossed.some(({ piece }) => !trackPiecesMayCross(piece.height, height));
        const exclusive = crossed.some(({ index }) => isExclusiveCoasterPiece(this.coasterDraft, index))
          || last?.special === 'loop'
          || coasterHangs(this.currentCoasterType()?.definitionId ?? '');
        if (tooClose || exclusive) {
          if (this.coasterDraftRefusal !== `${cell.x},${cell.y}`) {
            this.coasterDraftRefusal = `${cell.x},${cell.y}`;
            this.toast(COASTER_VALIDATION_TEXT[tooClose ? 'crossing-too-close' : 'crossing-not-allowed']);
          }
          continue;
        }
      }
      this.coasterDraftRefusal = null;
      this.coasterDraft.push({ cell: { ...cell }, height });
      // A piece that continues a hill joins its lift; one that starts a new hill starts chained.
      normaliseLiftFlags(this.coasterDraft);
    }
    this.refreshCoasterPreview();
  }

  /** The only deliberate discard of a layout: the Clear button, a build, or a new park. */
  private clearCoasterDraft(): void {
    this.coasterDraft = [];
    this.coasterLiftHistory = EMPTY_LIFT_HISTORY;
    this.coasterLastCell = null;
    this.coasterHeight = 0;
    this.coasterTypeId = null;
    this.renderer?.drawCoasterDraft([], 0);
    this.renderer?.clearPreview();
    updateUiSnapshot({ coasterDraft: null });
    this.publishUndoStatus();
  }

  private refreshCoasterPreview(): void {
    // Whether Ctrl+Z steps back a piece or takes back a gesture depends on the draft, so the dock
    // control follows every change to it.
    this.publishUndoStatus();
    const type = this.currentCoasterType();
    const definition = type ? BUILD_BY_ID.get(type.definitionId) : undefined;
    // The layout is drawn from the type it belongs to, not the tool that happens to be armed, so
    // it stays visible (dimmed) while the player prices a bench and comes back to it.
    const draftDefinition = this.coasterTypeId ? BUILD_BY_ID.get(this.coasterTypeId) : undefined;
    this.renderer?.drawCoasterDraft(
      this.coasterDraft,
      draftDefinition?.color ?? definition?.color ?? 0xe4572e,
      type !== undefined,
      draftDefinition?.id,
      this.nextColours(draftDefinition?.id ?? null),
    );
    if (!type || !definition) return;
    if (this.coasterDraft.length === 0) {
      updateUiSnapshot({
        coasterDraft: {
          typeName: definition.name,
          maximumHeight: type.maximumHeight,
          allowedSpecials: [...type.allowedSpecials],
          pieces: 0, height: this.coasterHeight, baseCost: 0, effectiveCost: 0,
          stats: null, validationMessage: 'Drag on the grass to lay track. First 3 pieces become the station.',
          buildable: false, affordable: true, lastPieceSpecial: null,
          liftRuns: [], warning: null, chainSavings: 0,
        },
      });
      return;
    }
    const check = checkCoasterDesign(this.coasterDraft, type);
    const validation = check.validation;
    const stats = deriveCoasterStats(this.coasterDraft, type);
    const conflicts = this.coasterDraft.map((piece, index) => this.world.coasterPieceConflict({
      cell: piece.cell, height: piece.height, exclusive: isExclusiveCoasterPiece(this.coasterDraft, index), hangs: coasterHangs(type.definitionId),
    }));
    const conflict = conflicts.find((entry) => entry !== null) ?? null;
    const blocked = conflict !== null;
    const chainRule = this.session.rules.chainLiftCostMultiplier;
    const baseCost = coasterBaseCost(this.coasterDraft, type, chainRule);
    const allChained = this.coasterDraft.map((piece) => {
      const copy = { ...piece };
      delete copy.freeClimb;
      return copy;
    });
    const chainSavings = Math.max(0, coasterBaseCost(allChained, type, chainRule) - baseCost);
    const effectiveCost = Math.round(baseCost * this.session.rules.constructionCostMultiplier);
    const affordable = effectiveCost <= this.world.cash;
    updateUiSnapshot({
      coasterDraft: {
        typeName: definition.name,
        maximumHeight: type.maximumHeight,
        allowedSpecials: [...type.allowedSpecials],
        pieces: this.coasterDraft.length,
        height: this.coasterHeight,
        baseCost,
        effectiveCost,
        stats: {
          excitement: stats.excitement,
          intensity: stats.intensity,
          durationSeconds: stats.durationSeconds,
          turns: stats.turns,
          drops: stats.drops,
          totalDescent: stats.totalDescent,
          highestHeight: stats.highestHeight,
          topSpeed: stats.topSpeed,
          loops: stats.loops,
          boosts: stats.boosts,
        },
        validationMessage: validation.ok
          ? blocked
            ? coasterConflictMessage(conflict)
            : !affordable ? 'Not enough cash.' : check.warning ?? 'Ready to build!'
          : COASTER_VALIDATION_TEXT[validation.reason],
        buildable: validation.ok && !blocked && affordable,
        affordable,
        lastPieceSpecial: this.coasterDraft[this.coasterDraft.length - 1]?.special ?? null,
        liftRuns: check.runs.length > 0 ? check.runs.map((run) => ({
          start: run.start, length: run.length, chained: run.chained, verdict: run.verdict,
        })) : liftRuns(this.coasterDraft).map((run) => ({
          start: run.start, length: run.length, chained: run.chained, verdict: 'ok' as const,
        })),
        warning: check.warning,
        chainSavings,
      },
    });
  }

  /** Forgets a gesture in progress (drafts and the bulldozer's drag) without touching the armed tool. */
  private resetGestureState(): void {
    this.draftPath = [];
    this.lastDraftCell = null;
    this.bulldozed.clear();
    this.refusedProps.clear();
    this.lastBulldozeCell = null;
    this.blockToastCell = null;
    this.demolishedInDrag = [];
    this.clearedInDrag = 0;
    this.paintGesture = null;
    this.armedCoasterId = null;
  }

  /**
   * Puts the armed tool down. It deliberately does not touch a coaster layout in progress: that
   * is the player's work, and only the Clear button, a successful build, or a new park discards it.
   */
  private cancelTool(): void {
    // A cancelled bulldozer drag keeps what it already demolished, so it keeps its undo entry too; so does a paint drag.
    this.finishPaintGesture();
    this.finishDemolitionGesture();
    this.resetGestureState();
    this.renderer?.setPaintHover?.(null);
    this.renderer?.clearPreview();
    useUiStore.getState().cancelTool();
    if (this.coasterDraft.length > 0) this.refreshCoasterPreview();
  }

  /**
   * Escape and right-click are the same gesture: undo the last thing. While a track layout is
   * open that means one piece, not the whole thing — right-click was wiping twenty minutes of work.
   */
  private cancelOrStepBack(): void {
    if (this.menuBlocksWorld()) return;
    if (this.coasterDraft.length > 0 && this.currentCoasterType()) {
      this.coasterUndo();
      return;
    }
    this.cancelTool();
  }

  private readonly onWorldChanged = (): void => {
    this.scenery.syncWithWorld();
    this.rides.syncWithWorld(this.guests.guests);
    this.shops.syncWithWorld(this.guests.guests);
    this.operations.syncWithWorld();
    const selectedId = this.selectedRideId ?? this.selectedServiceId;
    if (selectedId !== null && !this.world.objects.has(selectedId)) this.closeInspector();
    if (this.armedCoasterId !== null && !this.world.objects.has(this.armedCoasterId)) this.armedCoasterId = null;
    this.renderer?.syncWorld();
    // A parked layout still has to tell the truth: building over its cells must light them red.
    if (this.coasterDraft.length > 0) this.refreshCoasterPreview();
    this.syncUi();
  };

  /**
   * Writes the Undo control's status to the store, and only when it changed (the ring hands out a
   * new object only then; the coaster designer's own status changes with its piece count). Inside the designer Ctrl+Z
   * steps back one piece of track, which is genuinely repeatable, so the label says so; out in the
   * world it takes back one gesture of the park.
   */
  private publishUndoStatus(): void {
    // The ring refreshes itself on every commit and clear, so "did refresh() change" would be
    // consumed by whoever asked first. Comparing the object that was last published cannot be.
    this.undo.refresh();
    const draftPieces = this.coasterDraft.length > 0 && this.currentCoasterType() !== undefined
      ? this.coasterDraft.length
      : 0;
    let status: UndoStatus;
    if (draftPieces > 0) {
      const toggle = planDraftUndo(this.coasterLiftHistory, draftPieces).kind === 'revert-toggle';
      if (this.coasterUndoCache?.pieces !== draftPieces || this.coasterUndoCache.toggle !== toggle) {
        this.coasterUndoCache = { pieces: draftPieces, toggle, status: this.coasterUndoStatus(draftPieces, toggle) };
      }
      status = this.coasterUndoCache.status;
    } else {
      status = this.undo.status();
    }
    if (status === this.publishedUndoStatus) return;
    this.publishedUndoStatus = status;
    updateUiSnapshot({ undoStatus: status });
  }

  /** Speeds and chain cost of the selected coaster. Cached per record, so the per-tick publish costs nothing. */
  private selectedCoasterLift(): CoasterLiftView | null {
    const record = this.selectedRideId === null ? undefined : this.world.coasters.get(this.selectedRideId);
    const object = this.selectedRideId === null ? undefined : this.world.objects.get(this.selectedRideId);
    const type = object ? COASTER_TYPE_BY_ID.get(object.definitionId) : undefined;
    if (!record || !type) {
      this.coasterLiftCache = null;
      return null;
    }
    // The chain's cost share uses the same multipliers the ledger charged with (build and per cycle).
    const rules = this.session.rules;
    if (this.coasterLiftCache?.record !== record || this.coasterLiftCache.rules !== rules) {
      this.coasterLiftCache = {
        record,
        rules,
        view: describeCoasterLift(record.pieces, record.stats.travelSeconds, type, {
          chainLiftCostMultiplier: rules.chainLiftCostMultiplier,
          constructionCostMultiplier: rules.constructionCostMultiplier,
          rideOperatingCostMultiplier: rules.rideOperatingCostMultiplier,
        }),
      };
    }
    return this.coasterLiftCache.view;
  }

  private coasterUndoStatus(pieces: number, toggle: boolean): UndoStatus {
    if (toggle) {
      return {
        canUndo: true,
        depth: pieces,
        maxDepth: pieces,
        label: 'Undo lift change',
        tooltip: 'Switches the last changed lift back between chain and free (Ctrl+Z)',
        target: `${pieces} piece${pieces === 1 ? '' : 's'} laid so far`,
        kind: null,
        rewindSeconds: 0,
        cashAfterUndo: null,
        needsConfirmation: false,
        armed: false,
        reason: null,
        message: '',
      };
    }
    return {
      canUndo: true,
      depth: pieces,
      maxDepth: pieces,
      label: 'Undo track piece',
      tooltip: `Takes back the last of ${pieces} track piece${pieces === 1 ? '' : 's'} (Ctrl+Z)`,
      target: `${pieces} piece${pieces === 1 ? '' : 's'} laid so far`,
      kind: null,
      rewindSeconds: 0,
      cashAfterUndo: null,
      needsConfirmation: false,
      armed: false,
      reason: null,
      message: '',
    };
  }

  private syncUi(): void {
    this.session.refreshManagement();
    // The First Day tracker only runs inside simulation steps; while paused nothing steps, so a build or a
    // price change made on pause would leave the card on a finished step until the player resumes.
    if (this.clock.speed === 0) this.session.evaluateOnboardingNow();
    const snapshot = this.world.snapshot();
    updateUiSnapshot({
      ...snapshot,
      ...this.calendarUi(),
      weatherUi: this.keyedWeatherUi(),
      guestCount: this.guests.guests.size,
      selectedRide: this.selectedRideId === null ? null : this.rides.snapshot(this.selectedRideId),
      selectedColours: this.selectedObjectId() === null ? null : this.world.objectColours(this.selectedObjectId()!),
      selectedCoasterLift: this.selectedCoasterLift(),
      selectedService: this.selectedServiceId === null ? null : this.shops.snapshot(this.selectedServiceId),
      selectedGuest: this.selectedGuestUi(),
      ...this.parkReadsUi(),
      pulseInsights: this.guests.thoughtInsights(),
      management: this.management.snapshot(),
      buildings: this.session.buildingsSnapshot(),
      progression: this.progression.snapshot(),
      onboarding: this.session.onboardingSnapshot(),
      gateFacing: this.world.entranceFacing,
      scenery: this.scenery.snapshot(),
      scenario: this.session.scenarioSnapshot(),
      activeCards: this.cardFaces(),
      sessionRules: this.session.rules,
      land: this.landUi(),
      parkTitle: this.parkTitle(this.session),
    });
    this.refreshHints();
    this.publishUndoStatus();
  }

  /**
   * Phase 21: the land the HUD shows (null on a wholly owned map). Keeps the published object while the owned land, the
   * world and the cash band that decides nothing here are unchanged, so a steady park re-renders nothing.
   */
  private landUi(): LandUi | null {
    const world = this.world;
    if (!world.land.restricted) return null;
    const previous = useUiStore.getState().land;
    if (this.landUiKey !== null && this.landUiKey.world === world && this.landUiKey.revision === world.landRevision && previous !== null) return previous;
    const forSale = world.land.forSale();
    const prices = forSale.map((parcel) => world.parcelPrice(parcel));
    this.landUiKey = { world, revision: world.landRevision };
    return {
      ownedParcels: world.land.ownedCount,
      totalParcels: world.land.parcelCount,
      forSaleParcels: forSale.length,
      cheapestPrice: prices.length === 0 ? null : Math.min(...prices),
    };
  }

  /**
   * Phase 11: the per-object and park-wide reads the UI shows beside the snapshots (never inside them: the snapshots are
   * hashed by the determinism observables). Each keeps the published value when nothing changed, so a steady park
   * re-renders nothing. All three are pure reads of derived caches.
   */
  private parkReadsUi(): Pick<UiState, 'guestCapacity' | 'noPathAccessIds' | 'selectedDemolitionRefund'> {
    const state = useUiStore.getState();
    const capacity = this.guests.capacityView();
    const selected = this.selectedObjectId();
    return {
      guestCapacity: sameCapacityView(state.guestCapacity, capacity) ? state.guestCapacity : capacity,
      noPathAccessIds: this.noPathAccessIds(state.noPathAccessIds),
      selectedDemolitionRefund: selected === null ? null : this.world.demolitionRefund(selected),
    };
  }

  /** The rides and stalls no path from the gate reaches, sorted; `previous` itself when the content is unchanged. */
  private noPathAccessIds(previous: readonly number[]): readonly number[] {
    const ids: number[] = [];
    for (const object of this.world.objects.values()) {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (!definition || (definition.kind !== 'ride' && !definition.stats?.serviceType)) continue;
      if (!this.management.hasPathAccess(object.id)) ids.push(object.id);
    }
    ids.sort((a, b) => a - b);
    return sameIds(previous, ids) ? previous : ids;
  }

  /** Phase 11 (PA-009): one step of the at-capacity tracker on the 4 Hz cadence; the toast fires once per stretch. */
  private stepCapacityNotice(): void {
    const ceiling = useUiStore.getState().guestCapacity?.ceiling ?? 0;
    const step = stepCapacityNotice(this.capacityNotice, { tick: this.world.tick, guestCount: this.guests.guests.size, ceiling });
    this.capacityNotice = step.state;
    if (step.atCapacity !== useUiStore.getState().atCapacity) updateUiSnapshot({ atCapacity: step.atCapacity });
    if (step.fire) this.toast(capacityToast(ceiling), 'important');
  }

  private selectObjectAt(cell: Cell): void {
    // Phase 38: a cell where track crosses holds more than one selectable object (the upper track first). A click
    // picks the top one; another click on the same cell steps to the next one below.
    const selectable = this.world.objectsAt(cell).filter((candidate) => {
      const candidateDefinition = BUILD_BY_ID.get(candidate.definitionId);
      return candidateDefinition !== undefined && (candidateDefinition.kind === 'ride' || candidateDefinition.stats?.serviceType !== undefined);
    });
    const current = selectable.findIndex((candidate) => candidate.id === (this.selectedRideId ?? this.selectedServiceId));
    const object = selectable.length > 1 && current >= 0
      ? selectable[(current + 1) % selectable.length]
      : selectable[0] ?? this.world.objectAt(cell);
    const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
    if (!object || !definition || (definition.kind !== 'ride' && !definition.stats?.serviceType)) {
      // Phase 30: no ride or stall here (a path, a bench, grass): a guest sitting on this bench (drawn on it, though
      // their position is the path beside it), else the nearest drawn guest figure, if one is close. Phase 36: a figure
      // rises up the screen from its feet, so a click on its body lands on the ground behind it (`pickGuest`).
      const guestId = (object ? this.guests.restingGuestOn(object.id) : null)
        ?? pickGuest(this.guests.guests.values(), cell, useUiStore.getState().viewRotation);
      if (guestId !== null) {
        this.selectGuest(guestId);
        return;
      }
      this.closeInspector();
      return;
    }
    this.closeDemolishConfirmUnless(object.id);
    this.selectedGuestId = null;
    if (definition.kind === 'ride') {
      this.selectedRideId = object.id;
      this.selectedServiceId = null;
    } else {
      this.selectedServiceId = object.id;
      this.selectedRideId = null;
    }
    this.renderer?.selectObject(object);
    this.syncUi();
  }

  /**
   * `cls` defaults to 'alert' on purpose: an unclassified message is never hidden by the
   * notification-intensity setting, so a refusal or error cannot be lost by forgetting a tag.
   * Only confirmations ('routine') and progress events ('important') name themselves.
   */
  private toast(message: string, cls: NotificationClass = 'alert'): void {
    if (!shouldShowNotification(cls, getSettings().notifications)) return;
    window.clearTimeout(this.toastTimer);
    useUiStore.getState().setToast(message, cls);
    this.toastTimer = window.setTimeout(() => useUiStore.getState().setToast(null), 2200);
  }

  private handleProgressionEvents(events: readonly ProgressionEvent[]): void {
    if (events.length === 0) return;
    this.management.ingestProgressionEvents(events);
    const latest = events[events.length - 1];
    if (latest.kind === 'researchCompleted') {
      const names = latest.unlockedDefinitionIds
        .map((definitionId) => BUILD_BY_ID.get(definitionId)?.name ?? definitionId)
        .join(', ');
      this.toast(`Research complete · ${names}`, 'important');
    } else {
      this.toast(`Milestone reached · Finding: +${latest.rewardResearchPoints} RP`, 'important');
    }
    this.audio.play('research');
  }

  private handleScenarioEvents(events: readonly ScenarioEvent[]): void {
    if (events.length === 0) return;
    const latest = events[events.length - 1];
    // Phase 15: the result moment (a run stage too).
    this.audio.play(latest.kind === 'scenarioSucceeded' ? 'fanfare' : 'fail');
    this.setSpeed(0);
    // A latched result closes the ring for good: rewinding past a win would un-award a Pulse Card
    // reward the profile already stored, so the same win could be farmed.
    this.undo.clear('scenario-ended');
    // The Map: the result belongs to the run (a stage never records a scenario result and drafts no card).
    if (this.session.mode === 'run') {
      this.settleRunStage(latest);
      return;
    }
    const session = this.session;
    const rewards = this.recordResult(latest);
    updateUiSnapshot({ scenarioRewards: rewards });
    if (latest.kind === 'scenarioSucceeded') {
      const definition = session.scenarioDefinition;
      // The draft is the one overlay Escape deliberately does not close, so it must never be
      // offered unless it can render at least one card the player can actually pick. An empty or
      // unresolvable draft falls through to the ordinary result actions instead of trapping them.
      const choices = (definition
        ? draftRewardChoices(this.profile.snapshot().collectionCardIds, definition.seed, definition.rewards.cardDraftChoices)
        : []
      ).filter((cardId) => CARD_BY_ID.has(cardId));
      updateUiSnapshot({ rewardDraft: choices.length > 0 ? choices : null });
      this.toast('Objective complete!', 'important');
    } else {
      // A failed park grants nothing; the result overlay routes back to loadout selection.
      this.toast('Objective failed', 'important');
    }
    this.syncUi();
    // Only arms the save: this runs inside a simulation step, and the ticker performs it right after.
    this.saves.notifyScenarioResult();
  }

  /**
   * Records a result in the profile (Phase 22). A park whose rules do not match one started in this game (a hand-edited
   * save) still shows its result but grants nothing. Sandbox parks have no result.
   */
  private recordResult(event: ScenarioEvent): ScenarioRewardResult | null {
    const session = this.session;
    if (session.mode === 'sandbox' || session.mode === 'run' || session.scenarioDefinition === null) return null;
    const snapshot = session.scenarioSnapshot();
    return this.profile.recordScenarioResult({
      scenarioId: session.scenarioDefinition.id as ScenarioId,
      mode: session.mode,
      outcome: event.kind === 'scenarioSucceeded' ? 'succeeded' : 'failed',
      atSeconds: event.atSeconds,
      progressPercent: snapshot?.objective.progressPercent ?? 0,
    }, rewardEligible(session));
  }

  // --- Phase 23: The Map (runs) ---------------------------------------------------------------------------------

  /**
   * The park on screen is a frozen backdrop: between two stages (phases offer, loadout, won, lost) the run owns the screen.
   * It never runs, takes no world input and no undo, and is never "running" for the save layer. Derived from the run, never
   * stored, so it cannot disagree with it.
   */
  private runHold(): boolean {
    const run = this.session.run;
    return run !== null && run.phase !== 'stage';
  }

  /** The run of a park as the screens read it: the snapshot, and the permanent bonuses its grant snapshot holds. */
  private runUiOf(session: ParkSession): Pick<UiState, 'run' | 'runBonusIds'> {
    const run = session.run;
    return { run: run === null ? null : runSnapshotOf(run), runBonusIds: run === null ? [] : [...run.grant.bonusIds] };
  }

  /** Publishes the run of the park on screen (the snapshot the screens read) and, optionally, a view and the rewards. */
  private publishRun(patch: { runView?: RunView | null; runRewards?: RunRewardResult | null; runLoadoutSelection?: PulseCardId[] } = {}): void {
    updateUiSnapshot({ ...this.runUiOf(this.session), ...patch });
  }

  /** A run boundary: unsaved for the quit check, and an autosave at the next frame (the minimum gap still applies). */
  private runChanged(): void {
    this.settingsRevision += 1;
    this.saves.notifyScenarioResult();
  }

  /**
   * "Leave the run?" Raised before a new park, scenario, run or load replaces a run that only the autosave holds. Returns
   * true when the prompt was raised and the caller must stop; "Leave the run" runs `go`. In a live park the run at stake is
   * the session's own. On the start screen no run is live, but every new park still takes the one autosave slot: the run
   * at stake is the unfinished run that slot holds (`autosavedRunAtStake`; loading that run's own saves asks nothing).
   * A load raised from the Save / Load dialog closes the dialog first, so the question is on top and answerable.
   */
  private raiseLeaveRun(reason: LeaveRunPrompt['reason'], go: () => void, loadSlotId?: string): boolean {
    if (this.destroyed) return false;
    let prompt: LeaveRunPrompt;
    if (this.menuHold) {
      const atStake = autosavedRunAtStake(this.saves.snapshot().slots, loadSlotId);
      if (atStake?.run === undefined) return false;
      prompt = { reason, saved: atStake.run };
    } else {
      const run = this.session.run;
      if (run === null || run.phase === 'won' || run.phase === 'lost' || !this.parkChosen) return false;
      prompt = { reason };
    }
    if (useUiStore.getState().savesDialogOpen) useUiStore.getState().closeSavesDialog();
    this.pendingLeave = { go };
    updateUiSnapshot({ leaveRunPrompt: prompt });
    return true;
  }

  /**
   * The answer to "Leave the run?". Save first opens Save / Load over the prompt and keeps it up (the player answers again
   * once the slot is written); Leave goes on with what was asked; Cancel drops it.
   */
  resolveLeaveRun(choice: 'save-first' | 'leave' | 'cancel'): void {
    const pending = this.pendingLeave;
    if (pending === null) {
      updateUiSnapshot({ leaveRunPrompt: null });
      return;
    }
    if (choice === 'save-first') {
      useUiStore.getState().openSavesDialog();
      void this.saves.refresh();
      return;
    }
    this.pendingLeave = null;
    updateUiSnapshot({ leaveRunPrompt: null });
    if (choice === 'leave') pending.go();
  }

  /** New run: validates, builds the plan and the first level, opens the run map over a frozen first park. */
  startRun(seed: number, difficulty: RunDifficulty, confirmedLeaveRun = false): void {
    if (this.destroyed || !this.renderer || this.swapping || !this.menuMayStartPark()) return;
    if (!isMapSeed(seed) || !isRunDifficulty(difficulty)) {
      this.toast('Use a whole number from 0 to 4,294,967,295 as the seed');
      return;
    }
    const availability = this.profile.runDifficultyAvailability(difficulty);
    if (!availability.available) {
      this.toast(availability.conditionText ?? 'That difficulty is locked');
      return;
    }
    if (!confirmedLeaveRun && this.raiseLeaveRun('new-run', () => this.startRun(seed, difficulty, true))) return;
    let session: ParkSession;
    try {
      // The profile's gift is snapshotted into the run once: no later profile change can alter a run in progress.
      const run = createRun({ seed, difficulty, grant: this.profile.parkGrant('run') });
      const built = buildStage(run, 0);
      session = new ParkSession(built.definition, [], { mode: 'run', grant: run.grant, layout: built.layout, run });
    } catch {
      this.toast('That run could not be made');
      return;
    }
    const wasSweeping = this.sweepActive;
    this.swapSession(session, 'new-park', () => {
      this.clock.restore({ speed: 0, simulationTimeMs: 0 });
      this.clock.resetAccumulator();
      const ui = useUiStore.getState();
      ui.closeScenarioPicker();
      ui.closeLoadout();
      ui.resetScenarioResult();
      updateUiSnapshot({ speed: 0, rewardDraft: null });
      this.syncUi();
      this.leaveMenuForPlay();
      this.setParkViewRotation(0);
    });
    if (wasSweeping) this.renderer?.focusEntrance();
    this.parkChosen = true;
    this.profile.recordRunStarted(difficulty);
    this.saves.notifyParkStarted();
    this.runChanged();
    this.recoveryController.parkStarted(this.parkInfoOf(this.session));
    this.publishRun({ runView: 'map' });
    this.toast(`New run · seed ${seed} · ${RUN_DIFFICULTY_LABELS[difficulty]}`, 'routine');
  }

  /** Continue run: the newest readable run save that is not finished, loaded like any park (paused). */
  async continueRun(): Promise<void> {
    if (!this.menuMayStartPark() || this.saves.snapshot().busy.loading !== null) return;
    const meta = latestRunSlot(this.saves.snapshot().slots);
    if (meta === null) {
      updateUiSnapshot({ menuNotice: 'There is no run in progress to continue.' });
      return;
    }
    updateUiSnapshot({ menuNotice: null });
    const result = await this.loadGame(meta.id);
    if (!result.ok && result.error.code !== 'deferred') updateUiSnapshot({ menuNotice: result.error.message });
  }

  openRunMap(): void {
    const run = this.session.run;
    if (run === null || this.destroyed || this.swapping) return;
    if (useUiStore.getState().menuKind === 'pause') this.closePauseMenuKeepingPause();
    // Inside a stage the park waits behind the map; the player presses play when they are back.
    if (run.phase === 'stage') this.setSpeed(0);
    this.publishRun({ runView: 'map' });
  }

  /**
   * Closes the run overlay. In a stage that is "back to the park" (paused). Between stages the run map is the hub: closing it
   * opens the pause menu over the frozen backdrop, where Save, Load and Settings stay reachable.
   */
  closeRunMap(): void {
    const run = this.session.run;
    if (run === null) return;
    updateUiSnapshot({ runView: null, runDrawer: null });
    if (run.phase !== 'stage') this.openPauseMenu();
  }

  private refusalText(reason: RunRefusalReason): string {
    switch (reason) {
      case 'wrong-phase': return 'That is not possible at this point of the run';
      case 'not-in-deck': return 'That card is not in your deck';
      case 'duplicate': return 'Each card can be chosen once';
      case 'too-many': return 'That is more cards than this level has slots';
      case 'bad-pick': return 'That is not a valid pick from the offer';
      case 'unknown-card': return 'That card does not exist';
    }
  }

  /** Before a level: the offered cards join the deck (all of them, or the picked ones under the `pick` rule). */
  acceptRunOffer(picked?: readonly string[]): void {
    const run = this.session.run;
    if (run === null || run.phase !== 'offer' || this.swapping) return;
    const step = acceptOffer(run, picked as readonly PulseCardId[] | undefined);
    if (!step.ok) {
      this.toast(this.refusalText(step.reason));
      return;
    }
    this.session.advanceRun(step.run);
    this.runChanged();
    this.publishRun({ runView: 'loadout', runLoadoutSelection: [] });
    const added = step.run.deck.length - run.deck.length;
    this.toast(`${added} card${added === 1 ? '' : 's'} added to your deck`, 'routine');
  }

  /** The loadout is locked: the cards leave the deck, the level's park is built from its recipe and a new session starts. */
  startRunStage(cardIds: readonly string[]): void {
    const run = this.session.run;
    if (run === null || run.phase !== 'loadout' || this.swapping) return;
    const ids = [...cardIds] as PulseCardId[];
    const started = startStage(run, ids);
    if (!started.ok) {
      this.toast(this.refusalText(started.reason));
      return;
    }
    let next: ParkSession;
    try {
      const built = buildStage(started.run, started.run.levelIndex);
      next = new ParkSession(built.definition, ids, { mode: 'run', grant: started.run.grant, layout: built.layout, run: started.run });
    } catch (error) {
      // A run made by another generator version cannot rebuild its map: it ends as abandoned, and no loss is counted.
      if (error instanceof SaveError && error.code === 'content-mismatch') {
        this.endRunUnplayable(run, error.message);
        return;
      }
      this.toast('That level could not be made');
      return;
    }
    this.swapSession(next, 'new-park', () => {
      this.clock.restore({ speed: 1, simulationTimeMs: 0 });
      this.clock.resetAccumulator();
      const ui = useUiStore.getState();
      ui.closeScenarioPicker();
      ui.closeLoadout();
      ui.resetScenarioResult();
      updateUiSnapshot({ speed: 1, rewardDraft: null });
      this.syncUi();
      this.setParkViewRotation(0);
    });
    this.renderer?.focusEntrance();
    this.parkChosen = true;
    this.profile.recordParkStarted('run');
    this.saves.notifyParkStarted();
    this.runChanged();
    this.recoveryController.parkStarted(this.parkInfoOf(this.session));
    this.publishRun({ runView: null });
    this.toast(`${next.scenarioDefinition?.name ?? 'Level'} started`, 'routine');
  }

  /**
   * What a stage's park played (design 3.5): the one-shots in loadout order and the deferred costs still unpaid. A
   * settlement must carry exactly these (`ParkSession.advanceRun` refuses anything else), so every stage result, an
   * abandon inside a stage and a settle on load read them here.
   */
  private stageLedgerOf(session: ParkSession, run: RunState): { playedCardIds: PulseCardId[]; unpaidDebt: number } {
    const plays = session.plays;
    return plays === null ? { playedCardIds: [], unpaidDebt: 0 } : { playedCardIds: plays.playedIds(run.loadout), unpaidDebt: plays.unpaidTotal() };
  }

  /**
   * Plays a one-shot card of the running stage (Phase 25, design 3.3), from the Park Pulse card list. One undo step
   * (the pre-play park is captured first, so Undo brings the card back ready), no confirmation, works while paused.
   * Refused between stages, in a swap, and whatever the session refuses (played already, not playable now: the hint).
   */
  playCard(cardId: string): void {
    const run = this.session.run;
    if (this.destroyed || this.swapping || run === null) return;
    if (this.runHold()) {
      this.toast('One-shot cards are played during a level');
      return;
    }
    const card = CARD_BY_ID.get(cardId as PulseCardId);
    this.undo.begin('card');
    const step = this.session.playCard(cardId);
    if (!step.ok) {
      this.undo.abandon();
      this.toast(playRefusalText(step.reason, step.hint, card?.name ?? null));
      return;
    }
    const name = card?.name ?? cardId;
    this.noteCardPlay();
    this.commitGesture(cardPlayedLabel(name));
    this.syncUi();
    this.toast(`Played ${name} · ${step.summary}`, 'important');
  }

  /** A stage result (success or failure) reached the run: the run moves on, the ring is already clear, the park is frozen. */
  private settleRunStage(event: ScenarioEvent): void {
    const session = this.session;
    const run = session.run;
    if (run === null || run.phase !== 'stage') return;
    const step = resolveStage(run, {
      outcome: event.kind === 'scenarioSucceeded' ? 'succeeded' : 'failed',
      atSeconds: event.atSeconds,
      evidence: event.evidence,
      ...this.stageLedgerOf(session, run),
    });
    if (!step.ok) return;
    session.advanceRun(step.run);
    this.afterRunAdvance(step.run);
    const level = step.run.history[step.run.history.length - 1].levelIndex + 1;
    this.toast(event.kind === 'scenarioSucceeded' ? `Level ${level} cleared` : `Level ${level} failed`, 'important');
  }

  /** Common tail of a stage result and an abandon: save, record the end of the run in the profile, show the right screen. */
  private afterRunAdvance(run: RunState): void {
    this.setSpeed(0);
    this.undo.clear('scenario-ended');
    this.runChanged();
    const outcome = runOutcomeOf(run);
    const rewards = outcome === null ? null : this.recordRunEnd(run, outcome);
    this.syncUi();
    this.publishRun({
      runView: outcome === null ? 'stage-result' : 'end',
      runRewards: rewards !== null && !rewards.alreadyRecorded ? rewards : null,
      runLoadoutSelection: [],
    });
  }

  /**
   * The end of a run goes to the profile once. The key is this attempt's final state (seed, difficulty and the run's own hash):
   * a reload of the same finished run is the same key (nothing is counted twice), while "Try this seed again" is a new
   * attempt that can improve the best level. Only a run whose plan this build can reproduce earns anything.
   */
  private recordRunEnd(run: RunState, outcome: RunOutcome): RunRewardResult {
    const eligible = runRewardEligible(run) && rewardEligible(this.session);
    return this.profile.recordRunResult({
      runKey: `${run.seed}-${run.difficulty}-${runHash(run)}`,
      difficulty: run.difficulty,
      outcome: outcome.outcome,
      levelsCleared: outcome.levelsCleared,
      deckCardIds: outcome.deckCardIds,
    }, eligible);
  }

  /** The run cannot go on (another generator version): it ends as abandoned and counts neither a win nor a loss. */
  private endRunUnplayable(run: RunState, message: string): void {
    const step = abandonRunState(run, 0);
    if (!step.ok) return;
    this.session.advanceRun(step.run);
    this.setSpeed(0);
    this.undo.clear('scenario-ended');
    this.runChanged();
    this.syncUi();
    this.publishRun({ runView: 'end', runRewards: null });
    this.toast(message);
  }

  /** The player gives up. Inside a stage it records the park time; anywhere else the level reached. Counts as a loss. */
  abandonRun(): void {
    const run = this.session.run;
    if (run === null || run.phase === 'won' || run.phase === 'lost' || this.swapping) return;
    // Inside a stage the park's one-shot ledger goes with the result; between stages nothing was played ([] and 0).
    const ledger = run.phase === 'stage' ? this.stageLedgerOf(this.session, run) : { playedCardIds: [], unpaidDebt: 0 };
    const step = abandonRunState(run, run.phase === 'stage' ? this.clock.simulationTimeMs / 1000 : 0, ledger.playedCardIds, ledger.unpaidDebt);
    if (!step.ok) return;
    this.session.advanceRun(step.run);
    this.afterRunAdvance(step.run);
    this.toast('The run was abandoned', 'important');
  }

  /** The stage result's Continue: back to the run map (the next offer is one click away). */
  continueAfterStage(): void {
    const run = this.session.run;
    if (run === null || run.phase === 'won' || run.phase === 'lost') return;
    if (useUiStore.getState().runView !== 'stage-result') return;
    updateUiSnapshot({ runView: 'map' });
  }

  /**
   * The run's way to the main menu. Between stages nothing is being edited, so the boundary the player just reached is written
   * to the autosave and the park is left at once; inside a stage the pause menu's quit flow asks about unsaved edits.
   */
  private runMainMenu(): void {
    const run = this.session.run;
    if (run === null) return;
    updateUiSnapshot({ runView: null, runDrawer: null });
    if (run.phase === 'stage') {
      this.openPauseMenu();
      this.requestQuitToMenu();
      return;
    }
    void this.saves.autosaveNow().then(() => {
      if (!this.destroyed) void this.quitToMenu();
    });
  }

  runEndAction(action: 'same-seed' | 'new-run' | 'main-menu'): void {
    const run = this.session.run;
    if (run === null) return;
    // The main menu is reachable from every screen of the run; the other two only mean something once the run is over.
    if (action !== 'main-menu' && run.phase !== 'won' && run.phase !== 'lost') return;
    if (action === 'same-seed') {
      this.startRun(run.seed, run.difficulty);
      return;
    }
    if (action === 'new-run') this.quitPanel = 'the-map';
    this.runMainMenu();
  }

  /**
   * Reconciles a run park that was just loaded (or adopted from the start screen's preview) and opens the screen it belongs on.
   * A stage whose scenario already ended while the run never heard of it (this cannot be saved by the app, but a hand-edited
   * or interrupted file can say it) is settled now. Returns whether the run changed, so the caller arms an autosave.
   */
  private adoptRunPark(): boolean {
    const session = this.session;
    let run = session.run;
    if (run === null) return false;
    let changed = false;
    if (run.phase === 'stage') {
      const snapshot = session.scenarioSnapshot();
      if (snapshot !== null && snapshot.status !== 'running') {
        const step = resolveStage(run, {
          outcome: snapshot.status === 'succeeded' ? 'succeeded' : 'failed',
          atSeconds: snapshot.completedAtSeconds ?? snapshot.elapsedSeconds,
          evidence: snapshot.resultEvidence,
          ...this.stageLedgerOf(session, run),
        });
        if (step.ok) {
          session.advanceRun(step.run);
          run = step.run;
          changed = true;
        }
      }
    }
    const outcome = runOutcomeOf(run);
    // A finished run that was already recorded (the normal case) shows no reward lines again.
    const rewards = outcome === null ? null : this.recordRunEnd(run, outcome);
    this.publishRun({
      runView: outcome !== null ? 'end' : changed ? 'stage-result' : run.phase === 'stage' ? null : 'map',
      runRewards: rewards !== null && !rewards.alreadyRecorded ? rewards : null,
      runLoadoutSelection: [],
    });
    return changed;
  }


  /** The layer that currently owns the keyboard. Derived, never stored. */
  private inputContext(target: EventTarget | null = null): InputContext {
    return activeInputContext(useUiStore.getState(), isTextInputTarget(target));
  }

  /**
   * Escape closes exactly one layer, so a player never loses more than they asked to. The reward
   * draft is the one layer that does not pop: a card has to be chosen or the reward is gone.
   */
  private popInputContext(context: InputContext): void {
    const ui = useUiStore.getState();
    switch (context) {
      case 'runMap':
      case 'leaveRun':
        escapeRunLayer(context);
        return;
      case 'textInput':
        return;
      case 'world': {
        // Phase 42: an open window closes first (the newest), then Escape opens the pause menu.
        const top = ui.openWindows.at(-1);
        if (top !== undefined) {
          ui.closeWindow(top);
          return;
        }
        this.openPauseMenu();
        return;
      }
      case 'menu': {
        const step = menuEscapeStep(ui.menuKind ?? 'start', ui.menuPanel);
        if (step === 'back') {
          // The same target as the panel's Back button: the pause menu's Scenario browser returns to the Parks chooser.
          updateUiSnapshot({ menuPanel: menuBackTarget(ui.menuKind ?? 'start', ui.menuPanel), menuNotice: null });
        } else if (step === 'resume') {
          this.resumeFromMenu();
        }
        return;
      }
      case 'rewardDraft':
        this.toast('Draft a card to continue');
        return;
      case 'scenarioResult':
        ui.dismissScenarioResult();
        return;
      case 'recovery':
        // Esc never decides about a save: the prompt only closes through its two buttons.
        return;
      case 'saveLoad':
        ui.closeSavesDialog();
        return;
      case 'settings':
        ui.closeSettings();
        return;
      case 'loadout':
        ui.closeLoadout();
        return;
      case 'clockPopover':
        ui.setClockPopoverOpen(false);
        return;
      case 'management':
        ui.closeManagement();
        return;
      case 'inspector':
        // Phase 11: an open demolish confirmation is its own step; the panel returns focus to Demolish.
        if (ui.demolishConfirmId !== null) {
          ui.closeDemolishConfirm();
          return;
        }
        this.closeInspector();
        return;
      case 'coasterDesigner':
        this.cancelOrStepBack();
        return;
      case 'build':
        this.cancelTool();
        return;
    }
  }

  /** Camera keys follow the same rule as every other shortcut: only the top context gets them. */
  private lastOpenWindows: readonly string[] | null = null;
  private lastDockOpen: boolean | null = null;

  private readonly syncInputContext = (): void => {
    const enabled = INPUT_CONTEXT_CAPABILITIES[this.inputContext()].view;
    if (enabled !== this.viewInputEnabled) {
      this.viewInputEnabled = enabled;
      this.renderer?.setViewInputEnabled(enabled);
    }
    this.applyHints();
    this.syncSeeThrough();
    this.syncPaintState();
    const state = useUiStore.getState();
    // Phase 42: an open window covers the strip beside the rail, so the camera clamp follows it.
    if (state.openWindows !== this.lastOpenWindows || state.dockOpen !== this.lastDockOpen) {
      this.lastOpenWindows = state.openWindows;
      this.lastDockOpen = state.dockOpen;
      this.pushViewInsets();
    }
    // Phase 11: putting the bulldozer down (any tool change) disarms an armed coaster.
    if (state.tool !== 'bulldoze') this.armedCoasterId = null;
    const cursor = state.tool === 'pointer'
      ? 'default'
      : state.tool === 'bulldoze' ? 'not-allowed' : state.tool === 'paint' && state.paintPicking ? 'copy' : 'crosshair';
    if (cursor !== this.toolCursor) {
      this.toolCursor = cursor;
      this.renderer?.setToolCursor(cursor);
    }
    // Re-arming a coaster type brings its panel and its layout straight back, without waiting for
    // the cursor to touch the plot; arming anything else parks the layout instead of losing it.
    const armed = state.tool === 'build' ? state.selectedDefinitionId : null;
    if (armed === this.armedDefinitionId) return;
    this.armedDefinitionId = armed;
    if (armed !== null && COASTER_TYPE_BY_ID.has(armed)) {
      this.coasterTypeId = armed;
      this.refreshCoasterPreview();
      return;
    }
    if (this.coasterDraft.length > 0) this.refreshCoasterPreview();
  };

  private quickSave(): void {
    // Results are not toasted: the manager's notice (the save strip) already says "Saved to ...",
    // "... for this session only" or why it failed, and a toast on top duplicated every message
    // and showed a green check while storage was down.
    void this.saves.quickSave().then((result) => {
      if (result.ok) return;
      // Every slot taken and none chosen: let the player pick which to replace.
      if (result.error.code === 'invalid-slot') {
        useUiStore.getState().openSavesDialog();
        void this.saves.refresh();
      }
    });
  }

  /** Closing the tab with edits no save holds asks first; the page may also get one last autosave. */
  private readonly handleBeforeUnload = (event: BeforeUnloadEvent): void => {
    this.saves.flushOnHide();
    if (DEVELOPER_MODE || !this.saves.hasUnsavedEdits()) return;
    event.preventDefault();
    event.returnValue = '';
  };

  private readonly handleVisibilityChange = (): void => {
    // Phase 15: a hidden page is silent.
    this.audio.setSuspended(document.visibilityState === 'hidden');
    if (document.visibilityState === 'hidden') {
      this.releasePeek();
      this.saves.flushOnHide();
    }
  };

  /**
   * Voxel leftovers: the voxel renderer drops effects a GPU refuses (`window.__voxelDegraded`, e.g. "no-lights") and
   * used to do it silently. Each new degradation is said once, with where to look.
   */
  private noticeDegradation(): void {
    const label = typeof window === 'undefined' ? undefined : (window as unknown as { __voxelDegraded?: string }).__voxelDegraded;
    if (label === undefined || label === '' || label === this.degradationSeen) return;
    this.degradationSeen = label;
    this.toast(degradationNotice(label), 'important');
  }

  /** Phase 15: the first pointer or key press anywhere creates the audio (once; later presses cost nothing). */
  private readonly unlockAudio = (): void => {
    this.audio.unlock();
    if (!this.audio.ready) return;
    window.removeEventListener('pointerdown', this.unlockAudio, true);
    window.removeEventListener('keydown', this.unlockAudio, true);
    this.refreshAmbience();
  };

  /** Phase 15: the camera's view (or the whole map) and the ambience beds for it, at the 4 Hz cadence. */
  private refreshAmbience(): void {
    if (this.renderer?.readViewInfo) this.renderer.readViewInfo(this.viewInfo);
    else wholeMapView(this.session, this.viewInfo);
    if (!this.audio.ready) return;
    const level = ambienceFor(this.viewInfo, this.session, this.clock.speed === 0);
    this.audio.setAmbience(level.crowd, level.machinery);
  }

  /**
   * Hold-to-peek (X). Pressing needs the build capability of the layer that owns the keyboard;
   * ANY keyup of X, a window blur, a hidden page, or the context losing the capability releases it,
   * so the cutaway can never stick on.
   */
  private readonly handlePeekKey = (event: KeyboardEvent): void => {
    const plan = planPeekKey(event, this.inputContext(event.target));
    if (plan === 'press') this.seeThroughRequest.peek = true;
    else if (plan === 'release') this.seeThroughRequest.peek = false;
    else return;
    this.pushSeeThrough();
  };

  private readonly releasePeek = (): void => {
    if (!this.seeThroughRequest.peek) return;
    this.seeThroughRequest.peek = false;
    this.pushSeeThrough();
  };

  /** Recomputes `armed` and `peek` from the store and the layer, and tells the renderer only on change. */
  private syncSeeThrough(): void {
    const buildable = INPUT_CONTEXT_CAPABILITIES[this.inputContext()].build;
    const request = this.seeThroughRequest;
    if (!buildable) request.peek = false;
    request.armed = buildable && useUiStore.getState().tool !== 'pointer';
    this.pushSeeThrough();
  }

  private lastSeeThroughArmed = false;
  private lastSeeThroughPeek = false;

  private pushSeeThrough(): void {
    const request = this.seeThroughRequest;
    if (request.armed === this.lastSeeThroughArmed && request.peek === this.lastSeeThroughPeek) return;
    this.lastSeeThroughArmed = request.armed;
    this.lastSeeThroughPeek = request.peek;
    this.renderer?.setSeeThrough?.(request);
  }

  /**
   * pagehide fires for a reload, a close and for a page entering the back/forward cache, and all
   * three are clean: the marker goes first (flushOnHide may take a moment), so no instant has a
   * marker without a live tab behind it. A page restored from the cache registers again.
   */
  private readonly handlePageHide = (): void => {
    this.recoveryController.markClean();
    this.saves.flushOnHide();
  };

  private readonly handlePageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) this.recoveryController.pageRestored();
  };

  private readonly handleShortcuts = (event: KeyboardEvent): void => {
    const context = this.inputContext(event.target);
    // The one modifier combination the game claims, because every builder reaches for it. Text
    // fields and modals keep the browser's own undo: they do not own the build keyboard.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      if (!INPUT_CONTEXT_CAPABILITIES[context].build) return;
      event.preventDefault();
      // Ctrl/Cmd+Shift+Z is redo everywhere else and the game has none: it must never rewind the
      // park a second time. Swallowed so the browser does not act on it either.
      if (event.shiftKey) return;
      // Holding the key must never run through the ring: only the first press counts.
      if (!event.repeat) this.requestUndo();
      return;
    }
    // Quick save. The browser's Save Page dialog must never open over the game, in text fields and
    // behind modals too, so the default is always prevented; what happens next depends on the layer.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (context === 'menu') {
        // The pause menu saves like its Save entry; the start screen has no park to save.
        if (useUiStore.getState().menuKind === 'pause' && !event.repeat) this.menuQuickSave();
        return;
      }
      const plan = planQuickSaveShortcut(event, context, this.saves.snapshot().quickSaveSlotId);
      if (plan === 'quick-save') this.quickSave();
      else if (plan === 'open-dialog') {
        useUiStore.getState().openSavesDialog();
        void this.saves.refresh();
        this.toast('All slots are full: choose one to replace');
      } else if (plan === 'suppress' && !event.repeat && context !== 'saveLoad') {
        this.toast('Close this screen to quick-save. Your progress is autosaved.');
      }
      return;
    }
    // Other browser and OS combinations are never game shortcuts.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') {
      // Holding Escape must not open the pause menu and close it again on the key repeat.
      if (event.repeat && (context === 'world' || context === 'menu')) return;
      this.popInputContext(context);
      return;
    }
    // Phase 11 (PA-015): Delete, and Backspace for keyboards without one, ask to demolish the inspected ride or stall.
    // Fixed keys (the registry reserves both for widgets); only the inspector layer owns them, so a text field keeps
    // its own Delete. The confirmation takes the focus to Keep it, so a second press cannot demolish.
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (context !== 'inspector' || event.repeat) return;
      const selected = this.selectedObjectId();
      if (selected === null) return;
      event.preventDefault();
      useUiStore.getState().openDemolishConfirm(selected);
      return;
    }
    // Everything below is a rebindable shortcut: the registry decides which action a key means.
    const action = resolveKeyAction(event, (scope) => scopeActiveIn(scope, context), getSettings().keybindings);
    switch (action) {
      case 'toggleGrid': {
        const next = !useUiStore.getState().showGrid;
        useUiStore.getState().setGrid(next);
        this.setGridVisible(next);
        return;
      }
      case 'toggleCleanView':
        useUiStore.getState().toggleCleanView();
        return;
      case 'speedPause': this.setSpeed(0); return;
      case 'speed1': this.setSpeed(1); return;
      case 'speed2': this.setSpeed(2); return;
      case 'speed4': this.setSpeed(4); return;
      // The designer owns its own keys, so raise/lower cannot collide with rotate and a stray
      // bulldozer or path key cannot swap the tool out from under a half-drawn layout.
      case 'coasterRaise': this.coasterAdjustHeight(1); return;
      case 'coasterLower': this.coasterAdjustHeight(-1); return;
      case 'coasterToggleLift': this.coasterToggleLift(); return;
      case 'bulldozer': useUiStore.getState().selectBulldozer(); return;
      // Phase 21: only an estate has land to buy; elsewhere the key says so instead of arming a tool with nothing to do.
      case 'landTool':
        if (this.world.land.restricted) useUiStore.getState().selectLandTool();
        else this.toast('This park owns all of its land: there is nothing to buy');
        return;
      case 'pathTool':
        useUiStore.getState().selectBuild('sunstone-path');
        useUiStore.getState().setCategory('paths');
        return;
      case 'paintTool': useUiStore.getState().selectPaint(false); return;
      case 'staffWindow': useUiStore.getState().toggleWindow('staff'); return;
      case 'toggleBuildMenu': useUiStore.getState().toggleDock(); return;
      case 'togglePulse': useUiStore.getState().togglePulse(); return;
      case 'openFinances':
      case 'openResearch': {
        const ui = useUiStore.getState();
        const tab = action === 'openFinances' ? 'finances' : 'research';
        if (ui.managementOpen && ui.managementTab === tab) ui.closeManagement();
        else if (tab === 'research') ui.openResearch();
        else ui.openManagement('finances');
        return;
      }
      case 'buildingsWindow': useUiStore.getState().toggleWindow('buildings'); return;
      case 'eyedropper': useUiStore.getState().selectPaint(true); return;
      case 'rotate': this.rotateBuild(); return;
      // Holding the key must not spin the map; each press is one quarter turn.
      case 'rotateViewLeft': if (!event.repeat) this.rotateView(-1); return;
      case 'rotateViewRight': if (!event.repeat) this.rotateView(1); return;
      // Phase 11 (PA-021): back to the park entrance, eased like the brand button and the ⌂ control.
      case 'recentreView': if (!event.repeat) this.focusEntrance('ease'); return;
      // Phase 35: the rail's crowd heatmap toggle (the classic renderer's toast says why it stays off).
      case 'toggleCrowdHeatmap':
        if (!event.repeat) this.setCrowdHeatmapVisible(!(this.crowdHeatmapSupported() && useUiStore.getState().showCrowdHeatmap));
        return;
      case 'toggleMute': if (!event.repeat) this.toggleMute(); return;
      // Camera keys are read by the world input every frame; the peek key has its own listener.
      default:
    }
  };
}
