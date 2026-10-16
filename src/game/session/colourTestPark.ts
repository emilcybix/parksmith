/**
 * Test support (like coaster/testLayouts.ts): the "colour test park" of Phase 28 step 2. It is the developer
 * park plus what that park lacks so every newly colourable kind is on the map: a Comet Trail (crosses the
 * x = 8 chunk border), a Skyline Serpent with a loop and a boost (crosses x = 24) in the empty north strip,
 * and a Ripple Fountain in the empty east strip. Pure game API, deterministic; the ids it gets in a fresh
 * sandbox park are 67, 68 and 69. Renderer and UI tests build their fixtures from it so they can be compared
 * with the step-2 baseline captures. Never imported by game code.
 */
import { COASTER_TYPE_BY_ID } from '../coaster/content';
import { coasterBaseCost, deriveCoasterStats, validateCoasterLayout, type CoasterPiece } from '../coaster/design';
import type { ParkSession } from './ParkSession';
import { seedDevPark } from './devPark';

const walk = (
  start: { x: number; y: number },
  moves: string,
  heights: readonly number[],
  specials: Readonly<Record<number, CoasterPiece['special']>> = {},
): CoasterPiece[] => {
  const pieces: CoasterPiece[] = [];
  let x = start.x;
  let y = start.y;
  for (let index = 0; index < moves.length; index += 1) {
    const special = specials[index];
    pieces.push({ cell: { x, y }, height: heights[index] ?? 0, ...(special ? { special } : {}) });
    const move = moves[index];
    if (move === 'E') x += 1; else if (move === 'W') x -= 1; else if (move === 'S') y += 1; else y -= 1;
  }
  return pieces;
};

const EXTRA_COASTERS: readonly { definitionId: string; pieces: CoasterPiece[] }[] = [
  { definitionId: 'comet-trail', pieces: walk({ x: 2, y: 4 }, 'EEENENEESSSWWWWWWN', [0, 0, 0, 1, 2, 2, 2, 1, 1, 2, 2, 2, 1, 1, 0, 0, 0, 0]) },
  { definitionId: 'skyline-serpent', pieces: walk({ x: 18, y: 4 }, 'EEEEEEENNNWWWWWWWSSS', [0, 0, 0, 1, 2, 3, 4, 4, 4, 3, 2, 2, 2, 1, 1, 0, 0, 0, 0, 0], { 5: 'boost', 11: 'loop' }) },
];

const FOUNTAIN_ANCHOR = { x: 27, y: 8 } as const;

export interface ColourTestParkReport {
  /** Everything that did not fit or validate: empty in a healthy layout. */
  problems: string[];
  cometTrailId: number;
  serpentId: number;
  fountainId: number;
}

/** Seeds the dev park and the extras into a fresh ParkSession (a sandbox). Returns the ids of the extras. */
export const seedColourTestPark = (session: ParkSession): ColourTestParkReport => {
  const problems = [...seedDevPark(session).skipped];
  const { world } = session;
  const ids = { 'comet-trail': 0, 'skyline-serpent': 0 } as Record<string, number>;
  // The Skyline Serpent is research-locked in a fresh sandbox: lift the lock for the placement only.
  const policy = (world as unknown as { buildAccessPolicy: Parameters<typeof world.setBuildAccessPolicy>[0] }).buildAccessPolicy;
  world.setBuildAccessPolicy(null);
  for (const { definitionId, pieces } of EXTRA_COASTERS) {
    const type = COASTER_TYPE_BY_ID.get(definitionId);
    if (!type) { problems.push(`${definitionId}: no type`); continue; }
    const check = validateCoasterLayout(pieces, type);
    if (!check.ok) { problems.push(`${definitionId}: ${JSON.stringify(check)}`); continue; }
    const result = world.placeCoaster(type.definitionId, pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
    if ('error' in result) problems.push(`${definitionId}: ${result.error}`);
    else ids[definitionId] = result.id;
  }
  world.setBuildAccessPolicy(policy);
  const fountain = world.seedScenarioObject('ripple-fountain', FOUNTAIN_ANCHOR, 0);
  if (!fountain) problems.push(`ripple-fountain@${FOUNTAIN_ANCHOR.x},${FOUNTAIN_ANCHOR.y}`);
  session.syncWithWorld();
  return {
    problems,
    cometTrailId: ids['comet-trail'],
    serpentId: ids['skyline-serpent'],
    fountainId: fountain ? fountain.id : 0,
  };
};
