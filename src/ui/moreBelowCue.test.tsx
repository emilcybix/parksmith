import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MoreBelowCue, hasMoreBelow } from './ScenarioHud';

/** Phase 35 (the Phase 25 open line): the Park Pulse card list says when rows hide below its fold. */
describe('the card list "more below" cue', () => {
  it('shows while rows are hidden below the fold, not at the bottom or when everything fits', () => {
    expect(hasMoreBelow({ scrollTop: 0, clientHeight: 46, scrollHeight: 120 })).toBe(true);
    expect(hasMoreBelow({ scrollTop: 60, clientHeight: 46, scrollHeight: 120 })).toBe(true);
    expect(hasMoreBelow({ scrollTop: 74, clientHeight: 46, scrollHeight: 120 })).toBe(false);
    expect(hasMoreBelow({ scrollTop: 0, clientHeight: 80, scrollHeight: 80 })).toBe(false);
    // A zoomed page reports fractions: half a pixel short of the bottom is the bottom.
    expect(hasMoreBelow({ scrollTop: 73.5, clientHeight: 46, scrollHeight: 120 })).toBe(false);
    // A hidden list (no layout) shows no cue.
    expect(hasMoreBelow({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 })).toBe(false);
  });

  it('is drawn only (a screen reader hears every row) and hidden until needed', () => {
    expect(renderToStaticMarkup(<MoreBelowCue shown={false} />)).toBe('<span class="scenario-cards-more" aria-hidden="true" hidden="">more below <b>▾</b></span>');
    expect(renderToStaticMarkup(<MoreBelowCue shown />)).toBe('<span class="scenario-cards-more" aria-hidden="true">more below <b>▾</b></span>');
  });
});
