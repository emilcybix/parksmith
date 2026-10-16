import { describe, expect, it } from 'vitest';
import {
  PlainDataError,
  assertPlainData,
  assertStructuredCloneSafe,
  auditOwnProperties,
  findPlainDataViolation,
  plainDeepEqual,
  plainNumber,
} from './plainData';

class Widget {
  readonly size = 3;
}

describe('assertPlainData', () => {
  it('accepts objects, arrays, finite numbers, strings, booleans and null', () => {
    const value = { a: 1, b: [1.5, -2, 0], c: { d: 'x', e: true, f: null }, g: [] as number[] };
    expect(() => assertPlainData(value), 'clean data passes').not.toThrow();
  });

  it('reports the JSON path of a function', () => {
    const violation = findPlainDataViolation({ guests: [{ id: 1 }, { id: 2, callback: () => 1 }] });
    expect(violation?.path, 'path to the function').toBe('$.guests[1].callback');
    expect(violation?.reason, 'reason names the type').toBe('function');
  });

  it('rejects class instances and names the class', () => {
    expect(() => assertPlainData({ widgets: [new Widget()] })).toThrow(/\$\.widgets\[0\].*class instance \(Widget\)/);
  });

  it('rejects Map and Set with advice on how to store them', () => {
    expect(findPlainDataViolation({ m: new Map() })?.reason, 'Map').toMatch(/^Map/);
    expect(findPlainDataViolation({ s: new Set([1]) })?.reason, 'Set').toMatch(/^Set/);
  });

  it('rejects typed arrays, which structured clone would accept but JSON would mangle', () => {
    expect(findPlainDataViolation({ scores: new Float64Array(2) })?.path, 'typed array').toBe('$.scores');
  });

  it('rejects DOM-like and renderer-like objects as such', () => {
    class Container { addEventListener = () => undefined; }
    expect(findPlainDataViolation({ view: new Container() })?.reason, 'renderer container').toMatch(/DOM or renderer object/);
    expect(findPlainDataViolation({ node: { nodeType: 1 } }), 'a plain object with nodeType is still plain').toBeNull();
    const fake = Object.create({ constructor: { name: 'HTMLCanvasElement' } }) as object;
    expect(findPlainDataViolation({ canvas: fake })?.reason, 'HTML element by name').toMatch(/DOM or renderer object/);
  });

  it('rejects undefined values but not absent keys', () => {
    expect(findPlainDataViolation({ a: undefined })?.path, 'undefined value').toBe('$.a');
    expect(findPlainDataViolation({}), 'absent key is fine').toBeNull();
  });

  it('rejects NaN, Infinity and negative zero', () => {
    expect(findPlainDataViolation({ a: [Number.NaN] })?.reason, 'NaN').toBe('NaN');
    expect(findPlainDataViolation({ a: Number.POSITIVE_INFINITY })?.reason, '+Infinity').toBe('+Infinity');
    expect(findPlainDataViolation({ a: Number.NEGATIVE_INFINITY })?.reason, '-Infinity').toBe('-Infinity');
    expect(findPlainDataViolation({ a: { b: -0 } })?.path, '-0 path').toBe('$.a.b');
  });

  it('rejects cycles and sparse arrays and symbols and bigint', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(findPlainDataViolation(cyclic)?.path, 'cycle').toBe('$.self');
    // eslint-disable-next-line no-sparse-arrays
    expect(findPlainDataViolation({ a: [1, , 3] })?.path, 'hole').toBe('$.a[1]');
    expect(findPlainDataViolation({ a: Symbol('x') })?.reason, 'symbol value').toBe('symbol');
    expect(findPlainDataViolation({ [Symbol('k')]: 1 })?.reason, 'symbol key').toBe('symbol-keyed property');
    expect(findPlainDataViolation({ a: 1n })?.reason, 'bigint').toBe('bigint');
  });

  it('allows the same object to appear twice when it is not a cycle, and quotes odd keys in paths', () => {
    const shared = { x: 1 };
    expect(findPlainDataViolation({ a: shared, b: shared }), 'shared references are not cycles').toBeNull();
    expect(findPlainDataViolation({ 'a-b': { c: undefined } })?.path, 'quoted key').toBe('$["a-b"].c');
  });

  it('accepts null-prototype objects and throws PlainDataError with path and reason', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.a = 1;
    expect(findPlainDataViolation(bare), 'null prototype is plain').toBeNull();
    try {
      assertPlainData({ a: Number.NaN }, '$.save');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PlainDataError);
      expect((error as PlainDataError).path, 'error path').toBe('$.save.a');
    }
  });

  it('stops at runaway nesting instead of overflowing the stack', () => {
    let nested: unknown = 1;
    for (let level = 0; level < 100; level += 1) nested = { next: nested };
    expect(findPlainDataViolation(nested)?.reason, 'depth guard').toMatch(/nesting deeper/);
  });
});

