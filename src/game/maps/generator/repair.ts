import { GAME_CONFIG } from '../../config';
import { GROUND_BASE, GROUND_WATER } from '../types';
import { CELLS, SIZE, clearedArea, indexOf, isClearable, openArea, removeProp, type DraftProp, type MapDraft } from './draft';

/**
 * The bounded repair pass (Phase 24 step 2). It guarantees the two area targets and can never loop:
 *
 * - R1 (open area) and R2 (cleared area, then any land stranded behind permanent props and water) are `for` loops of
 *   at most `maxCarves` iterations. Each iteration joins one
 *   component that is cut off from the gate to the gate's component through a cheapest corridor, so the number of
 *   unconnected components drops by at least one, and repair only ever REMOVES props and turns water into land, so
 *   the count of props plus water cells never grows. R1 ends as soon as its target is met, R2 once its target is met
 *   and no land is stranded; both end at the cap or when no component is left to join.
 * - R3 is straight-line code that runs at most once: it flattens the core band (18 lanes wide, containing the apron
 *   lanes, depth 0..22, which is 414 open cells, 4-connected, containing the gate, hence >= 400 open) and, if the
 *   cleared area is still short, removes every permanent prop and all water (cleared area becomes the whole map).
 * - Removing props can never break a chunk, weight or count cap; the apron and halo are never touched.
 */

export interface RepairTargets { readonly open: number; readonly cleared: number }
export interface RepairStep {
  readonly phase: 'r1' | 'r2' | 'r3';
  /** Components (of the view) not connected to the gate, before and after the step. */
  readonly detachedBefore: number;
  readonly detachedAfter: number;
  /** Props plus water cells, before and after (never grows). */
  readonly obstaclesBefore: number;
  readonly obstaclesAfter: number;
}
export interface RepairSteps { readonly r1: number; readonly r2: number; readonly r3: 0 | 1 }

type View = 'open' | 'cleared';

const obstacleCount = (draft: MapDraft): number => {
  let water = 0;
  for (let index = 0; index < CELLS; index += 1) if (draft.ground[index] === GROUND_WATER) water += 1;
  return water + draft.count;
};

const blockedIn = (draft: MapDraft, index: number, view: View): boolean => {
  if (draft.ground[index] === GROUND_WATER) return true;
  const owner = draft.occupancy[index];
  if (owner === 0) return false;
  return view === 'open' ? true : !isClearable(draft.props[owner - 1] as DraftProp);
};

const neighboursOf = (index: number): number[] => {
  const x = index % SIZE;
  const y = (index - x) / SIZE;
  const out: number[] = [];
  if (x > 0) out.push(index - 1);
  if (x < SIZE - 1) out.push(index + 1);
  if (y > 0) out.push(index - SIZE);
  if (y < SIZE - 1) out.push(index + SIZE);
  return out;
};

/** Component labels of the unblocked cells (-1 = blocked), plus the cell count and first cell of each label. */
const components = (draft: MapDraft, view: View): { label: Int32Array; sizes: number[]; firsts: number[] } => {
  const label = new Int32Array(CELLS).fill(-1);
  const sizes: number[] = [];
  const firsts: number[] = [];
  for (let start = 0; start < CELLS; start += 1) {
    if (label[start] !== -1 || blockedIn(draft, start, view)) continue;
    const id = sizes.length;
    sizes.push(0);
    firsts.push(start);
    const stack = [start];
    label[start] = id;
    while (stack.length > 0) {
      const index = stack.pop() as number;
      sizes[id] += 1;
      for (const next of neighboursOf(index)) {
        if (label[next] === -1 && !blockedIn(draft, next, view)) {
          label[next] = id;
          stack.push(next);
        }
      }
    }
  }
  return { label, sizes, firsts };
};

const cellCost = (draft: MapDraft, index: number, view: View, allowWater: boolean): number => {
  if (draft.ground[index] === GROUND_WATER) return allowWater ? (view === 'open' ? 6 : 3) : -1;
  const owner = draft.occupancy[index];
  if (owner === 0) return 0;
  const clearable = isClearable(draft.props[owner - 1] as DraftProp);
  if (view === 'open') return clearable ? 1 : 4;
  return clearable ? 0 : 1;
};

/** Dial's algorithm from every cell of the gate component to the nearest cell of `target`; the cell path or null. */
const cheapestPath = (draft: MapDraft, view: View, labels: Int32Array, gateLabel: number, targetLabel: number, allowWater: boolean): number[] | null => {
  const distance = new Int32Array(CELLS).fill(-1);
  const parent = new Int32Array(CELLS).fill(-1);
  const buckets: number[][] = [[]];
  for (let index = 0; index < CELLS; index += 1) {
    if (labels[index] === gateLabel) {
      distance[index] = 0;
      buckets[0].push(index);
    }
  }
  const limit = 6 * CELLS;
  for (let d = 0; d <= limit; d += 1) {
    const bucket = buckets[d];
    if (!bucket) continue;
    for (let at = 0; at < bucket.length; at += 1) {
      const index = bucket[at];
      if (distance[index] !== d) continue;
      if (labels[index] === targetLabel) {
        const path: number[] = [];
        for (let cursor = index; cursor !== -1 && distance[cursor] !== 0; cursor = parent[cursor]) path.push(cursor);
        return path;
      }
      for (const next of neighboursOf(index)) {
        const cost = cellCost(draft, next, view, allowWater);
        if (cost < 0) continue;
        const candidate = d + cost;
        if (distance[next] !== -1 && distance[next] <= candidate) continue;
        distance[next] = candidate;
        parent[next] = index;
        (buckets[candidate] ??= []).push(next);
      }
    }
  }
  return null;
};

