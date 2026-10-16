import { Graphics } from 'pixi.js';
import type { PropKindDefinition, PropKindId } from '../game/maps/props';
import { TILE_HEIGHT, TILE_WIDTH } from './isometric';

/**
 * Classic art of the natural props of a map (Phase 24): deliberately simple vector shapes, one pooled Graphics per
 * prop, drawn once when the prop appears (and again only when a 2x1 prop's axis flips on a view turn). Nothing here
 * runs per frame. Colours come from the kind (`color`, `accent`); the voxel blueprints use the same two.
 *
 * Local coordinates: (0, 0) is the middle of the footprint at ground level, x to the right, y down, so art rises
 * into negative y. A footprint of `w` by `d` view cells has its corners at +-(w/2) ex +- (d/2) ey where
 * ex = (32, 16) (one cell along the view x axis) and ey = (-32, 16) (one cell along the view y axis).
 */

const HALF_W = TILE_WIDTH / 2;
const HALF_H = TILE_HEIGHT / 2;
const OUTLINE = 0x315c54;

const channel = (rgb: number, shift: number): number => (rgb >> shift) & 0xff;

/** `rgb` scaled towards black (factor < 1) or white (factor > 1). */
export const shade = (rgb: number, factor: number): number => {
  const scale = (value: number): number => Math.max(0, Math.min(255, Math.round(factor <= 1 ? value * factor : value + (255 - value) * (factor - 1))));
  return (scale(channel(rgb, 16)) << 16) | (scale(channel(rgb, 8)) << 8) | scale(channel(rgb, 0));
};

type Pen = Graphics;

const shadow = (g: Pen, rx: number, ry: number): void => {
  g.ellipse(0, 1, rx, ry).fill({ color: 0x1f3d34, alpha: 0.2 });
};

/** A vertical-sided prism over a w x d view-cell footprint, `height` px tall, top face inset by `inset` (0..1 of the half extent). */
const prism = (g: Pen, w: number, d: number, height: number, top: number, side: number, inset = 0, lift = 0): void => {
  const ax = HALF_W * w;
  const ay = HALF_H * w;
  const bx = HALF_W * d;
  const by = HALF_H * d;
  // Corners of the footprint (a along ex, b along ey), halved: left = (-a, +b), right = (+a, -b), bottom = (+a, +b), back = (-a, -b).
  const left = { x: -ax / 2 - bx / 2, y: -ay / 2 + by / 2 - lift };
  const right = { x: ax / 2 + bx / 2, y: ay / 2 - by / 2 - lift };
  const bottom = { x: ax / 2 - bx / 2, y: ay / 2 + by / 2 - lift };
  const back = { x: -ax / 2 + bx / 2, y: -ay / 2 - by / 2 - lift };
  const k = 1 - inset;
  const mix = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x * k, y: (p.y + lift) * k - lift });
  const t = [mix(back), mix(right), mix(bottom), mix(left)].map((p) => ({ x: p.x, y: p.y - height }));
  const b = [left, bottom, right];
  // left (south-west) face, right (south-east) face, then the top.
  g.poly([b[0].x, b[0].y, b[1].x, b[1].y, t[2].x, t[2].y, t[3].x, t[3].y]).fill(shade(side, 0.82)).stroke({ color: OUTLINE, alpha: 0.5, width: 1 });
  g.poly([b[1].x, b[1].y, b[2].x, b[2].y, t[1].x, t[1].y, t[2].x, t[2].y]).fill(shade(side, 0.68)).stroke({ color: OUTLINE, alpha: 0.5, width: 1 });
  g.poly([t[0].x, t[0].y, t[1].x, t[1].y, t[2].x, t[2].y, t[3].x, t[3].y]).fill(top).stroke({ color: OUTLINE, alpha: 0.45, width: 1 });
};

const round = (g: Pen, x: number, y: number, r: number, fill: number): void => {
  g.circle(x, y, r).fill(fill);
  g.circle(x - r * 0.3, y - r * 0.35, r * 0.45).fill({ color: 0xffffff, alpha: 0.18 });
};

const trunk = (g: Pen, color: number, height: number, width = 8): void => {
  g.roundRect(-width / 2, -height, width, height, 3).fill(color);
  g.rect(width / 2 - 2.5, -height + 2, 2.5, height - 2).fill({ color: 0x000000, alpha: 0.14 });
};