describe('plainNumber', () => {
  it('passes finite numbers and normalises negative zero', () => {
    expect(plainNumber(1.25), 'ordinary number').toBe(1.25);
    expect(Object.is(plainNumber(-0), 0), '-0 becomes +0').toBe(true);
  });

  it('throws with the supplied path for NaN and Infinity', () => {
    expect(() => plainNumber(Number.NaN, '$.cash')).toThrow(/\$\.cash.*NaN/);
    expect(() => plainNumber(Number.POSITIVE_INFINITY, '$.cash')).toThrow(/Infinity/);
  });
});

describe('plainDeepEqual', () => {
  it('ignores key order but not array order, and distinguishes -0', () => {
    expect(plainDeepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), 'key order').toBe(true);
    expect(plainDeepEqual([1, 2], [2, 1]), 'array order').toBe(false);
    expect(plainDeepEqual(0, -0), 'Object.is semantics').toBe(false);
    expect(plainDeepEqual({ a: 1 }, { a: 1, b: undefined }), 'extra key').toBe(false);
    expect(plainDeepEqual(null, {}), 'null vs object').toBe(false);
    expect(plainDeepEqual([], {}), 'array vs object').toBe(false);
  });
});

describe('assertStructuredCloneSafe', () => {
  it('accepts plain data and rejects functions with a path', () => {
    expect(() => assertStructuredCloneSafe({ a: [1, 2, { b: 'c' }] }), 'plain data clones').not.toThrow();
    expect(() => assertStructuredCloneSafe({ a: { f: () => 1 } })).toThrow(/\$\.a\.f/);
  });
});

describe('auditOwnProperties', () => {
  class Owner {
    readonly guests = new Map<number, string>();
    private nextId = 1;
    advance(): number { this.nextId += 1; return this.nextId; }
    cache = 0;
    readonly world = {};
  }

  it('reports nothing when every own property is accounted for exactly once', () => {
    expect(auditOwnProperties(new Owner(), {
      serialized: ['guests', 'nextId'],
      derived: ['cache'],
      config: ['world'],
      transient: [],
    }), 'fully accounted').toEqual([]);
  });

  it('fails on a property nobody classified, a stale entry and a double classification', () => {
    const problems = auditOwnProperties(new Owner(), {
      serialized: ['guests', 'nextId', 'cache'],
      derived: ['cache', 'gone'],
      config: [],
      transient: [],
      optional: [],
    });
    expect(problems, 'world is unclassified').toContain("'world' is neither serialized nor in the derived/config/transient allowlist");
    expect(problems, 'gone is stale').toContain("'gone' is allowlisted but is not an own property any more (stale entry)");
    expect(problems, 'cache is double').toContain("'cache' is listed as both serialized and derived");
  });

  it('tolerates allowlisted optional properties that are absent', () => {
    expect(auditOwnProperties({ a: 1 }, {
      serialized: ['a'], derived: [], config: [], transient: ['maybe'], optional: ['maybe'],
    }), 'optional absent is fine').toEqual([]);
  });
});
