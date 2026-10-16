import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerGameCommands, type GameCommands } from '../app/gameBridge';
import { ComplaintLink, focusOpenedInspector } from './ComplaintLink';

/**
 * Phase 30 review fixes: one complaint link everywhere (Pulse, guest inspector, dashboard) named "Show <building>", and
 * after the press keyboard focus moves into the opened building inspector instead of dropping to the page.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  registerGameCommands(null);
});

describe('ComplaintLink', () => {
  it('is a native button named "Show <building>" with the arrow hidden from assistive tech', () => {
    const html = renderToStaticMarkup(<ComplaintLink objectId={3} objectName="Cloud Hopper" className="pulse-link" />);
    expect(html).toBe('<button type="button" class="pulse-link" title="Show Cloud Hopper and open its inspector" aria-label="Show Cloud Hopper"><span aria-hidden="true">→ </span>Cloud Hopper</button>');
  });

  it('pressing it focuses the building, then on the next frame the opened inspector\'s close button', () => {
    const calls: string[] = [];
    registerGameCommands({ focusBuilding: (objectId: number) => calls.push(`focusBuilding ${objectId}`) } as unknown as GameCommands);
    const frames: Array<() => void> = [];
    let selector = '';
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('document', {
      querySelector: (query: string) => {
        selector = query;
        return { focus: () => calls.push('focus') };
      },
    });
    const element = ComplaintLink({ objectId: 9, objectName: 'Fizz Foundry', className: 'insight-link' });
    (element.props.onClick as () => void)();
    expect(calls).toEqual(['focusBuilding 9']);
    frames.forEach((frame) => frame());
    expect(calls).toEqual(['focusBuilding 9', 'focus']);
    expect(selector).toBe('.ride-inspector:not(.guest-inspector) header button[aria-label="Close inspector"]');
  });

  it('without a DOM the focus move is a no-op', () => {
    expect(() => focusOpenedInspector()).not.toThrow();
  });
});
