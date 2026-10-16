import { PlainDataError } from './plainData';

/**
 * Deterministic state hashing for the determinism proof.
 *
 * Two runs of the simulation are "the same" when the canonical form of their serialized state is
 * the same, and a 64-bit hash of that form is a cheap way to compare thousands of checkpoints and
 * to print a failure that fits in a test message. It is a fingerprint for tests and integrity
 * checks, not a security primitive. It uses no dependency and no Node-only API, so it runs in the
 * browser too (for a future "does this save match" check before overwrite).
 */

export interface CanonicalJsonOptions {
  /**
   * Treat -0 as 0 instead of rejecting it. Serialized state never contains -0 (plainNumber removes
   * it), so the default rejects it to catch a serializer that forgot; set this only when hashing
   * live runtime objects that legitimately hold -0.
   */
  normalizeNegativeZero?: boolean;
}

const fail = (path: string, reason: string): never => {
  throw new PlainDataError({ path, reason });
};

const MAXIMUM_DEPTH = 64;

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, numbers in JavaScript's
 * shortest round-trip form (which is exact and identical in every engine), strings escaped by
 * JSON.stringify. Anything that is not plain data throws with its JSON path instead of being
 * silently dropped the way JSON.stringify drops undefined values, so two different states can
 * never hash alike by accident.
 */
export const canonicalJson = (value: unknown, options: CanonicalJsonOptions = {}): string => {
  const normalizeNegativeZero = options.normalizeNegativeZero === true;
  const ancestors: object[] = [];

  const write = (current: unknown, path: string, depth: number): string => {
    if (current === null) return 'null';
    switch (typeof current) {
      case 'string':
        return JSON.stringify(current);
      case 'boolean':
        return current ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(current)) return fail(path, Number.isNaN(current) ? 'NaN' : 'Infinity');
        if (Object.is(current, -0)) {
          if (!normalizeNegativeZero) return fail(path, '-0 (normalise with plainNumber)');
          return '0';
        }
        return String(current);
      case 'undefined':
        return fail(path, 'undefined value');
      case 'function':
        return fail(path, 'function');
      case 'symbol':
        return fail(path, 'symbol');
      case 'bigint':
        return fail(path, 'bigint');
      default:
        break;
    }
    const object = current as object;
    if (depth > MAXIMUM_DEPTH) return fail(path, `nesting deeper than ${MAXIMUM_DEPTH} levels`);
    if (ancestors.includes(object)) return fail(path, 'cycle');
    ancestors.push(object);
    try {
      if (Array.isArray(object)) {
        const parts: string[] = [];
        for (let index = 0; index < object.length; index += 1) {
          if (!(index in object)) return fail(`${path}[${index}]`, 'array hole');
          parts.push(write(object[index], `${path}[${index}]`, depth + 1));
        }
        return `[${parts.join(',')}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) return fail(path, 'class instance, Map, Set or other non-plain object');
      const record = object as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        parts.push(`${JSON.stringify(key)}:${write(record[key], `${path}.${key}`, depth + 1)}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      ancestors.pop();
    }
  };

  return write(value, '$', 0);
};

// FNV-1a, 64 bit: offset basis 0xcbf29ce484222325, prime 0x100000001b3. Arithmetic is done on two
// 32-bit halves so it needs neither BigInt nor a 64-bit integer type, and stays fast on 1 MB inputs.
const OFFSET_HIGH = 0xcbf29ce4;
const OFFSET_LOW = 0x84222325;
const PRIME_LOW = 0x1b3;

/** Hashes UTF-8 bytes of a string. Lone surrogates are encoded as U+FFFD, as TextEncoder does. */
export const hashString = (text: string): string => {
  let high = OFFSET_HIGH;
  let low = OFFSET_LOW;

  const mix = (byte: number): void => {
    low = (low ^ byte) >>> 0;
    // Multiply the 64-bit value by 2^40 + 0x1b3 modulo 2^64.
    const product = low * PRIME_LOW;
    const carry = Math.floor(product / 4294967296);
    const nextLow = product >>> 0;
    const nextHigh = (carry + Math.imul(high, PRIME_LOW) + (low << 8)) >>> 0;
    high = nextHigh;
    low = nextLow;
  };

  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      mix(code);
    } else if (code < 0x800) {
      mix(0xc0 | (code >> 6));
      mix(0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      mix(0xe0 | (code >> 12));
      mix(0x80 | ((code >> 6) & 0x3f));
      mix(0x80 | (code & 0x3f));
    } else {
      mix(0xf0 | (code >> 18));
      mix(0x80 | ((code >> 12) & 0x3f));
      mix(0x80 | ((code >> 6) & 0x3f));
      mix(0x80 | (code & 0x3f));
    }
  }
  return `${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
};

/** Hash of the canonical JSON of plain data: 16 lowercase hex characters. */
export const hashState = (value: unknown, options: CanonicalJsonOptions = {}): string => (
  hashString(canonicalJson(value, options))
);
