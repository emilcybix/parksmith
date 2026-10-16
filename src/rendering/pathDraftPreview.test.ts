import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../game/content/catalog';
import { ParkSession } from '../game/session/ParkSession';
import { PREVIEW_FILL_INVALID, PREVIEW_FILL_VALID } from './previewFill';
import { VoxelOverlays } from './voxel/overlay/overlays';
import { WorldRenderer } from './WorldRenderer';

/**
 * Phase 37: the path draft's blocked cells are drawn red and the rest in the normal colour, in both renderers, and
 * a view turn (voxel setView / classic rotation) keeps the split.
 */

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

const path = BUILD_BY_ID.get('sunstone-path')!;
const draft = [{ x: 10, y: 10 }, { x: 10, y: 11 }, { x: 10, y: 12 }, { x: 10, y: 13 }];
const blocked = [{ x: 10, y: 12 }];
const count = (fills: number[], colour: number): number => fills.filter((fill) => fill === colour).length;

describe('Phase 37: blocked path draft cells', () => {
  it('voxel overlay: one red diamond for the blocked cell, mint for the rest, kept through a redraw', () => {
    const session = new ParkSession(null);
    const root = new Container();
    const overlays = new VoxelOverlays(root, () => session);
    overlays.drawPreview(draft, path, true, false, blocked);
    let fills = fillsOf(root);
    expect(count(fills, PREVIEW_FILL_INVALID)).toBe(1);
    expect(count(fills, PREVIEW_FILL_VALID)).toBe(3);
    overlays.drawPreview(draft, path, true, false);
    fills = fillsOf(root);
    expect(count(fills, PREVIEW_FILL_INVALID), 'no blocked list: all one colour').toBe(0);
  });

  it('classic renderer: the same split', () => {
    const session = new ParkSession(null);
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    renderer.drawPreview(draft, path, true, false, 0, null, blocked);
    const layer = (renderer as unknown as { previewLayer: Container }).previewLayer;
    const fills = fillsOf(layer);
    expect(count(fills, PREVIEW_FILL_INVALID)).toBe(1);
    expect(count(fills, PREVIEW_FILL_VALID)).toBe(3);
  });
});
