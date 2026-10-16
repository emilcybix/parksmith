import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ParkSession } from '../../../game/session/ParkSession';
import { BULLDOZE_FILL_ALPHA, VoxelOverlays } from './overlays';

/**
 * Phase 24 render review: the bulldozer's in-world preview over a prop. GameApp.hoverBulldoze passes `valid = check.ok`
 * (false for a permanent canyon wall or a clear the park cannot afford), but the overlay picks the fill from `bulldoze`
 * alone (0xff5f70 whatever `valid` says), and so does the classic WorldRenderer: a boulder the player can clear for $180,
 * one they cannot afford and a wall that can never be cleared got the same red diamond. Only the cursor readout told them
 * apart. FIXED: both renderers take the fill from rendering/previewFill.ts, which draws a refused clear in slate.
 */

const fillAlphasOf = (root: Container): number[] => {
  const alphas: number[] = [];
  const visit = (node: Container): void => {
    if (node instanceof Graphics) {
      for (const instruction of node.context.instructions) {
        if (instruction.action !== 'fill') continue;
        const style = (instruction.data as { style?: { alpha?: number } }).style;
        if (style?.alpha !== undefined) alphas.push(style.alpha);
      }
    }
    node.children.forEach((child) => visit(child as Container));
  };
  visit(root);
  return alphas;
};

const fillsOf = (root: Container): number[] => {
  const colours: number[] = [];
  const visit = (node: Container): void => {
    if (node instanceof Graphics) {
      for (const instruction of node.context.instructions) {
        if (instruction.action !== 'fill') continue;
        const style = (instruction.data as { style?: { color?: number } }).style;
        if (style?.color !== undefined) colours.push(style.color);
      }
    }
    node.children.forEach((child) => visit(child as Container));
  };
  visit(root);
  return colours;
};

describe('Phase 24 render review: bulldozer preview over obstacles (voxel overlay)', () => {
  it('a refused clear (permanent prop, or not enough cash) is drawn differently from a clear that will happen', () => {
    const session = new ParkSession(null, [], { mapId: 'red-rock-canyon' });
    const wall = [...session.world.props.values()].find((prop) => prop.kind === 'canyon-wall')!;
    const cells = session.world.propFootprint(wall);

    const okRoot = new Container();
    new VoxelOverlays(okRoot, () => session).drawPreview(cells, null, true, true);
    const refusedRoot = new Container();
    new VoxelOverlays(refusedRoot, () => session).drawPreview(cells, null, false, true);

    expect(fillsOf(okRoot).length).toBeGreaterThan(0);
    expect(fillsOf(refusedRoot)).not.toEqual(fillsOf(okRoot));
  });

  it('Phase 36: a clear that will happen fills at 6/8 (the 4/8 dither read as no fill over a coaster), a refused one keeps 4/8', () => {
    const session = new ParkSession(null, [], { mapId: 'red-rock-canyon' });
    const wall = [...session.world.props.values()].find((prop) => prop.kind === 'canyon-wall')!;
    const cells = session.world.propFootprint(wall);
    const okRoot = new Container();
    new VoxelOverlays(okRoot, () => session).drawPreview(cells, null, true, true);
    const refusedRoot = new Container();
    new VoxelOverlays(refusedRoot, () => session).drawPreview(cells, null, false, true);
    const buildRoot = new Container();
    new VoxelOverlays(buildRoot, () => session).drawPreview(cells, null, true, false);
    expect(BULLDOZE_FILL_ALPHA).toBe(6 / 8);
    expect(new Set(fillAlphasOf(okRoot))).toEqual(new Set([6 / 8]));
    expect(new Set(fillAlphasOf(refusedRoot))).toEqual(new Set([0.5]));
    expect(new Set(fillAlphasOf(buildRoot))).toEqual(new Set([0.5]));
  });
});
