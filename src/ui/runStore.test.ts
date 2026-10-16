import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRunCommands, type RunCommands } from './runBridge';
import { escapeRunLayer } from './runEscape';
import { useUiStore } from './store';
import { snapshotAt } from './runTestSupport';

const base = useUiStore.getState();
afterEach(() => {
  registerRunCommands(null);
  useUiStore.setState(base, true);
});

const spy = (): { [K in keyof RunCommands]: ReturnType<typeof vi.fn> } => {
  const commands = {
    startRun: vi.fn(), continueRun: vi.fn(async () => undefined), openRunMap: vi.fn(), closeRunMap: vi.fn(), acceptRunOffer: vi.fn(), startRunStage: vi.fn(),
    continueAfterStage: vi.fn(), abandonRun: vi.fn(), runEndAction: vi.fn(), resolveLeaveRun: vi.fn(), resolveMapOffer: vi.fn(), playCard: vi.fn(),
  };
  registerRunCommands(commands);
  return commands;
};

describe('run store fields', () => {
  it('start closed and empty, so a run park is the only thing that fills them', () => {
    const state = useUiStore.getState();
    expect(state.run).toBeNull();
    expect(state.runView).toBeNull();
    expect(state.runDrawer).toBeNull();
    expect(state.runLoadoutSelection).toEqual([]);
    expect(state.runRewards).toBeNull();
    expect(state.leaveRunPrompt).toBeNull();
    expect(state.runBonusIds).toBeNull();
    expect(state.mapOfferPending).toBe(false);
  });

  it('changing the view closes the drawer', () => {
    useUiStore.getState().setRunDrawer('deck');
    useUiStore.getState().setRunView('offer');
    expect(useUiStore.getState().runDrawer).toBeNull();
    expect(useUiStore.getState().runView).toBe('offer');
  });

  it('toggling a loadout card follows the run: slots cap it, removing always works, no run changes nothing', () => {
    useUiStore.getState().toggleRunLoadoutCard('grand-opening');
    expect(useUiStore.getState().runLoadoutSelection).toEqual([]);
    const run = snapshotAt(3, 'loadout');
    useUiStore.setState({ run });
    const [a, b, c] = run.deck.map((row) => row.cardId);
    for (const id of [a, b, c]) useUiStore.getState().toggleRunLoadoutCard(id);
    expect(useUiStore.getState().runLoadoutSelection).toEqual([a, b]);
    useUiStore.getState().toggleRunLoadoutCard(a);
    expect(useUiStore.getState().runLoadoutSelection).toEqual([b]);
    useUiStore.getState().resetRunLoadoutSelection();
    expect(useUiStore.getState().runLoadoutSelection).toEqual([]);
  });
});

describe('Escape in the run layers', () => {
  it('the leave-run question answers Cancel', () => {
    const commands = spy();
    useUiStore.setState({ leaveRunPrompt: { reason: 'new-run' }, run: snapshotAt(1, 'loadout'), runView: 'map' });
    escapeRunLayer('leaveRun');
    expect(commands.resolveLeaveRun).toHaveBeenCalledWith('cancel');
    expect(commands.closeRunMap).not.toHaveBeenCalled();
  });

  it('an open drawer closes first and the run map stays', () => {
    const commands = spy();
    useUiStore.setState({ run: snapshotAt(1, 'loadout'), runView: 'map', runDrawer: 'deck' });
    escapeRunLayer('runMap');
    expect(useUiStore.getState().runDrawer).toBeNull();
    expect(commands.closeRunMap).not.toHaveBeenCalled();
    escapeRunLayer('runMap');
    expect(commands.closeRunMap).toHaveBeenCalledTimes(1);
  });

  it('the offer and the loadout go back to the map without accepting or starting anything', () => {
    const commands = spy();
    useUiStore.setState({ run: snapshotAt(1, 'offer'), runView: 'offer' });
    escapeRunLayer('runMap');
    expect(useUiStore.getState().runView).toBe('map');
    useUiStore.setState({ run: snapshotAt(1, 'loadout'), runView: 'loadout' });
    escapeRunLayer('runMap');
    expect(useUiStore.getState().runView).toBe('map');
    expect(commands.acceptRunOffer).not.toHaveBeenCalled();
    expect(commands.startRunStage).not.toHaveBeenCalled();
    expect(commands.closeRunMap).not.toHaveBeenCalled();
  });

  it('the cleared-level screen and the end screens are answered with their buttons, never by Escape', () => {
    const commands = spy();
    for (const [run, view] of [[snapshotAt(1, 'cleared'), 'stage-result'], [snapshotAt(1, 'lost'), 'end'], [snapshotAt(0, 'won'), 'end']] as const) {
      useUiStore.setState({ run, runView: view });
      escapeRunLayer('runMap');
    }
    for (const command of Object.values(commands)) expect(command).not.toHaveBeenCalled();
  });

  it('a stale offer view over a loadout phase reads as the map, so Escape closes it', () => {
    const commands = spy();
    useUiStore.setState({ run: snapshotAt(1, 'loadout'), runView: 'offer' });
    escapeRunLayer('runMap');
    expect(commands.closeRunMap).toHaveBeenCalledTimes(1);
  });
});