const mound = (g: Pen, rx: number, ry: number, color: number, accent: number): void => {
  g.ellipse(0, -ry * 0.55, rx, ry).fill(color);
  g.ellipse(-rx * 0.25, -ry * 0.95, rx * 0.5, ry * 0.45).fill({ color: accent, alpha: 0.75 });
};

const boulder = (g: Pen, rx: number, ry: number, color: number, accent: number, mossy = false): void => {
  shadow(g, rx + 3, rx * 0.42);
  g.poly([-rx, -2, -rx * 0.8, -ry * 1.2, -rx * 0.2, -ry * 1.9, rx * 0.55, -ry * 1.6, rx, -ry * 0.6, rx * 0.85, 0])
    .fill(color).stroke({ color: OUTLINE, alpha: 0.55, width: 1.2 });
  g.poly([-rx * 0.2, -ry * 1.9, rx * 0.55, -ry * 1.6, rx, -ry * 0.6, rx * 0.1, -ry * 0.9]).fill({ color: 0xffffff, alpha: 0.2 });
  g.poly([rx * 0.1, -ry * 0.9, rx, -ry * 0.6, rx * 0.85, 0, rx * 0.05, -1]).fill({ color: 0x000000, alpha: 0.16 });
  if (mossy) g.ellipse(-rx * 0.25, -ry * 1.5, rx * 0.55, ry * 0.32).fill({ color: accent, alpha: 0.9 });
};

const leafTree = (g: Pen, crown: number, accent: number, wood: number, tall = 64): void => {
  shadow(g, 18, 8);
  trunk(g, wood, tall * 0.55);
  round(g, -10, -tall * 0.62, tall * 0.3, crown);
  round(g, 11, -tall * 0.66, tall * 0.28, accent);
  round(g, 0, -tall * 0.9, tall * 0.31, crown);
};

const pine = (g: Pen, leaf: number, snow: number): void => {
  shadow(g, 17, 8);
  trunk(g, 0x79543a, 14, 7);
  for (let tier = 0; tier < 3; tier += 1) {
    const base = -12 - tier * 17;
    const half = 22 - tier * 5;
    g.poly([-half, base, 0, base - 28, half, base]).fill(leaf).stroke({ color: OUTLINE, alpha: 0.4, width: 1 });
    g.poly([-half * 0.55, base - 12, 0, base - 28, half * 0.55, base - 12, half * 0.2, base - 8, -half * 0.25, base - 11]).fill(snow);
  }
};

const palm = (g: Pen, trunkColor: number, leaf: number): void => {
  shadow(g, 16, 7);
  g.moveTo(0, 0).quadraticCurveTo(10, -30, 4, -62).stroke({ color: trunkColor, width: 7, cap: 'round' });
  g.moveTo(0, 0).quadraticCurveTo(10, -30, 4, -62).stroke({ color: shade(trunkColor, 0.8), width: 2, alpha: 0.5 });
  const top = { x: 4, y: -62 };
  for (const [dx, dy] of [[-30, -10], [-18, -26], [8, -30], [30, -12], [22, 2], [-24, 4]] as const) {
    g.moveTo(top.x, top.y).quadraticCurveTo(top.x + dx * 0.5, top.y - 16 + dy * 0.2, top.x + dx, top.y + dy * 0.55)
      .stroke({ color: leaf, width: 6, cap: 'round' });
  }
  round(g, top.x, top.y + 2, 5, shade(trunkColor, 0.85));
};

const saguaro = (g: Pen, body: number, bloom: number): void => {
  shadow(g, 14, 6);
  g.roundRect(-6, -54, 12, 54, 6).fill(body).stroke({ color: OUTLINE, alpha: 0.4, width: 1 });
  g.roundRect(-18, -36, 7, 20, 3.5).fill(body);
  g.roundRect(-18, -22, 18, 7, 3.5).fill(body);
  g.roundRect(11, -42, 7, 26, 3.5).fill(body);
  g.roundRect(0, -26, 18, 7, 3.5).fill(body);
  g.rect(1, -52, 2, 50).fill({ color: 0xffffff, alpha: 0.18 });
  g.circle(0, -56, 3.2).fill(bloom);
};

