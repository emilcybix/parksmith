import { Container, Graphics } from 'pixi.js';
import type { ViewFrame, ViewRotation } from '../../viewRotation';

/**
 * Test support for the overlay classes: imported by the *.test.ts files only (never by the renderer).
 */

/** Every number a Graphics recorded in its paths (vertices), and every stroke width, in drawing order. */
export const recordedGeometry = (root: Container): { coordinates: number[]; widths: number[] } => {
  const coordinates: number[] = [];
  const widths: number[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'number') coordinates.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  const visit = (node: Container): void => {
    if (node instanceof Graphics) {
      for (const instruction of node.context.instructions) {
        const data = instruction.data as { path?: { instructions: { data: unknown }[] }; style?: { width?: number } };
        if (data.path) for (const step of data.path.instructions) collect(step.data);
        if (instruction.action === 'stroke' && data.style?.width !== undefined) widths.push(data.style.width);
      }
    }
    node.children.forEach((child) => visit(child as Container));
  };
  visit(root);
  return { coordinates, widths };
};

/** The same numbers, sorted, for comparisons that must not depend on the order cells were drawn in. */
export const sortedNumbers = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

/** A view frame of an odd-sized world, so a turn is not symmetric. */
export const viewFrameOf = (rotation: ViewRotation, width: number, height: number): ViewFrame => ({ rotation, width, height });
