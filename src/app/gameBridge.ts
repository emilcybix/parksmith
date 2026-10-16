import type { ColourPresetId } from '../game/content/colourPresets';
import type { MapId, MapRecipe } from '../game/maps/types';
import type { GameMode } from '../game/modes/types';
import type { ScenarioId } from '../game/scenarios/types';
import type { TimeLock } from '../game/calendar/calendarMath';
import type { WeatherSeverity } from '../game/weather/types';
import type { GameSpeed } from '../game/types';
import type { StaffRole } from '../game/operations/types';
import type { CoasterSpecial } from '../game/coaster/content';
import type { SaveCommands, SaveFailure, SaveResult } from './saves/types';
import type { RecoveryCommands, RecoveryFailure, RecoveryResult } from './saves/recoveryTypes';
import type { UndoCommands } from './undo/types';
import type { CameraMotion } from '../rendering/RendererPort';
import type { FeedbackReport } from './alpha/feedbackReport';

/**
 * How a Sandbox or Scenario park starts (Phase 22). A run is not a park request: it starts through the run commands (`ui/runBridge.ts`: `startRun`, then `startRunStage` for each level; Phase 23). `startScenario(id, cards)` starts that scenario in Scenario mode; a null id is the Sandbox.
 */
export type ParkStartRequest =
  | { mode: 'sandbox'; mapId?: MapId; recipe?: MapRecipe }
  | { mode: 'scenario'; scenarioId: ScenarioId; cardIds: readonly string[] };