const barrel = (g: Pen, body: number, bloom: number): void => {
  shadow(g, 14, 6);
  g.ellipse(0, -10, 13, 12).fill(body).stroke({ color: OUTLINE, alpha: 0.4, width: 1 });
  for (const x of [-7, 0, 7]) g.moveTo(x, -2).lineTo(x * 0.5, -21).stroke({ color: shade(body, 0.7), width: 1.4 });
  g.circle(0, -22, 3.5).fill(bloom);
};

const tuft = (g: Pen, leaf: number, accent: number, blades = 7): void => {
  for (let i = 0; i < blades; i += 1) {
    const x = (i - (blades - 1) / 2) * 3.6;
    const tip = -16 - ((i * 5) % 9);
    g.moveTo(x, 0).quadraticCurveTo(x + (i % 2 === 0 ? -5 : 5), tip * 0.55, x * 1.6, tip).stroke({ color: i % 3 === 0 ? accent : leaf, width: 3, cap: 'round' });
  }
};

const fern = (g: Pen, leaf: number, light: number): void => {
  for (let i = 0; i < 6; i += 1) {
    const angle = -Math.PI * 0.9 + i * (Math.PI * 0.36);
    g.moveTo(0, -2).quadraticCurveTo(Math.cos(angle) * 12, -12 + Math.sin(angle) * 14, Math.cos(angle) * 24, -6 + Math.sin(angle) * 22)
      .stroke({ color: i % 2 === 0 ? leaf : light, width: 4, cap: 'round' });
  }
};

const bloomPlant = (g: Pen, leaf: number, petal: number, centre: number): void => {
  tuft(g, leaf, leaf, 5);
  for (const [x, y] of [[-9, -22], [8, -26], [0, -34]] as const) {
    g.moveTo(x * 0.3, -6).lineTo(x, y + 4).stroke({ color: leaf, width: 2 });
    for (let i = 0; i < 5; i += 1) g.circle(x + Math.cos(i * 1.26) * 4.2, y + Math.sin(i * 1.26) * 4.2, 3).fill(petal);
    g.circle(x, y, 2.4).fill(centre);
  }
};

const pumpkins = (g: Pen, orange: number, leaf: number): void => {
  shadow(g, 20, 8);
  for (const [x, y, r] of [[-9, -7, 8], [9, -8, 9], [0, -15, 7]] as const) {
    g.ellipse(x, y, r, r * 0.82).fill(orange).stroke({ color: shade(orange, 0.7), width: 1 });
    g.moveTo(x, y - r * 0.8).lineTo(x, y - r * 1.3).stroke({ color: leaf, width: 2.4 });
  }
};

const toadstools = (g: Pen, cap: number, dots: number): void => {
  for (const [x, y, r] of [[-8, -2, 8], [8, -3, 6], [0, -10, 9]] as const) {
    g.roundRect(x - r * 0.28, y - r * 0.9, r * 0.56, r * 0.9, 2).fill(0xf4ead3);
    g.ellipse(x, y - r * 0.95, r, r * 0.72).fill(cap).stroke({ color: shade(cap, 0.7), width: 1 });
    g.circle(x - r * 0.3, y - r * 1.05, r * 0.16).fill(dots);
    g.circle(x + r * 0.34, y - r * 0.9, r * 0.13).fill(dots);
  }
};

const snowman = (g: Pen, body: number, nose: number): void => {
  shadow(g, 14, 6);
  g.circle(0, -11, 12).fill(body).stroke({ color: 0xaac4d6, width: 1 });
  g.circle(0, -29, 9).fill(body).stroke({ color: 0xaac4d6, width: 1 });
  g.circle(0, -43, 7).fill(body).stroke({ color: 0xaac4d6, width: 1 });
  g.circle(-2.6, -44.5, 1.1).fill(0x2a3a44);
  g.circle(2.6, -44.5, 1.1).fill(0x2a3a44);
  g.poly([0, -43, 8, -41.5, 0, -40]).fill(nose);
  g.rect(-5, -52, 10, 4).fill(0x2f4858);
  g.rect(-8, -49, 16, 2).fill(0x2f4858);
};

