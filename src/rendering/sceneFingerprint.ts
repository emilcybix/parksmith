import { Container, Graphics } from 'pixi.js';

/**
 * Test utility (imported only by tests, so it never reaches a bundle).
 *
 * Turns a piece of the Pixi scene graph into a comparable string: transforms, visibility and the
 * actual recorded drawing instructions, but not textures or matrices, which carry object identity
 * rather than shape. Two scenes with the same fingerprint draw the same picture.
 *
 * This exists for one reason: `WorldRenderer.syncWorld()` is incremental, and incremental caches
 * fail silently. The fingerprint lets a test assert that mutating a park step by step converges on
 * exactly the scene a from-scratch rebuild would have produced.
 */
const round = (value: number): number => Math.round(value * 1_000) / 1_000;

/** Keeps the numbers that describe a shape and drops everything that describes an object. */
const numeric = (value: unknown): string => {
  if (typeof value === 'number') return String(round(value));
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '_';
  if (Array.isArray(value)) return `[${value.map(numeric).join(',')}]`;
  return '';
};

interface PathStep { action: string; data?: unknown }
interface FillStyle { color?: number; alpha?: number; width?: number }
interface Instruction {
  action: string;
  data?: { style?: FillStyle; path?: { instructions?: PathStep[] } };
}

const fingerprintGraphics = (graphic: Graphics): string => {
  const context = (graphic as unknown as { context: { instructions: Instruction[] } }).context;
  return context.instructions.map((instruction) => {
    const style = instruction.data?.style ?? {};
    const styleKey = [style.color, style.alpha, style.width].map(numeric).join('/');
    const pathKey = (instruction.data?.path?.instructions ?? [])
      .map((step) => `${step.action}(${numeric(step.data)})`)
      .join(';');
    return `${instruction.action}{${styleKey}}[${pathKey}]`;
  }).join('|');
};

export const fingerprintNode = (node: Container): string => {
  const head = [
    node.constructor.name,
    round(node.x),
    round(node.y),
    round(node.rotation),
    round(node.scale.x),
    round(node.scale.y),
    round(node.alpha),
    node.visible ? 'v' : 'h',
    node.zIndex,
  ].join(',');
  const own = node instanceof Graphics ? fingerprintGraphics(node) : '';
  // Children are compared in order, which is safe within one display: only the top-level layer
  // order differs between incremental and from-scratch builds, and the caller sorts that.
  const children = node.children.map(fingerprintNode).join('~');
  return `${head}<${own}>(${children})`;
};
