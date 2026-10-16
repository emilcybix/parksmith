import { describe, expect, it } from 'vitest';
import { canonicalJson, hashState, hashString } from './hash';
import { PlainDataError } from './plainData';

describe('hashString (FNV-1a 64)', () => {
  it('matches the published FNV-1a 64-bit test vectors', () => {
    expect(hashString(''), 'empty string is the offset basis').toBe('cbf29ce484222325');
    expect(hashString('a'), 'vector a').toBe('af63dc4c8601ec8c');
    expect(hashString('foobar'), 'vector foobar').toBe('85944171f73967e8');
  });

  it('hashes UTF-8 bytes, agreeing with a BigInt reference over TextEncoder output', () => {
    const reference = (text: string): string => {
      let hash = 0xcbf29ce484222325n;
      for (const byte of new TextEncoder().encode(text)) {
        hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
      }
      return hash.toString(16).padStart(16, '0');
    };
    for (const text of ['é', '—', '😀', 'Queueing — $4.00.', 'x'.repeat(300), 'mixed é—😀 text']) {
      expect(hashString(text), `reference agreement for ${JSON.stringify(text)}`).toBe(reference(text));
    }
    expect(hashString('\ud800'), 'a lone surrogate hashes as U+FFFD').toBe(hashString('\ufffd'));
  });

  it('is sensitive to order and to single bits', () => {
    expect(hashString('ab'), 'order').not.toBe(hashString('ba'));
    expect(hashString('guest 1'), 'one character').not.toBe(hashString('guest 2'));
  });

  it('always returns sixteen lowercase hex characters', () => {
    for (const text of ['', 'x', 'y'.repeat(1000)]) expect(hashString(text), 'format').toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every depth and removes whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), 'sorted output')
      .toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it('does not depend on insertion order', () => {
    expect(canonicalJson({ a: 1, b: 2 }), 'same text').toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('keeps array order, which is simulation order', () => {
    expect(canonicalJson([1, 2]), 'order one').not.toBe(canonicalJson([2, 1]));
  });

  it('formats numbers in their exact shortest round-trip form', () => {
    expect(canonicalJson([0.1 + 0.2, 1e21, 5e-324, 100]), 'shortest forms').toBe('[0.30000000000000004,1e+21,5e-324,100]');
    const value = 0.1 + 0.2;
    expect(Number(canonicalJson(value)), 'round trips bit-exactly').toBe(value);
  });

  it('rejects non-finite numbers, negative zero, undefined, functions and non-plain objects with a path', () => {
    expect(() => canonicalJson({ a: [Number.NaN] })).toThrow(/\$\.a\[0\].*NaN/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/Infinity/);
    expect(() => canonicalJson({ a: -0 })).toThrow(/\$\.a.*-0/);
    expect(() => canonicalJson({ a: undefined })).toThrow(/\$\.a.*undefined/);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/function/);
    expect(() => canonicalJson({ a: new Map() })).toThrow(/\$\.a.*non-plain/);
    expect(() => canonicalJson({ a: new Float64Array(1) })).toThrow(PlainDataError);
  });

  it('rejects cycles and sparse arrays', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.me = cyclic;
    expect(() => canonicalJson(cyclic), 'cycle').toThrow(/cycle/);
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJson([1, , 2]), 'hole').toThrow(/hole/);
  });

  it('can opt in to normalising negative zero for live runtime objects', () => {
    expect(canonicalJson({ amount: -0 }, { normalizeNegativeZero: true }), 'normalised').toBe('{"amount":0}');
  });

  it('escapes strings, including the em dash and quotes used by guest thoughts', () => {
    expect(canonicalJson('Queueing — $4.00 "now"'), 'escaped').toBe('"Queueing — $4.00 \\"now\\""');
  });
});

describe('hashState', () => {
  it('is the same for equal states whatever the key order', () => {
    expect(hashState({ cash: 5, guests: [1, 2] }), 'stable').toBe(hashState({ guests: [1, 2], cash: 5 }));
  });

  it('differs when any leaf differs by one ulp', () => {
    const base = 1.1;
    const next = base + Number.EPSILON;
    expect(hashState({ cash: base }), 'one ulp changes the hash').not.toBe(hashState({ cash: next }));
  });

  it('survives a JSON round trip unchanged, which is what a save goes through', () => {
    const state = { cash: 1234.5678901234567, queue: [3, 1, 2], note: 'a — b', nested: { flag: false, none: null } };
    expect(hashState(JSON.parse(JSON.stringify(state))), 'round trip').toBe(hashState(state));
  });

  it('hashes a large state fast enough for per-tick checkpoints in tests', () => {
    const guests = Array.from({ length: 1000 }, (_, id) => ({
      id, x: id * 0.37, y: id * 0.11, route: Array.from({ length: 12 }, (__, step) => ({ x: step, y: id % 32 })),
      thought: `Heading for ride ${id}.`,
    }));
    const started = performance.now();
    const hash = hashState({ guests });
    const elapsed = performance.now() - started;
    expect(hash, 'hash produced').toMatch(/^[0-9a-f]{16}$/);
    expect(elapsed, `1000 guests hashed in ${elapsed.toFixed(1)} ms`).toBeLessThan(500);
  });
});