/** A lying log along the view axis: `along` 0 = view x (down-right), 1 = view y (down-left). */
const log = (g: Pen, wood: number, accent: number, along: 0 | 1): void => {
  const dir = along === 0 ? 1 : -1;
  const half = { x: HALF_W * 0.92 * dir, y: HALF_H * 0.92 };
  shadow(g, 40, 11);
  g.moveTo(-half.x, -half.y - 7).lineTo(half.x, half.y - 7).stroke({ color: shade(wood, 0.72), width: 15, cap: 'round' });
  g.moveTo(-half.x, -half.y - 9).lineTo(half.x, half.y - 9).stroke({ color: wood, width: 11, cap: 'round' });
  g.moveTo(-half.x * 0.6, -half.y * 0.6 - 15).lineTo(half.x * 0.5, half.y * 0.5 - 15).stroke({ color: accent, width: 4, cap: 'round', alpha: 0.9 });
  g.ellipse(half.x, half.y - 8, 4.5, 6.5).fill(shade(wood, 1.35)).stroke({ color: shade(wood, 0.6), width: 1 });
};

const stoneWall = (g: Pen, stone: number, moss: number): void => {
  shadow(g, 26, 10);
  prism(g, 1, 1, 22, shade(stone, 1.08), stone, 0.06);
  g.moveTo(-14, -7).lineTo(2, 1).stroke({ color: shade(stone, 0.6), width: 1, alpha: 0.7 });
  g.moveTo(2, -11).lineTo(16, -3).stroke({ color: shade(stone, 0.6), width: 1, alpha: 0.7 });
  g.ellipse(-4, -22, 9, 4).fill({ color: moss, alpha: 0.9 });
};

const WALL_TOP_HEIGHT = 58;