export interface GameCommands extends UndoCommands {
  setSpeed(speed: GameSpeed): void;
  togglePark(): void;
  /** Sandbox only (refused in a scenario park). The clock stays continuous. */
  setDayLength(seconds: number): void;
  /** Sandbox only. Pins the look's time of day; the day count and the raw clock keep running. */
  setTimeLock(lock: TimeLock): void;
  /** Sandbox only: weather effects on or off. The forecast keeps advancing while off. */
  setWeatherEnabled(enabled: boolean): void;
  /** Sandbox only: scales how strong the weather is (never which weather comes). */
  setWeatherSeverity(severity: WeatherSeverity): void;
  /** Sandbox only: optional opening hours on the raw clock. */
  setOpeningHours(enabled: boolean, open: number, close: number): void;
  /** Developer: step the current six hours through the five kinds of weather. */
  cycleDevWeather(): void;
  addMoney(): void;
  spawnGuests(): void;
  fillGuests(): void;
  startDevPark(): void;
  removeGuests(): void;
  /**
   * Frames the park entrance. Phase 11 (PA-021): the player's own moves (the brand button, the recentre button and
   * key) pass `'ease'`; everything else snaps. The classic renderer ignores `motion`.
   */
  focusEntrance(motion?: CameraMotion): void;
  rotateBuild(): void;
  /** Phase 26: turns the whole map view one quarter turn (-1 counter-clockwise, 1 clockwise). */
  rotateView(step: 1 | -1): void;
  setGridVisible(visible: boolean): void;
  /** Closes whichever inspector is open: a ride, a stall or facility, or (Phase 30) a guest. */
  closeInspector(): void;
  /**
   * Centres the camera on one building and opens its inspector: from the Buildings tab, and (Phase 30) from a complaint
   * link in Park Pulse, the Activity tab or the guest inspector. It closes the management dashboard so the inspector is
   * visible. A demolished object is ignored.
   */
  focusBuilding(objectId: number): void;
  /** Phase 30: opens the guest inspector on one guest (a guest who has left is ignored). */
  selectGuest(guestId: number): void;
  /**
   * Phase 11 (PA-015): demolishes the inspected ride or stall as one undo entry ("Comet Coaster demolished"), with the
   * usual demolition toast, and closes the inspector. Refused while a coaster layout is in progress.
   */
  demolishSelected(): void;
  setSelectedRideOpen(open: boolean): void;
  adjustSelectedRidePrice(delta: number): void;
  /**
   * Phase 28: gives one colour slot of the selected ride a swatch (a catalog swatch index) or, with
   * null, its default. One undo step per ride however many picks follow (they coalesce); a no-op
   * pick costs nothing. Cosmetic: free, never read by the simulation.
   */
  setSelectedObjectColour(slot: number, swatch: number | null): void;
  /** Phase 28: every slot of the inspected ride, coaster, stall or facility back to its default colour. */
  resetSelectedObjectColours(): void;
  /**
   * Phase 28 step 2: a named preset on every colourable object and the entrance gate, as ONE undo entry (and, in
   * a Scenario or on The Map, one charge for the things that change; free by default).
   */
  applyPresetToPark(presetId: ColourPresetId): void;
  setSelectedServiceOpen(open: boolean): void;
  adjustSelectedServicePrice(delta: number): void;
  hireStaff(role: StaffRole): void;
  fireStaff(role: StaffRole): void;
  /** Phase 41 step 4: ride along on the inspected ride (its lead car, or a circle round a flat ride). */
  startRideAlong(objectId: number): void;
  stopRideAlong(): void;
  /** Phase 41 step 4: the comfort choice: a wide (80°) or a narrower (60°) field of view. */
  setRideAlongWide(wide: boolean): void;
  /** Phase 42: dismisses one particular worker (the Staff window's "Fire this one"). */
  fireWorker(workerId: number): void;
  /** Phase 42: eases the camera to a worker (the Staff window's row). */
  focusWorker(workerId: number): void;
  /** Phase 42: eases the camera to a building without opening its inspector (the Buildings window's row). */
  centreBuilding(objectId: number): void;
  /** Phase 42: opens or closes rides and stalls by id (the Buildings window; one or many rows). */
  setObjectsOpen(objectIds: readonly number[], open: boolean): void;
  /** Phase 42: a ride's ticket price or a stall's item price up or down by `delta`, by id. */
  adjustObjectPrice(objectId: number, delta: number): void;
  trainStaff(role: StaffRole): void;
  forceSelectedRideBreakdown(): void;
  purchaseResearch(projectId: string): void;
  setSceneryInfluenceVisible(visible: boolean): void;
  /**
   * Phase 14: the crowd flow heatmap on or off (exclusive with the scenery heatmap; a classic-renderer press shows a
   * toast and never turns it on). Idempotent: the UI sets the store itself and also calls this.
   */
  setCrowdHeatmapVisible(visible: boolean): void;
  /**
   * Phase 14: centres the camera (eased) on a neighborhood by its key (0 = the gate): its worst tile when busy or worse,
   * else its focus tile; a neighborhood with a bottleneck also turns the crowd heatmap on.
   */
  focusNeighborhood(key: number): void;
  startScenario(scenarioId: string | null, cardIds?: readonly string[]): void;
  restartScenario(): void;
  chooseRewardCard(cardId: string): void;
  skipOnboardingStep(): void;
  dismissOnboarding(): void;
  coasterAdjustHeight(delta: number): void;
  coasterUndo(): void;
  coasterClear(): void;
  coasterBuild(): void;
  coasterToggleSpecial(kind: CoasterSpecial): void;
  /** Flips the lift under the cursor, else the last one laid. */
  coasterToggleLift(): void;
  /** Sets the lift that starts at the piece index to chained or free. */
  coasterSetLift(runStart: number, chained: boolean): void;
  /** Start screen: Continue the latest save (reusing the park behind the menu when it is still the newest). */
  menuContinue(): Promise<void>;
  /**
   * Phase 19: the feedback report (version, save format, renderer, browser, a few settings, the message) and, only when
   * `includePark` and a park is running, the current park as a save file. Builds; never sends anything.
   */
  buildFeedbackReport(message: string, includePark: boolean): FeedbackReport;
  /** Phase 19: whether there is a park the feedback report could attach. */
  canAttachPark(): boolean;
  /** New park from the start screen: a fresh sandbox on `mapId` (default: the Meadow Garden). */
  menuNewPark(mapId?: MapId): void;
  /** New park from the start screen on a map generated from `recipe` (the picker's Generate choice). */
  menuNewGenerated(recipe: MapRecipe): void;
  /** A fresh sandbox on a generated map, from anywhere (tooling and tests). */
  startGeneratedMap(recipe: MapRecipe): void;
  /** A fresh sandbox on a map, from anywhere (the dev park and the screenshot tooling use it). */
  startSandboxMap(mapId: MapId): void;
  /** Esc with nothing to close, and the Menu button. */
  openPauseMenu(): void;
  resumeFromMenu(): void;
  menuQuickSave(): void;
  requestQuitToMenu(): void;
  confirmQuitToMenu(choice: 'save' | 'discard'): Promise<void>;
  // --- Phase 22: game modes and profile ---
  /** Any new park: a mode, and for a scenario its id and loadout (see `ParkStartRequest`). */
  startPark(request: ParkStartRequest): void;
  /** Start screen or pause menu: The Map entry. The setup panel (New run, Continue run), or the run map in the pause menu of a run. */
  menuOpenTheMap(): void;
  /** Start screen / browser: a Scenario-mode park with this loadout (the unlock is checked). */
  menuStartScenario(scenarioId: string, cardIds: readonly string[]): void;
  /** Opens the park chooser (pause menu Parks, the result overlay) on a panel. */
  openParksChooser(panel: 'modes' | 'scenarios' | 'collection'): void;
  /** Collection: the per-mode "Use permanent bonuses" switch (applies to parks started afterwards). */
  setUseBonuses(mode: GameMode, on: boolean): void;
  dismissProfileNotice(): void;
  /** Resume the latest park of a mode (same path as Load). */
  menuLoadSlot(slotId: string): Promise<void>;
}