/** Joins the largest detached component to the gate; false when there is none to join. */
const carve = (draft: MapDraft, view: View): boolean => {
  const { label, sizes, firsts } = components(draft, view);
  const gateLabel = label[indexOf(draft.gate.x, draft.gate.y)];
  if (gateLabel === -1) return false;
  let target = -1;
  for (let id = 0; id < sizes.length; id += 1) {
    if (id === gateLabel) continue;
    if (target === -1 || sizes[id] > sizes[target] || (sizes[id] === sizes[target] && firsts[id] < firsts[target])) target = id;
  }
  if (target === -1) return false;
  const path = cheapestPath(draft, view, label, gateLabel, target, false) ?? cheapestPath(draft, view, label, gateLabel, target, true);
  if (path === null) return false;
  for (const index of path) {
    if (draft.ground[index] === GROUND_WATER) draft.ground[index] = GROUND_BASE;
    const owner = draft.occupancy[index];
    if (owner !== 0) {
      const prop = draft.props[owner - 1] as DraftProp;
      if (view === 'open' || !isClearable(prop)) removeProp(draft, owner - 1);
    }
  }
  return true;
};

const detached = (draft: MapDraft, view: View): number => {
  const { label, sizes } = components(draft, view);
  const gateLabel = label[indexOf(draft.gate.x, draft.gate.y)];
  return sizes.length - (gateLabel === -1 ? 0 : 1);
};

const flattenCoreBand = (draft: MapDraft): void => {
  const { gate, frame } = draft;
  const lateralAxisIsX = frame.right.x !== 0;
  const gateAlong = lateralAxisIsX ? gate.x : gate.y;
  const start = Math.min(Math.max(gateAlong - 8, 0), SIZE - 18);
  for (let lane = start; lane < start + 18; lane += 1) {
    for (let d = 0; d <= 22; d += 1) {
      // Depth runs along the facing vector from the gate; lanes are absolute positions along the border.
      const x = lateralAxisIsX ? lane : gate.x + frame.forward.x * d;
      const y = lateralAxisIsX ? gate.y + frame.forward.y * d : lane;
      const index = indexOf(x, y);
      if (draft.ground[index] === GROUND_WATER) draft.ground[index] = GROUND_BASE;
      const owner = draft.occupancy[index];
      if (owner !== 0) removeProp(draft, owner - 1);
    }
  }
};

export const repairDraft = (draft: MapDraft, targets: RepairTargets): { draft: MapDraft; steps: RepairSteps; log: RepairStep[] } => {
  const log: RepairStep[] = [];
  const record = (phase: RepairStep['phase'], view: View, act: () => void): void => {
    const detachedBefore = detached(draft, view);
    const obstaclesBefore = obstacleCount(draft);
    act();
    log.push({ phase, detachedBefore, detachedAfter: detached(draft, view), obstaclesBefore, obstaclesAfter: obstacleCount(draft) });
  };
  const { maxCarves } = GAME_CONFIG.maps.generator;
  let r1 = 0;
  let r2 = 0;
  let r3: 0 | 1 = 0;
  let stuck = false;
  for (let iteration = 0; iteration < maxCarves && openArea(draft) < targets.open; iteration += 1) {
    let carved = false;
    record('r1', 'open', () => { carved = carve(draft, 'open'); });
    if (!carved) { log.pop(); stuck = true; break; }
    r1 += 1;
  }
  // R2 also joins land that is walled off for ever (permanent props and water only), even once the target is met:
  // a stone-wall line meeting a stream must not strand a third of the map. Same cap, same "one component per carve".
  for (let iteration = 0; iteration < maxCarves && (clearedArea(draft) < targets.cleared || detached(draft, 'cleared') > 0); iteration += 1) {
    let carved = false;
    record('r2', 'cleared', () => { carved = carve(draft, 'cleared'); });
    if (!carved) {
      log.pop();
      if (clearedArea(draft) < targets.cleared) stuck = true;
      break;
    }
    r2 += 1;
  }
  if (stuck || openArea(draft) < targets.open || clearedArea(draft) < targets.cleared) {
    const detachedBefore = detached(draft, 'open');
    const obstaclesBefore = obstacleCount(draft);
    flattenCoreBand(draft);
    if (clearedArea(draft) < targets.cleared) {
      for (let index = 0; index < draft.props.length; index += 1) {
        const prop = draft.props[index];
        if (prop && !isClearable(prop)) removeProp(draft, index);
      }
      for (let index = 0; index < CELLS; index += 1) if (draft.ground[index] === GROUND_WATER) draft.ground[index] = GROUND_BASE;
    }
    r3 = 1;
    log.push({ phase: 'r3', detachedBefore, detachedAfter: detached(draft, 'open'), obstaclesBefore, obstaclesAfter: obstacleCount(draft) });
  }
  return { draft, steps: { r1, r2, r3 }, log };
};
