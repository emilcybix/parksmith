/**
 * The plain-data rule for everything a save contains.
 *
 * A save may hold only objects, arrays, finite numbers, strings, booleans and null. That is what
 * makes it safe to hand to IndexedDB (structured clone), to JSON, to a hash, and to a future
 * migration, and it is what keeps a renderer or React object from ever reaching disk. The rule is
 * enforced at runtime here because TypeScript cannot express "no class instances, no undefined
 * values, no -0" on an interface.
 *
 * This module is pure and dependency-free so the save tests, the hash and the owners' serializers
 * can all share it without cycles.
 */

/** A violation, located by a JSON-path style string such as `$.guests[3].route[0].x`. */
export interface PlainDataViolation {
  path: string;
  reason: string;
}

/** Thrown by assertPlainData, plainNumber and the canonical-JSON writer. */
export class PlainDataError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(violation: PlainDataViolation) {
    super(`Not plain data at ${violation.path}: ${violation.reason}`);
    this.name = 'PlainDataError';
    this.path = violation.path;
    this.reason = violation.reason;
  }
}

/** Deep structures beyond this are treated as runaway nesting rather than walked. */
const MAXIMUM_DEPTH = 64;

const RENDERER_OR_DOM_NAME = /^(HTML|SVG|DOM|Element$|Node$|Window$|Document$|Event$|Container$|Graphics$|Sprite$|Text$|Application$|Texture$|Renderer$|Pixi|Three|Mesh$|Object3D$|WebGL)/;

const describeObject = (value: object): string => {
  const prototype: unknown = Object.getPrototypeOf(value);
  const name = (prototype as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  const label = typeof name === 'string' && name.length > 0 ? name : 'anonymous class';
  if (value instanceof Map) return `Map (store entries as an array in iteration order)`;
  if (value instanceof Set) return `Set (store a sorted array, or the insertion order if order is observable)`;
  const candidate = value as { nodeType?: unknown; addEventListener?: unknown };
  if (
    RENDERER_OR_DOM_NAME.test(label)
    || typeof candidate.nodeType === 'number'
    || typeof candidate.addEventListener === 'function'
  ) {
    return `DOM or renderer object (${label}); renderer state must never be saved`;
  }
  return `class instance (${label}); copy it into a plain object`;
};

const childPath = (path: string, key: string): string => (
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
);

/**
 * Returns the first violation found, depth first in key order, or null for clean data. The
 * non-throwing form lets tests assert on the exact path.
 */
export const findPlainDataViolation = (value: unknown, rootPath = '$'): PlainDataViolation | null => {
  const ancestors: object[] = [];

  const visit = (current: unknown, path: string, depth: number): PlainDataViolation | null => {
    if (current === null) return null;
    switch (typeof current) {
      case 'string':
      case 'boolean':
        return null;
      case 'number':
        if (Number.isNaN(current)) return { path, reason: 'NaN' };
        if (!Number.isFinite(current)) return { path, reason: `${current > 0 ? '+' : '-'}Infinity` };
        if (Object.is(current, -0)) return { path, reason: '-0 (normalise with plainNumber)' };
        return null;
      case 'undefined':
        return { path, reason: 'undefined value (omit the key and restore the default, or use null)' };
      case 'function':
        return { path, reason: 'function' };
      case 'symbol':
        return { path, reason: 'symbol' };
      case 'bigint':
        return { path, reason: 'bigint' };
      default:
        break;
    }
    const object = current as object;
    if (depth > MAXIMUM_DEPTH) return { path, reason: `nesting deeper than ${MAXIMUM_DEPTH} levels` };
    if (ancestors.includes(object)) return { path, reason: 'cycle (object contains itself)' };
    const prototype: unknown = Object.getPrototypeOf(object);
    ancestors.push(object);
    try {
      if (Array.isArray(object)) {
        if (prototype !== Array.prototype) return { path, reason: describeObject(object) };
        for (let index = 0; index < object.length; index += 1) {
          const elementPath = `${path}[${index}]`;
          if (!(index in object)) return { path: elementPath, reason: 'array hole (sparse array)' };
          const violation = visit(object[index], elementPath, depth + 1);
          if (violation) return violation;
        }
        return null;
      }
      if (prototype !== Object.prototype && prototype !== null) return { path, reason: describeObject(object) };
      if (Object.getOwnPropertySymbols(object).length > 0) return { path, reason: 'symbol-keyed property' };
      for (const key of Object.keys(object)) {
        const violation = visit((object as Record<string, unknown>)[key], childPath(path, key), depth + 1);
        if (violation) return violation;
      }
      return null;
    } finally {
      ancestors.pop();
    }
  };

  return visit(value, rootPath, 0);
};

/** Throws a PlainDataError naming the JSON path of the first violation. */
export const assertPlainData = (value: unknown, rootPath = '$'): void => {
  const violation = findPlainDataViolation(value, rootPath);
  if (violation) throw new PlainDataError(violation);
};

/**
 * The one way a serializer copies a number into a save: it must be finite, and -0 becomes 0.
 * JSON writes -0 as "0", so without this a restored park would differ from a never-saved one under
 * Object.is, and the determinism hash would flag a difference that is not real.
 */
export const plainNumber = (value: number, path = 'value'): number => {
  if (!Number.isFinite(value)) {
    throw new PlainDataError({ path, reason: Number.isNaN(value) ? 'NaN' : 'Infinity' });
  }
  return value === 0 ? 0 : value;
};

/** Object.is-style deep equality over plain data, ignoring key order. Used by round-trip tests. */
export const plainDeepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => plainDeepEqual(item, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;
  return leftKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(rightRecord, key) && plainDeepEqual(leftRecord[key], rightRecord[key])
  ));
};