let commands: GameCommands | null = null;

export const registerGameCommands = (next: GameCommands | null): void => { commands = next; };

export const gameBridge = {
  setSpeed: (speed: GameSpeed) => commands?.setSpeed(speed),
  togglePark: () => commands?.togglePark(),
  setDayLength: (seconds: number) => commands?.setDayLength(seconds),
  setTimeLock: (lock: TimeLock) => commands?.setTimeLock(lock),
  setWeatherEnabled: (enabled: boolean) => commands?.setWeatherEnabled(enabled),
  setWeatherSeverity: (severity: WeatherSeverity) => commands?.setWeatherSeverity(severity),
  setOpeningHours: (enabled: boolean, open: number, close: number) => commands?.setOpeningHours(enabled, open, close),
  cycleDevWeather: () => commands?.cycleDevWeather(),
  addMoney: () => commands?.addMoney(),
  spawnGuests: () => commands?.spawnGuests(),
  fillGuests: () => commands?.fillGuests(),
  startDevPark: () => commands?.startDevPark(),
  removeGuests: () => commands?.removeGuests(),
  focusEntrance: (motion?: CameraMotion) => commands?.focusEntrance(motion),
  rotateBuild: () => commands?.rotateBuild(),
  rotateView: (step: 1 | -1) => commands?.rotateView(step),
  setGridVisible: (visible: boolean) => commands?.setGridVisible(visible),
  closeInspector: () => commands?.closeInspector(),
  requestUndo: () => commands?.requestUndo(),
  focusBuilding: (objectId: number) => commands?.focusBuilding(objectId),
  selectGuest: (guestId: number) => commands?.selectGuest(guestId),
  demolishSelected: () => commands?.demolishSelected(),
  setSelectedRideOpen: (open: boolean) => commands?.setSelectedRideOpen(open),
  adjustSelectedRidePrice: (delta: number) => commands?.adjustSelectedRidePrice(delta),
  setSelectedObjectColour: (slot: number, swatch: number | null) => commands?.setSelectedObjectColour(slot, swatch),
  resetSelectedObjectColours: () => commands?.resetSelectedObjectColours(),
  applyPresetToPark: (presetId: ColourPresetId) => commands?.applyPresetToPark(presetId),
  setSelectedServiceOpen: (open: boolean) => commands?.setSelectedServiceOpen(open),
  adjustSelectedServicePrice: (delta: number) => commands?.adjustSelectedServicePrice(delta),
  hireStaff: (role: StaffRole) => commands?.hireStaff(role),
  fireStaff: (role: StaffRole) => commands?.fireStaff(role),
  fireWorker: (workerId: number) => commands?.fireWorker(workerId),
  startRideAlong: (objectId: number) => commands?.startRideAlong(objectId),
  stopRideAlong: () => commands?.stopRideAlong(),
  setRideAlongWide: (wide: boolean) => commands?.setRideAlongWide(wide),
  focusWorker: (workerId: number) => commands?.focusWorker(workerId),
  centreBuilding: (objectId: number) => commands?.centreBuilding(objectId),
  setObjectsOpen: (objectIds: readonly number[], open: boolean) => commands?.setObjectsOpen(objectIds, open),
  adjustObjectPrice: (objectId: number, delta: number) => commands?.adjustObjectPrice(objectId, delta),
  trainStaff: (role: StaffRole) => commands?.trainStaff(role),
  forceSelectedRideBreakdown: () => commands?.forceSelectedRideBreakdown(),
  purchaseResearch: (projectId: string) => commands?.purchaseResearch(projectId),
  setSceneryInfluenceVisible: (visible: boolean) => commands?.setSceneryInfluenceVisible(visible),
  setCrowdHeatmapVisible: (visible: boolean) => commands?.setCrowdHeatmapVisible(visible),
  focusNeighborhood: (key: number) => commands?.focusNeighborhood(key),
  startScenario: (scenarioId: string | null, cardIds?: readonly string[]) => commands?.startScenario(scenarioId, cardIds),
  restartScenario: () => commands?.restartScenario(),
  chooseRewardCard: (cardId: string) => commands?.chooseRewardCard(cardId),
  skipOnboardingStep: () => commands?.skipOnboardingStep(),
  dismissOnboarding: () => commands?.dismissOnboarding(),
  coasterAdjustHeight: (delta: number) => commands?.coasterAdjustHeight(delta),
  coasterUndo: () => commands?.coasterUndo(),
  coasterClear: () => commands?.coasterClear(),
  coasterBuild: () => commands?.coasterBuild(),
  coasterToggleSpecial: (kind: CoasterSpecial) => commands?.coasterToggleSpecial(kind),
  coasterToggleLift: () => commands?.coasterToggleLift(),
  coasterSetLift: (runStart: number, chained: boolean) => commands?.coasterSetLift(runStart, chained),
  menuContinue: () => commands?.menuContinue() ?? Promise.resolve(),
  buildFeedbackReport: (message: string, includePark: boolean) => commands?.buildFeedbackReport(message, includePark) ?? null,
  canAttachPark: () => commands?.canAttachPark() ?? false,
  menuNewPark: (mapId?: MapId) => commands?.menuNewPark(mapId),
  menuNewGenerated: (recipe: MapRecipe) => commands?.menuNewGenerated(recipe),
  startGeneratedMap: (recipe: MapRecipe) => commands?.startGeneratedMap(recipe),
  startSandboxMap: (mapId: MapId) => commands?.startSandboxMap(mapId),
  openPauseMenu: () => commands?.openPauseMenu(),
  resumeFromMenu: () => commands?.resumeFromMenu(),
  menuQuickSave: () => commands?.menuQuickSave(),
  requestQuitToMenu: () => commands?.requestQuitToMenu(),
  confirmQuitToMenu: (choice: 'save' | 'discard') => commands?.confirmQuitToMenu(choice) ?? Promise.resolve(),
  startPark: (request: ParkStartRequest) => commands?.startPark(request),
  menuOpenTheMap: () => commands?.menuOpenTheMap(),
  menuStartScenario: (scenarioId: string, cardIds: readonly string[]) => commands?.menuStartScenario(scenarioId, cardIds),
  openParksChooser: (panel: 'modes' | 'scenarios' | 'collection') => commands?.openParksChooser(panel),
  setUseBonuses: (mode: GameMode, on: boolean) => commands?.setUseBonuses(mode, on),
  dismissProfileNotice: () => commands?.dismissProfileNotice(),
  menuLoadSlot: (slotId: string) => commands?.menuLoadSlot(slotId) ?? Promise.resolve(),
};

