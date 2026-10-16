import { describe, expect, it } from 'vitest';
import { MAPS } from '../game/maps/content';
import { FACINGS, FACING_VECTORS } from '../game/maps/types';
import { ONBOARDING_STEPS } from '../game/onboarding/content';
import { OnboardingTracker } from '../game/onboarding/OnboardingTracker';
import { ParkSession } from '../game/session/ParkSession';
import { cellToWorld } from '../rendering/isometric';
import { cellToView, createViewFrame, VIEW_ROTATIONS } from '../rendering/viewRotation';
import { describeFirstDay, gateInwardOnScreen } from './firstDayModel';
import { useUiStore } from './store';

/**
 * Phase 24 review fix: the First Day lay-path hint said "up from the gate" on every map, but the gate is a map
 * property and the player turns the view. The card now names the screen direction the park runs from the live gate.
 */

const layPath = ONBOARDING_STEPS.find((step) => step.id === 'lay-path')!;

describe('the lay-path hint follows the gate on screen', () => {
  it('the store default is the Meadow gate', () => {
    expect(new ParkSession(null).world.entranceFacing).toBe('north');
    expect(useUiStore.getState().gateFacing).toBe('north');
  });

  it('the Meadow gate in view 0 keeps the shipped wording, character for character', () => {
    const view = describeFirstDay(new OnboardingTracker().snapshot(), gateInwardOnScreen('north', 0));
    if (view.mode !== 'step') throw new Error('expected a step view');
    expect(view.hint).toBe(layPath.hint);
    expect(view.hint).toBe('Pick Paths and drag at least 6 tiles up from the gate, joined to it.');
    expect(describeFirstDay(new OnboardingTracker().snapshot())).toEqual(view);
  });

  it.each(MAPS.flatMap((map) => VIEW_ROTATIONS.map((rotation) => [map.id, rotation] as const)))(
    '%s, view %s: the word matches where the cell one step into the park lands on screen',
    (mapId, rotation) => {
      const world = new ParkSession(null, [], { mapId }).world;
      const { x, y } = world.entrance;
      const inward = FACING_VECTORS[world.entranceFacing];
      const frame = createViewFrame(rotation, world.width, world.height);
      const gate = cellToWorld(cellToView(frame, x, y, { x: 0, y: 0 }));
      const inside = cellToWorld(cellToView(frame, x + inward.x, y + inward.y, { x: 0, y: 0 }));
      const down = inside.y > gate.y;
      const right = inside.x > gate.x;
      const expected = down ? (right ? 'down-right' : 'down-left') : (right ? 'up' : 'up-left');
      expect(gateInwardOnScreen(world.entranceFacing, rotation)).toBe(expected);
    },
  );

  it('Red Rock Canyon (gate on the upper-right edge) says down and to the left in view 0; no other step changes', () => {
    const world = new ParkSession(null, [], { mapId: 'red-rock-canyon' }).world;
    const view = describeFirstDay(new OnboardingTracker().snapshot(), gateInwardOnScreen(world.entranceFacing, 0));
    if (view.mode !== 'step') throw new Error('expected a step view');
    expect(view.hint).toBe('Pick Paths and drag at least 6 tiles down and to the left from the gate, joined to it.');
    expect(view.announcement).toContain(view.hint);
    const tracker = new OnboardingTracker();
    tracker.skipStep('lay-path');
    const next = describeFirstDay(tracker.snapshot(), 'down-left');
    if (next.mode !== 'step') throw new Error('expected a step view');
    expect(next.hint).toBe(ONBOARDING_STEPS[1].hint);
  });

  it('every facing and view gives each of the four diagonals exactly four times', () => {
    const counts = new Map<string, number>();
    for (const facing of FACINGS) for (const rotation of VIEW_ROTATIONS) {
      const word = gateInwardOnScreen(facing, rotation);
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({ up: 4, 'up-left': 4, 'down-left': 4, 'down-right': 4 });
  });
});