const art = (g: Pen, kind: PropKindDefinition, along: 0 | 1): void => {
  const c = kind.color;
  const a = kind.accent;
  switch (kind.id as PropKindId) {
    case 'oak-tree': return leafTree(g, c, shade(c, 1.12), a);
    case 'great-oak':
      shadow(g, 52, 22);
      trunk(g, a, 52, 16);
      round(g, -26, -62, 28, c);
      round(g, 28, -66, 26, shade(c, 1.15));
      round(g, 0, -86, 32, c);
      round(g, -8, -60, 26, shade(c, 0.92));
      return;
    case 'shrub':
      shadow(g, 18, 7);
      round(g, -8, -9, 10, c);
      round(g, 8, -9, 10, shade(c, 1.12));
      round(g, 0, -15, 11, c);
      g.circle(-7, -13, 2.4).fill(a);
      g.circle(6, -17, 2.4).fill(a);
      g.circle(2, -8, 2.4).fill(a);
      return;
    case 'meadow-boulder': return boulder(g, 20, 14, c, a, true);
    case 'mossy-log': return log(g, c, a, along);
    case 'palm-tree': return palm(g, c, a);
    case 'dune-grass': return tuft(g, c, a);
    case 'driftwood': return log(g, c, a, along);
    case 'sea-stack':
      shadow(g, 52, 22);
      prism(g, 2, 2, 58, shade(c, 1.1), c, 0.22);
      g.ellipse(0, -62, 24, 9).fill({ color: a, alpha: 0.9 });
      g.ellipse(-8, -66, 12, 5).fill({ color: a, alpha: 0.7 });
      return;
    case 'tide-rock':
      boulder(g, 17, 10, c, a);
      g.ellipse(-3, -4, 9, 2.6).fill({ color: 0xffffff, alpha: 0.4 });
      return;
    case 'boardwalk-pier': {
      // A flat timber deck standing in the water: a thin slab with plank seams and two posts at the front corners.
      shadow(g, 30, 11);
      prism(g, 1, 1, 7, shade(c, 1.08), c, 0.04, 2);
      for (const t of [-0.5, 0, 0.5]) g.moveTo(-HALF_W * 0.5 + t * HALF_W * 0.5 - 6, -9 + t * HALF_H * 0.7 + 3).lineTo(t * HALF_W * 0.5 + 6, -9 + t * HALF_H * 0.7 + 12).stroke({ color: shade(c, 0.7), width: 1, alpha: 0.7 });
      g.rect(-HALF_W * 0.5 - 2, -4, 4, 10).fill(a);
      g.rect(HALF_W * 0.5 - 2, -4, 4, 10).fill(a);
      return;
    }
    case 'saguaro': return saguaro(g, c, a);
    case 'barrel-cactus': return barrel(g, c, a);
    case 'red-boulder': return boulder(g, 22, 17, c, a);
    case 'canyon-wall':
      shadow(g, 34, 14);
      prism(g, 1, 1, WALL_TOP_HEIGHT, shade(c, 1.1), c, 0.04);
      for (const y of [-14, -28, -42]) g.moveTo(-31, y + 2).lineTo(0, y + 18).lineTo(31, y + 2).stroke({ color: a, width: 3, alpha: 0.7 });
      return;
    case 'rock-spire':
      shadow(g, 56, 24);
      prism(g, 2, 2, 28, shade(a, 1.1), a, 0.08);
      prism(g, 2, 2, 34, shade(c, 1.1), c, 0.34, 28);
      prism(g, 2, 2, 28, shade(c, 1.18), c, 0.62, 62);
      return;
    case 'snowy-pine': return pine(g, c, a);
    case 'snow-drift':
      mound(g, 24, 11, c, a);
      g.ellipse(10, -4, 14, 5).fill({ color: a, alpha: 0.7 });
      return;
    case 'snowman': return snowman(g, c, a);
    case 'granite-boulder': return boulder(g, 21, 14, c, a, true);
    case 'glacier-rock':
      shadow(g, 56, 24);
      prism(g, 2, 2, 24, shade(c, 1.15), c, 0.05);
      prism(g, 2, 2, 34, shade(c, 1.25), shade(c, 0.95), 0.4, 24);
      g.poly([-34, -14, -14, -58, 6, -14]).fill({ color: 0xffffff, alpha: 0.28 });
      return;
    case 'kapok-tree':
      shadow(g, 22, 9);
      g.poly([-10, 0, -3, -44, 3, -44, 10, 0]).fill(a).stroke({ color: shade(a, 0.7), width: 1 });
      round(g, -12, -62, 20, c);
      round(g, 14, -64, 19, shade(c, 1.18));
      round(g, 0, -80, 21, c);
      return;
    case 'fern': return fern(g, c, a);
    case 'jungle-bloom': return bloomPlant(g, shade(kind.colors[0] ?? 0x2e8b4a, 1), c, a);
    case 'mossy-rock': return boulder(g, 18, 12, c, a, true);
    case 'temple-ruin':
      shadow(g, 60, 26);
      prism(g, 2, 2, 12, shade(c, 1.08), c, 0.02);
      prism(g, 2, 2, 30, shade(c, 1.05), shade(c, 0.95), 0.3, 12);
      g.ellipse(0, -43, 20, 7).fill({ color: a, alpha: 0.9 });
      g.roundRect(8, -30, 12, 24, 5).fill({ color: 0x23423a, alpha: 0.7 });
      return;
    case 'maple-tree': return leafTree(g, c, a, 0x79543a);
    case 'golden-birch':
      shadow(g, 17, 8);
      g.roundRect(-4, -40, 8, 40, 3).fill(a);
      for (const y of [-8, -17, -26, -34]) g.rect(-4, y, 8, 2.2).fill(0x4a4036);
      round(g, -8, -52, 18, c);
      round(g, 10, -56, 16, shade(c, 1.12));
      round(g, 0, -70, 17, c);
      return;
    case 'pumpkin-patch': return pumpkins(g, c, a);
    case 'toadstools': return toadstools(g, c, a);
    case 'fallen-log': return log(g, c, a, along);
    case 'stone-wall': return stoneWall(g, c, a);
    default:
      // A kind added to the data before it has art: a plain block in its colours (never an empty tile).
      shadow(g, 20, 8);
      prism(g, kind.footprint[0], kind.footprint[1], 24, shade(c, 1.1), c, 0.1);
  }
};

/**
 * The art of one prop into `g` (cleared first, so a 2x1 prop can be redrawn when a view turn flips its axis).
 * `along` is which VIEW axis the prop's long side lies along: 0 = view x (down-right on screen), 1 = view y.
 */
export const drawPropArt = (g: Graphics, kind: PropKindDefinition, along: 0 | 1): Graphics => {
  g.clear();
  art(g, kind, along);
  return g;
};

/** Whether a kind's art depends on the view axis (only the 2x1 kinds do; everything else is drawn once). */
export const propArtIsOriented = (kind: PropKindDefinition): boolean => kind.footprint[0] !== kind.footprint[1];
