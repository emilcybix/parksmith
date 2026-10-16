import { describe, expect, it } from 'vitest';

/**
 * Phase 23 "no dead UI" gate: the Park Tour is retired into The Map, so nothing in the UI or the app may still name its
 * machinery (the tour map and nodes, `TourManager`, the tour reset and storage option, the old store fields and the
 * retired `parkMap` input context). Comments that explain the retirement avoid these exact identifiers on purpose. The
 * legacy ids live on in `game/tour/*` and the profile, which this test does not scan.
 */
const sources = {
  ...import.meta.glob('../ui/**/*.{ts,tsx,css}', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }),
} as Record<string, string>;

const RETIRED = [
  'tour-node', 'TourMap', 'TourNodeBadge', 'TourMapIllustration', 'resetTour', 'TourManager', 'tourStorage', 'resolveTourOffer',
  'shouldOfferTour', 'shouldOpenParksMapOnFirstRun', 'maybeOpenFirstRunMap', 'tourOfferPending', 'ownedCardIds', 'tourNodes', 'openScenarioPicker',
  'currentNodeId', 'drawsFromTour', "'parkMap'",
] as const;

describe('the retired Park Tour leaves no machinery in the UI or the app', () => {
  const files = Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));

  it('scans a real set of files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(RETIRED)('nothing mentions %s', (word) => {
    const hits = files.filter(([, text]) => text.includes(word)).map(([path]) => path);
    expect(hits).toEqual([]);
  });
});