/**
 * A save must survive IndexedDB's structured clone unchanged. Plain data is a stronger rule than
 * structured-clone safety, so this asserts both: the value is plain, the clone succeeds, and the
 * clone is deeply equal to the original.
 */
export const assertStructuredCloneSafe = (value: unknown, rootPath = '$'): void => {
  assertPlainData(value, rootPath);
  let clone: unknown;
  try {
    clone = structuredClone(value);
  } catch (error) {
    throw new PlainDataError({
      path: rootPath,
      reason: `structuredClone rejected the value: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (!plainDeepEqual(value, clone)) {
    throw new PlainDataError({ path: rootPath, reason: 'structuredClone changed the value' });
  }
};

/**
 * How every own property of a runtime object is accounted for. The field-coverage guard test feeds
 * live instances and these lists to auditOwnProperties, so a field added to a simulation later
 * fails a test until someone decides whether it belongs in the save.
 */
export interface PropertyAccounting {
  /** Own properties whose value is written into the owner's serialized state. */
  serialized: readonly string[];
  /** Caches and views rebuilt on restore (name the rebuild in the design table). */
  derived: readonly string[];
  /** Injected collaborators, rules and constants: restore targets are built with the same ones. */
  config: readonly string[];
  /** Telemetry, listeners and event buffers that are empty at a tick boundary. */
  transient: readonly string[];
  /** Properties that legitimately may be absent at runtime (lazily defined). */
  optional?: readonly string[];
}

/**
 * Returns human-readable problems; an empty array means every own property is accounted for
 * exactly once and no allowlist entry is stale. TypeScript `private` fields are ordinary own
 * properties and are seen; ECMAScript `#private` fields are invisible to this walk, so simulation
 * classes must not use them.
 */
export const auditOwnProperties = (subject: object, accounting: PropertyAccounting): string[] => {
  const problems: string[] = [];
  const categories: Array<[string, readonly string[]]> = [
    ['serialized', accounting.serialized],
    ['derived', accounting.derived],
    ['config', accounting.config],
    ['transient', accounting.transient],
  ];
  const seen = new Map<string, string>();
  for (const [category, names] of categories) {
    for (const name of names) {
      const previous = seen.get(name);
      if (previous !== undefined) problems.push(`'${name}' is listed as both ${previous} and ${category}`);
      else seen.set(name, category);
    }
  }
  const optional = new Set(accounting.optional ?? []);
  const present = new Set(Object.getOwnPropertyNames(subject));
  for (const name of [...present].sort()) {
    if (!seen.has(name)) {
      problems.push(`'${name}' is neither serialized nor in the derived/config/transient allowlist`);
    }
  }
  for (const name of [...seen.keys()].sort()) {
    if (!present.has(name) && !optional.has(name)) {
      problems.push(`'${name}' is allowlisted but is not an own property any more (stale entry)`);
    }
  }
  return problems;
};