let saveCommands: SaveCommands | null = null;

export const registerSaveCommands = (next: SaveCommands | null): void => { saveCommands = next; };

const notReady: SaveFailure = { code: 'not-ready', message: 'Saving is not ready yet' };

/** Unregistered commands resolve to a typed failure instead of vanishing, so a dialog never waits forever. */
const refuse = <T>(): Promise<SaveResult<T>> => Promise.resolve({ ok: false, error: notReady });

/**
 * UI -> save layer. Separate from gameBridge because these are async and return results the
 * dialog renders; GameApp registers them next to the game commands.
 */
export const saveBridge: SaveCommands = {
  saveToSlot: (id, name, options) => saveCommands?.saveToSlot(id, name, options) ?? refuse(),
  quickSave: () => saveCommands?.quickSave() ?? refuse(),
  load: (id) => saveCommands?.load(id) ?? refuse(),
  rename: (id, name) => saveCommands?.rename(id, name) ?? refuse(),
  remove: (id) => saveCommands?.remove(id) ?? refuse(),
  refresh: () => saveCommands?.refresh() ?? Promise.resolve(),
  retryPersistence: () => saveCommands?.retryPersistence() ?? Promise.resolve(),
  dismissBanner: () => saveCommands?.dismissBanner(),
  resumeAutosaveHere: () => saveCommands?.resumeAutosaveHere(),
};

let recoveryCommands: RecoveryCommands | null = null;

export const registerRecoveryCommands = (next: RecoveryCommands | null): void => { recoveryCommands = next; };

const recoveryNotReady: RecoveryFailure = { code: 'no-offer', message: 'There is nothing to recover' };

/** Like `saveBridge`: an unregistered command resolves to a typed failure, so the prompt never waits forever. */
const refuseRecovery = <T>(): Promise<RecoveryResult<T>> => Promise.resolve({ ok: false, error: recoveryNotReady });

/** UI -> recovery controller. Registered by GameApp next to the save commands. */
export const recoveryBridge: RecoveryCommands = {
  resume: () => recoveryCommands?.resume() ?? refuseRecovery(),
  dismiss: () => recoveryCommands?.dismiss() ?? refuseRecovery(),
};
