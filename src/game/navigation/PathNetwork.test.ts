import { describe, expect, it } from 'vitest';
import { PathNetwork } from './PathNetwork';

describe('PathNetwork', () => {
  it('finds a deterministic cardinal route through connected path cells', () => {
    const network = new PathNetwork();
    network.sync(new Set(['0,0', '1,0', '2,0', '2,1']), 1);
    expect(network.findRoute({ x: 0, y: 0 }, { x: 2, y: 1 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
    ]);
  });

  it('returns null for disconnected destinations', () => {
    const network = new PathNetwork();
    network.sync(new Set(['0,0', '1,0', '4,4']), 1);
    expect(network.findRoute({ x: 0, y: 0 }, { x: 4, y: 4 })).toBeNull();
  });

  it('invalidates cached destination maps when paths change', () => {
    const network = new PathNetwork();
    network.sync(new Set(['0,0', '1,0']), 1);
    expect(network.findRoute({ x: 0, y: 0 }, { x: 1, y: 0 })).not.toBeNull();
    network.sync(new Set(['0,0', '1,0', '2,0']), 2);
    expect(network.findRoute({ x: 0, y: 0 }, { x: 2, y: 0 })).toHaveLength(3);
  });

  it('finds the closest safe path after a route cell is removed', () => {
    const network = new PathNetwork();
    network.sync(new Set(['0,0', '1,0', '5,5']), 2);
    expect(network.findNearestPath({ x: 2, y: 0 })).toEqual({ x: 1, y: 0 });
  });
});

describe('PathNetwork canonical component order and invalidation', () => {
  const cells = new Set(['3,2', '2,2', '2,3', '2,4', '3,4', '9,9']);

  it('returns the same y-then-x ordered array whichever cell is queried first', () => {
    const first = new PathNetwork();
    const second = new PathNetwork();
    first.sync(cells, 1);
    second.sync(cells, 1);
    const fromFirst = first.connectedCells({ x: 2, y: 2 });
    const fromLast = second.connectedCells({ x: 3, y: 4 });
    expect(fromLast, 'component order must not depend on the first queried cell').toEqual(fromFirst);
    expect(fromFirst, 'sorted by y then x').toEqual([
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 3 },
      { x: 2, y: 4 },
      { x: 3, y: 4 },
    ]);
    expect(first.connectedCells({ x: 3, y: 4 }), 'one shared array per component').toBe(fromFirst);
  });

  it('rebuilds after invalidate() even when sync receives the same version number', () => {
    const network = new PathNetwork();
    network.sync(new Set(['0,0', '1,0']), 5);
    expect(network.findRoute({ x: 0, y: 0 }, { x: 1, y: 0 })).not.toBeNull();
    network.sync(new Set(['0,0', '0,1']), 5);
    expect(network.contains({ x: 1, y: 0 }), 'same version is a no-op without invalidate').toBe(true);
    network.invalidate();
    expect(network.getPathVersion()).toBe(-1);
    network.sync(new Set(['0,0', '0,1']), 5);
    expect(network.contains({ x: 1, y: 0 })).toBe(false);
    expect(network.findRoute({ x: 0, y: 0 }, { x: 0, y: 1 })).toHaveLength(2);
    expect(network.connectedCells({ x: 0, y: 0 })).toHaveLength(2);
  });

  it('keeps the request counter when invalidated', () => {
    const network = new PathNetwork();
    network.sync(new Set(['0,0']), 1);
    network.findRoute({ x: 0, y: 0 }, { x: 0, y: 0 });
    network.invalidate();
    expect(network.consumeRequestCount()).toBe(1);
  });
});
