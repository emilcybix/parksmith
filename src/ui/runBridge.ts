import type { RunDifficulty } from '../game/run/types';

/**
 * UI -> The Map (Phase 23). Same pattern as `gameBridge`: GameApp registers the commands when it mounts and an
 * unregistered command does nothing, so a component can be rendered and tested without the app. The names and
 * meanings are the contract between the run screens and the app's run flows.
 *
 * Who writes what: the app owns the run (`useUiStore.run`, `runBonusIds`, `runRewards`, `leaveRunPrompt`) and decides
 * when the run overlay opens or closes (`runView`: 'map' on start, Continue and Open run map, 'stage-result' after a
 * cleared stage, 'end' at the end of a run, null when a stage begins or the overlay closes). The screens only change
 * the sub-view inside a phase (map, offer, loadout) with `setRunView`, and never touch the run itself.
 */
export interface RunCommands {
  /** A fresh run. May raise `leaveRunPrompt` first when the current park is an unfinished run. */
  startRun(seed: number, difficulty: RunDifficulty): void;
  /** Continue the newest run save (the setup panel's Continue run). */
  continueRun(): Promise<void>;
  /** Open the run overlay on its map view (the top bar's Run map, the pause menu's Run map). */
  openRunMap(): void;
  /**
   * Close the run overlay. In a stage this is "back to the park". Between stages it opens the pause menu over the
   * frozen backdrop (Save, Load and Settings stay reachable from there).
   */
  closeRunMap(): void;
  /** Accept the offer before the current level: `all` adds every offered card, `pick` adds the picked ones. */
  acceptRunOffer(picked?: readonly string[]): void;
  /** Start the current level with these deck cards as the loadout (validated by the run model). */
  startRunStage(cardIds: readonly string[]): void;
  /** The cleared-level screen's button: back to the run map. */
  continueAfterStage(): void;
  /** End the run as an abandon (the screen has already asked). */
  abandonRun(): void;
  /** The end screens' buttons and the map's Main menu (`main-menu` leaves to the start screen; an unfinished run stays in its autosave). */
  runEndAction(action: 'same-seed' | 'new-run' | 'main-menu'): void;
  /** The leave-run prompt's answer. `save-first` opens Save / Load, the prompt stays until the player answers again. */
  resolveLeaveRun(choice: 'save-first' | 'leave' | 'cancel'): void;
  /** The one-time "Ready for The Map?" offer in Park Pulse. */
  resolveMapOffer(open: boolean): void;
  /**
   * Phase 25: play a one-shot card of the running stage (the Park Pulse card list). The app refuses it between stages and
   * says why in a toast when the session does ("No ride is broken"); a play is one undo step.
   */
  playCard(cardId: string): void;
}

let commands: RunCommands | null = null;

export const registerRunCommands = (next: RunCommands | null): void => { commands = next; };

export const runBridge = {
  startRun: (seed: number, difficulty: RunDifficulty) => commands?.startRun(seed, difficulty),
  continueRun: () => commands?.continueRun() ?? Promise.resolve(),
  openRunMap: () => commands?.openRunMap(),
  closeRunMap: () => commands?.closeRunMap(),
  acceptRunOffer: (picked?: readonly string[]) => commands?.acceptRunOffer(picked),
  startRunStage: (cardIds: readonly string[]) => commands?.startRunStage(cardIds),
  continueAfterStage: () => commands?.continueAfterStage(),
  abandonRun: () => commands?.abandonRun(),
  runEndAction: (action: 'same-seed' | 'new-run' | 'main-menu') => commands?.runEndAction(action),
  resolveLeaveRun: (choice: 'save-first' | 'leave' | 'cancel') => commands?.resolveLeaveRun(choice),
  resolveMapOffer: (open: boolean) => commands?.resolveMapOffer(open),
  playCard: (cardId: string) => commands?.playCard(cardId),
};
