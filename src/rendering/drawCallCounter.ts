import { Graphics } from 'pixi.js';

/**
 * Test utility (imported only by tests, so it never reaches a bundle).
 *
 * Recording a path is cheap; Pixi re-tessellating and re-uploading it during the render pass is
 * not, and on a throttled CPU that cost dominates. Counting the drawing calls is how both render
 * budgets in this folder are expressed: zero for a steady-state frame, a proportional ceiling for
 * a construction frame.
 */
const DRAW_METHODS = [
  'clear',
  'fill',
  'stroke',
  'poly',
  'circle',
  'ellipse',
  'roundRect',
  'rect',
  'moveTo',
  'lineTo',
  'arc',
  'quadraticCurveTo',
] as const;

export const countGraphicsDrawCalls = (run: () => void): number => {
  const prototype = Graphics.prototype as unknown as Record<string, (...args: never[]) => unknown>;
  const originals = DRAW_METHODS.map((name) => [name, prototype[name]] as const);
  let calls = 0;
  for (const [name, original] of originals) {
    prototype[name] = function patched(this: Graphics, ...args: never[]): unknown {
      calls += 1;
      return original.apply(this, args);
    };
  }
  try {
    run();
  } finally {
    for (const [name, original] of originals) prototype[name] = original;
  }
  return calls;
};
