import { describe, expect, it } from 'vitest';
import type { CoasterPiece } from '../game/coaster/design';
import { ParkSession } from '../game/session/ParkSession';
import { WorldRenderer } from './WorldRenderer';

/**
 * PA-008. A coaster layout used to be drawn into the preview layer, which is cleared on every
 * single pointer move — so a half-finished track vanished the moment the cursor left the plot or
 * passed over a panel, while the pieces were still in the draft. The layout now owns its own
 * layer, and only an explicit discard empties it.
 */
const layout: CoasterPiece[] = Array.from({ length: 6 }, (_unused, index) => ({
  cell: { x: 4 + index, y: 6 },
  height: 0,
}));

describe('coaster layout in progress', () => {
  const renderer = (): WorldRenderer => {
    const view = new WorldRenderer(new ParkSession(null));
    view.syncWorld();
    return view;
  };

  it('survives every hover, ghost preview and pointer exit', () => {
    const view = renderer();
    view.drawCoasterDraft(layout, 0xe4572e);
    expect(view.coasterDraftVisible).toBe(true);

    // What a pointer move over the plot, and a pointer leaving it, both do.
    view.clearPreview();
    expect(view.coasterDraftVisible, 'a hover wiped the layout').toBe(true);

    // What arming another catalog item and hovering the plot does.
    view.drawPreview([{ x: 20, y: 20 }], null, true);
    expect(view.coasterDraftVisible, 'another tool wiped the layout').toBe(true);

    // What the bulldozer hover does.
    view.drawPreview([{ x: 21, y: 21 }], null, true, true);
    expect(view.coasterDraftVisible, 'the bulldozer wiped the layout').toBe(true);
  });

  it('is emptied only by an explicit discard', () => {
    const view = renderer();
    view.drawCoasterDraft(layout, 0xe4572e);
    view.drawCoasterDraft([], 0);
    expect(view.coasterDraftVisible).toBe(false);
  });

  it('draws a parked layout dimmed rather than hiding it', () => {
    const view = renderer();
    view.drawCoasterDraft(layout, 0xe4572e, false);
    expect(view.coasterDraftVisible, 'a parked layout was hidden instead of dimmed').toBe(true);
  });
});
