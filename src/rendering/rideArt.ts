import { Container, Graphics } from 'pixi.js';
import type { ObjectColours } from '../game/content/colours';
import { ridePaintFor, type RidePaint } from './classicPaint';
import type { RideStatus } from '../game/rides/types';
import type { BuildDefinition, Rotation } from '../game/types';
import { alongFootprint, cellPoint, groundPlate, loopOutline } from './isoPlot';
import { createBandSet, createSegment, stretchSegment } from './parts';

/**
 * Per-frame animation input for one placed ride. `spin` only advances while the machine is
 * actually turning, so a ride that stops and restarts continues from where it stood instead
 * of snapping. `progress` is the cycle position for rides whose vehicles make one trip
 * (towers, trains, boats) rather than looping endlessly.
 */
export interface RideMotion {
  /** Monotonic accumulator in motion-weighted milliseconds. */
  spin: number;
  /** Smoothed 0..1: 0 stopped, ~0.15 loading, 1 at full speed. */
  motion: number;
  /** 0..1 through the current ride cycle, 0 whenever the ride is not running. */
  progress: number;
  /** Wall-clock milliseconds, for effects that keep living while the ride stands still. */
  elapsedMs: number;
  status: RideStatus;
}

export interface RideArt {
  container: Container;
  animate(state: RideMotion): void;
}

export { DEFAULT_RIDE_PAINT, linkedTone, ridePaintFor } from './classicPaint';
export type { RidePaint } from './classicPaint';

/** Label on the container holding a ride's ground-level vehicles. */
export const VEHICLE_LAYER = 'vehicles';

const GROUND_SQUASH = 0.5;
const STEEL = 0x2c5b64;
const STEEL_LIGHT = 0x4d7f86;
const TIMBER = 0x79543a;
const CONCRETE = 0x9fb2ae;
const WATER = 0x2b6f8e;
const SHADOW = 0x1f4a44;

/** A point on a circle lying flat on the ground, in the isometric squash. */
const orbit = (angle: number, radius: number): { x: number; y: number } => ({
  x: Math.cos(angle) * radius,
  y: Math.sin(angle) * radius * GROUND_SQUASH,
});

// Where a water ride's boats climb, coast, and fall, as fractions of one lap.
const LIFT_START = 0.08;
const LIFT_TOP = 0.3;
const DROP_START = 0.52;
const DROP_END = 0.62;
const LIFT_HEIGHT = 26;

/** Positive means nearer the camera, which is exactly the sort order we want. */
const depthOf = (angle: number): number => Math.sin(angle);

const groundPad = (graphic: Graphics, radius: number): void => {
  graphic.ellipse(0, -2, radius, radius * GROUND_SQUASH).fill({ color: SHADOW, alpha: 0.16 });
};

/** A stepped operating platform: dark skirt, lighter deck, alternating floor wedges. */
const platter = (
  graphic: Graphics,
  radius: number,
  deckY: number,
  skirt: number,
  deck: number,
): void => {
  graphic.ellipse(0, deckY + 6, radius, radius * GROUND_SQUASH).fill(skirt);
  graphic.ellipse(0, deckY, radius, radius * GROUND_SQUASH)
    .fill(deck)
    .stroke({ color: 0xffffff, alpha: 0.28, width: 2 });
  for (let index = 0; index < 12; index += 2) {
    const from = index * Math.PI / 6;
    const to = from + Math.PI / 6;
    graphic.poly([
      0, deckY,
      Math.cos(from) * radius, deckY + Math.sin(from) * radius * GROUND_SQUASH,
      Math.cos(to) * radius, deckY + Math.sin(to) * radius * GROUND_SQUASH,
    ]).fill({ color: 0xffffff, alpha: 0.1 });
  }
};

/** A lattice mast of the given height with cross braces, drawn from the ground up. */
const lattice = (graphic: Graphics, height: number, halfWidth: number): void => {
  graphic.roundRect(-halfWidth - 2, -height, 5, height, 2).fill(STEEL);
  graphic.roundRect(halfWidth - 3, -height, 5, height, 2).fill(STEEL);
  const rungs = Math.floor(height / 11);
  for (let index = 0; index < rungs; index += 1) {
    const top = -height + index * 11;
    graphic.moveTo(-halfWidth, top + 11).lineTo(halfWidth, top)
      .moveTo(-halfWidth, top).lineTo(halfWidth, top + 11)
      .stroke({ color: STEEL_LIGHT, width: 1.6, alpha: 0.9 });
  }
};

/** A scalloped canopy cone: striped wedges from an apex down to a squashed rim. */
const canopyCone = (
  graphic: Graphics,
  apexY: number,
  rimY: number,
  radius: number,
  color: number,
  accent: number,
  bulbs = true,
): void => {
  const rimSquash = radius * 0.42;
  for (let index = 0; index < 12; index += 1) {
    const from = index * Math.PI / 6;
    const to = from + Math.PI / 6;
    graphic.poly([
      0, apexY,
      Math.cos(from) * radius, rimY + Math.sin(from) * rimSquash,
      Math.cos(to) * radius, rimY + Math.sin(to) * rimSquash,
    ]).fill(index % 2 ? color : accent);
  }
  graphic.ellipse(0, rimY, radius, rimSquash).stroke({ color: 0xffffff, alpha: 0.45, width: 2 });
  if (!bulbs) return;
  for (let index = 0; index < 16; index += 1) {
    const angle = index * Math.PI / 8;
    graphic.circle(Math.cos(angle) * radius, rimY + Math.sin(angle) * rimSquash, 3).fill(0xfff3d0);
  }
};

const seatedRider = (graphic: Graphics, x: number, y: number, shirt: number): void => {
  graphic.roundRect(x - 3, y - 6, 6, 7, 2.5).fill(shirt);
  graphic.circle(x, y - 8.5, 2.8).fill(0xffd3a6).stroke({ color: 0x315c54, width: 0.8 });
};

// --- Petal Roundabout ------------------------------------------------------

const createPetalRoundabout = (definition: BuildDefinition, paint: RidePaint): RideArt => {
  const primary = paint('primary', definition.color);
  const secondary = paint('secondary', definition.accent);
  const container = new Container();
  const structure = new Graphics();
  groundPad(structure, 68);
  platter(structure, 58, -12, 0x35635f, 0x4a7f78);
  structure.roundRect(-7, -76, 14, 66, 5).fill(STEEL);
  structure.roundRect(-3, -76, 4, 66, 2).fill({ color: 0xffffff, alpha: 0.2 });
  container.addChild(structure);

  const arms = new Container();
  container.addChild(arms);
  const armSegments = Array.from({ length: 6 }, () => {
    const segment = createSegment(STEEL_LIGHT, 2.4);
    arms.addChild(segment);
    return segment;
  });

  const seats = new Container();
  seats.sortableChildren = true;
  container.addChild(seats);
  const gondolas = Array.from({ length: 6 }, (_unused, index) => {
    const graphic = new Graphics();
    graphic.ellipse(0, 3, 12, 4.5).fill({ color: SHADOW, alpha: 0.2 });
    graphic.moveTo(-13, -2).quadraticCurveTo(0, -24, 13, -2).quadraticCurveTo(0, 7, -13, -2)
      .fill(index % 2 ? primary : secondary)
      .stroke({ color: 0xffffff, alpha: 0.75, width: 1.6 });
    seatedRider(graphic, -3, -4, 0x3f7f9c);
    seatedRider(graphic, 4, -4, 0xd96f8f);
    const holder = new Container();
    holder.addChild(graphic);
    seats.addChild(holder);
    return holder;
  });

  const canopy = new Graphics();
  canopyCone(canopy, -100, -84, 56, primary, secondary);
  canopy.circle(0, -102, 6).fill(secondary).stroke({ color: 0xffffff, width: 2 });
  container.addChild(canopy);

  return {
    container,
    animate: ({ spin, motion }) => {
      const base = spin * 0.0011;
      for (const [index, gondola] of gondolas.entries()) {
        const angle = base + index * Math.PI / 3;
        const point = orbit(angle, 44);
        const depth = depthOf(angle);
        const lift = -28 - motion * 6 + Math.sin(angle * 2) * 2;
        gondola.position.set(point.x, point.y + lift);
        gondola.zIndex = Math.round(depth * 100);
        gondola.scale.set(0.9 + depth * 0.12);
        gondola.rotation = -Math.cos(angle) * motion * 0.2;
        stretchSegment(armSegments[index], 0, -70, point.x * 0.96, point.y + lift - 12);
      }
    },
  };
};

// --- Comet Cups ------------------------------------------------------------

const createCometCups = (definition: BuildDefinition, paint: RidePaint): RideArt => {
  const primary = paint('primary', definition.color);
  const secondary = paint('secondary', definition.accent);
  const container = new Container();
  const structure = new Graphics();
  groundPad(structure, 68);
  platter(structure, 60, -10, paint.tone('primary', 0x3a3560, definition.color), paint.tone('primary', 0x574d8c, definition.color));
  structure.ellipse(0, -14, 18, 9).fill(STEEL).stroke({ color: 0xffffff, alpha: 0.25, width: 1.5 });
  container.addChild(structure);

  const platters = new Container();
  platters.sortableChildren = true;
  container.addChild(platters);

  const groups = Array.from({ length: 3 }, () => {
    const holder = new Container();
    holder.sortableChildren = true;
    const disc = new Graphics();
    disc.ellipse(0, 2, 22, 11).fill({ color: SHADOW, alpha: 0.18 });
    disc.ellipse(0, -3, 21, 10).fill(paint.tone('primary', 0x6f61a8, definition.color)).stroke({ color: 0xffffff, alpha: 0.3, width: 1.4 });
    disc.zIndex = -200;
    holder.addChild(disc);
    const cups = Array.from({ length: 2 }, (_unused, index) => {
      const cup = new Container();
      const graphic = new Graphics();
      graphic.ellipse(0, 1, 11, 4.5).fill({ color: SHADOW, alpha: 0.22 });
      graphic.moveTo(-10, -14).quadraticCurveTo(-8, -1, 0, -1).quadraticCurveTo(8, -1, 10, -14)
        .fill(index ? secondary : primary)
        .stroke({ color: 0xffffff, alpha: 0.7, width: 1.4 });
      graphic.ellipse(0, -14, 10, 4).fill({ color: 0xffffff, alpha: 0.35 });
      // The handle is what sells the spin: it sweeps around the rim as the cup turns.
      graphic.circle(11, -10, 4).stroke({ color: 0xffffff, alpha: 0.85, width: 2 });
      seatedRider(graphic, -2, -12, 0xf0a24b);
      cup.addChild(graphic);
      holder.addChild(cup);
      return cup;
    });
    platters.addChild(holder);
    return { holder, cups };
  });

  return {
    container,
    animate: ({ spin, motion }) => {
      const floor = spin * 0.0009;
      for (const [index, group] of groups.entries()) {
        const angle = floor + index * Math.PI * 2 / 3;
        const point = orbit(angle, 34);
        const depth = depthOf(angle);
        group.holder.position.set(point.x, point.y - 16);
        group.holder.zIndex = Math.round(depth * 100);
        group.holder.scale.set(0.92 + depth * 0.1);
        for (const [cupIndex, cup] of group.cups.entries()) {
          const local = -spin * 0.0034 + cupIndex * Math.PI;
          const seat = orbit(local, 12);
          cup.position.set(seat.x, seat.y - 4);
          cup.zIndex = Math.round(depthOf(local) * 10);
          // Squashing across the spin axis fakes the cup turning on its own pin.
          cup.scale.x = 0.82 + Math.abs(Math.cos(local * 1.5)) * 0.24;
          cup.rotation = Math.sin(local) * motion * 0.16;
        }
      }
    },
  };
};

// --- Tiki Tumbler (Phase 22, profile-gated) ---------------------------------

/**
 * Carved tiki tubs spinning around a thatched totem. Primary is the thatched canopy, the deck skirt and half the tubs;
 * secondary the totem finial, the turntable rim and the other tubs (the slot table in game/content/colours.ts).
 */
const createTikiTumbler = (definition: BuildDefinition, paint: RidePaint): RideArt => {
  const primary = paint('primary', definition.color);
  const secondary = paint('secondary', definition.accent);
  const container = new Container();
  const structure = new Graphics();
  groundPad(structure, 66);
  platter(structure, 58, -10, paint.tone('primary', 0x7a3f2b, definition.color), paint.tone('primary', 0x9a5238, definition.color));
  structure.ellipse(0, -11, 58, 29).stroke({ color: secondary, width: 3 });
  // The totem: a carved post under a thatched cap with a finial.
  structure.roundRect(-7, -66, 14, 56, 4).fill(TIMBER).stroke({ color: 0xffffff, alpha: 0.25, width: 1.2 });
  structure.rect(-4, -56, 8, 5).fill(0x3a2a22);
  structure.rect(-4, -44, 8, 5).fill(0x3a2a22);
  structure.moveTo(-22, -62).lineTo(0, -88).lineTo(22, -62).closePath().fill(primary).stroke({ color: 0xffffff, alpha: 0.4, width: 1.4 });
  structure.circle(0, -90, 4).fill(secondary);
  container.addChild(structure);

  const tubs = new Container();
  tubs.sortableChildren = true;
  container.addChild(tubs);
  const holders = Array.from({ length: 4 }, (_unused, index) => {
    const holder = new Container();
    const graphic = new Graphics();
    graphic.ellipse(0, 1, 12, 5).fill({ color: SHADOW, alpha: 0.22 });
    graphic.moveTo(-11, -15).quadraticCurveTo(-9, -1, 0, -1).quadraticCurveTo(9, -1, 11, -15)
      .fill(index % 2 ? secondary : primary)
      .stroke({ color: 0xffffff, alpha: 0.7, width: 1.4 });
    graphic.ellipse(0, -15, 11, 4.2).fill({ color: 0xffffff, alpha: 0.35 });
    seatedRider(graphic, -1, -13, 0xf0a24b);
    holder.addChild(graphic);
    tubs.addChild(holder);
    return holder;
  });

  return {
    container,
    animate: ({ spin, motion }) => {
      const base = spin * 0.001;
      for (const [index, holder] of holders.entries()) {
        const angle = base + index * Math.PI / 2;
        const point = orbit(angle, 38);
        holder.position.set(point.x, point.y - 14);
        holder.zIndex = Math.round(depthOf(angle) * 100);
        holder.scale.set(0.94 + depthOf(angle) * 0.1);
        // The tub turns on its own pin as it goes round.
        holder.rotation = Math.sin(spin * 0.0031 + index) * motion * 0.14;
      }
    },
  };
};

// --- Cloud Hopper ----------------------------------------------------------

const createCloudHopper = (definition: BuildDefinition, paint: RidePaint): RideArt => {
  const primary = paint('primary', definition.color);
  const secondary = paint('secondary', definition.accent);
  const container = new Container();
  const structure = new Graphics();
  groundPad(structure, 54);
  structure.ellipse(0, -8, 44, 22).fill(0x35635f).stroke({ color: 0xffffff, alpha: 0.25, width: 2 });
  structure.roundRect(-40, -30, 22, 22, 4).fill(0x2f5d63).stroke({ color: 0xffffff, alpha: 0.35, width: 1.5 });
  structure.rect(-36, -24, 14, 4).fill(secondary);
  lattice(structure, 118, 11);
  structure.roundRect(-16, -126, 32, 10, 4).fill(STEEL).stroke({ color: 0xffffff, alpha: 0.3, width: 1.5 });
  container.addChild(structure);

  const car = new Container();
  const carArt = new Graphics();
  carArt.roundRect(-26, -12, 52, 12, 5).fill(primary).stroke({ color: 0xffffff, alpha: 0.8, width: 2 });
  carArt.roundRect(-26, -4, 52, 4, 2).fill({ color: 0x143c40, alpha: 0.55 });
  for (const x of [-19, -7, 7, 19]) {
    carArt.roundRect(x - 5, -22, 10, 11, 3).fill(0x1f4a52);
    seatedRider(carArt, x, -12, x < 0 ? 0x6fd1c0 : 0xffd166);
  }
  car.addChild(carArt);
  container.addChild(car);

  const beaconCore = new Graphics();
  beaconCore.circle(0, -132, 6).fill(definition.accent); // a lamp: its glow stays fixed
  const beaconHalo = new Graphics();
  beaconHalo.circle(0, -132, 11).fill(definition.accent);
  container.addChild(beaconHalo, beaconCore);

  const topOfTravel = -104;

  return {
    container,
    animate: ({ progress, motion, elapsedMs }) => {
      // One cycle: hold, winch up, hang at the top, then a fast drop with a short rebound.
      let height = 0;
      if (progress > 0.06 && progress <= 0.5) {
        const climb = (progress - 0.06) / 0.44;
        height = climb * climb * (3 - 2 * climb);
      } else if (progress > 0.5 && progress <= 0.62) {
        height = 1;
      } else if (progress > 0.62 && progress <= 0.72) {
        const fall = (progress - 0.62) / 0.1;
        height = 1 - fall * fall * fall;
      } else if (progress > 0.72 && progress <= 0.82) {
        height = Math.abs(Math.sin((progress - 0.72) / 0.1 * Math.PI)) * 0.14;
      }
      car.position.y = topOfTravel * height - 6;
      car.scale.y = 1 + Math.max(0, height - 0.72) * 0.05;
      const pulse = 0.35 + Math.abs(Math.sin(elapsedMs * 0.004)) * 0.65 * (0.3 + motion * 0.7);
      beaconCore.alpha = pulse;
      beaconHalo.alpha = pulse * 0.25;
    },
  };
};

// --- Aurora Wheel ----------------------------------------------------------

const createAuroraWheel = (definition: BuildDefinition, paint: RidePaint): RideArt => {
  const primary = paint('primary', definition.color);
  const secondary = paint('secondary', definition.accent);
  const container = new Container();
  const hubY = -70;
  const radius = 52;
  const cabinCount = 12;

  const structure = new Graphics();
  groundPad(structure, 76);
  structure.ellipse(0, -6, 66, 33).fill({ color: 0x2f5d63, alpha: 0.85 });
  for (const side of [-1, 1]) {
    structure.moveTo(side * 44, -2).lineTo(side * 9, hubY).lineTo(side * 26, -2).closePath()
      .fill({ color: STEEL, alpha: 0.95 });
    structure.moveTo(side * 39, -22).lineTo(side * 19, -22).stroke({ color: STEEL_LIGHT, width: 3 });
    structure.roundRect(side * 44 - 8, -6, 16, 7, 3).fill(0x1d454c);
  }
  container.addChild(structure);

  const wheel = new Container();
  wheel.position.set(0, hubY);
  const rim = new Graphics();
  rim.circle(0, 0, radius).stroke({ color: primary, width: 6 });
  rim.circle(0, 0, radius - 9).stroke({ color: primary, alpha: 0.6, width: 3 });
  for (let index = 0; index < cabinCount; index += 1) {
    const angle = index * Math.PI * 2 / cabinCount;
    rim.moveTo(0, 0).lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius)
      .stroke({ color: secondary, width: 2 });
  }
  for (let index = 0; index < cabinCount * 2; index += 1) {
    const angle = index * Math.PI / cabinCount;
    rim.circle(Math.cos(angle) * (radius - 4.5), Math.sin(angle) * (radius - 4.5), 2.4)
      .fill(0xfff3d0);
  }
  rim.circle(0, 0, 9).fill(STEEL).stroke({ color: 0xffffff, alpha: 0.6, width: 2 });
  wheel.addChild(rim);
  container.addChild(wheel);

  const cabins = new Container();
  cabins.position.set(0, hubY);
  container.addChild(cabins);
  const gondolas = Array.from({ length: cabinCount }, (_unused, index) => {
    const holder = new Container();
    const graphic = new Graphics();
    graphic.moveTo(0, -9).lineTo(0, -2).stroke({ color: STEEL_LIGHT, width: 2 });
    graphic.roundRect(-8, -2, 16, 12, 4)
      .fill(index % 2 ? secondary : paint('trim', 0xfff3d0))
      .stroke({ color: STEEL, width: 1.5 });
    graphic.roundRect(-5.5, 0.5, 11, 5, 2).fill({ color: 0x143c40, alpha: 0.55 });
    graphic.roundRect(-8, -4, 16, 3, 1.5).fill(primary);
    holder.addChild(graphic);
    cabins.addChild(holder);
    return holder;
  });

  return {
    container,
    animate: ({ spin, motion }) => {
      const rotation = spin * 0.00045;
      wheel.rotation = rotation;
      for (const [index, gondola] of gondolas.entries()) {
        const angle = rotation + index * Math.PI * 2 / cabinCount;
        gondola.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius);
        // Cabins hang level however far the wheel has turned, with a little sway under load.
        gondola.rotation = Math.sin(spin * 0.003 + index) * 0.07 * motion;
      }
    },
  };
};

// --- Moonpetal Carousel ----------------------------------------------------

const createMoonpetalCarousel = (definition: BuildDefinition, paint: RidePaint): RideArt => {
  const primary = paint('primary', definition.color);
  const secondary = paint('secondary', definition.accent);
  const container = new Container();
  const structure = new Graphics();
  groundPad(structure, 66);
  platter(structure, 58, -12, paint.tone('primary', 0x6d3f61, definition.color), paint.tone('primary', 0x9a5f88, definition.color));
  container.addChild(structure);

  const drumBase = new Graphics();
  drumBase.roundRect(-17, -70, 34, 58, 6).fill(paint.tone('primary', 0x7c4a6d, definition.color));
  container.addChild(drumBase);
  const drum = new Container();
  container.addChild(drum);
  // Mirrored panels on the centre drum, rotating with the platform.
  const drumBands = createBandSet(drum, -12, 58, 16, 8, paint.tone('primary', 0xf6d4e6, definition.color));

  const poles = new Container();
  container.addChild(poles);
  const poleSegments = Array.from({ length: 6 }, () => {
    const segment = createSegment(paint('trim', 0xf3c969), 2.2);
    poles.addChild(segment);
    return segment;
  });

  const mounts = new Container();
  mounts.sortableChildren = true;
  container.addChild(mounts);
  const horses = Array.from({ length: 6 }, (_unused, index) => {
    const holder = new Container();
    const graphic = new Graphics();
    graphic.ellipse(0, 4, 12, 4).fill({ color: SHADOW, alpha: 0.18 });
    // A side-profile pony: barrel, neck, head, four legs, tail, saddle.
    graphic.roundRect(-10, -14, 20, 11, 5).fill(0xfff3e2).stroke({ color: 0xd9b69c, width: 1.2 });
    graphic.moveTo(6, -12).lineTo(13, -22).lineTo(17, -20).lineTo(11, -8).closePath().fill(0xfff3e2);
    graphic.circle(15, -21, 3.6).fill(0xfff3e2).stroke({ color: 0xd9b69c, width: 1 });
    graphic.circle(16.5, -21.5, 1).fill(0x3b2b2b);
    for (const x of [-7, -2, 4, 8]) {
      graphic.roundRect(x - 1.4, -5, 2.8, 8, 1.4).fill(0xfff3e2).stroke({ color: 0xd9b69c, width: 0.8 });
    }
    graphic.moveTo(-10, -12).quadraticCurveTo(-17, -8, -14, 0).stroke({ color: paint('trim', definition.accent), width: 3 });
    graphic.roundRect(-4, -16, 9, 5, 2).fill(index % 2 ? primary : 0x7c5cc4);
    graphic.moveTo(9, -18).quadraticCurveTo(3, -24, -2, -18).stroke({ color: paint('trim', definition.accent), width: 2 });
    holder.addChild(graphic);
    mounts.addChild(holder);
    return holder;
  });

  const roof = new Graphics();
  canopyCone(roof, -116, -92, 60, primary, secondary);
  roof.circle(0, -120, 7).fill(paint('trim', definition.accent)).stroke({ color: 0xffffff, width: 2 });
  roof.moveTo(0, -127).lineTo(14, -122).lineTo(0, -117).closePath().fill(paint('primary', definition.accent));
  container.addChild(roof);

  return {
    container,
    animate: ({ spin, motion }) => {
      drumBands.update(spin * 0.0008);
      const base = spin * 0.0008;
      for (const [index, horse] of horses.entries()) {
        const angle = base + index * Math.PI / 3;
        const point = orbit(angle, 42);
        const depth = depthOf(angle);
        const bob = Math.sin(spin * 0.0055 + index * 1.7) * 6 * (0.35 + motion * 0.65);
        const y = point.y - 26 + bob;
        horse.position.set(point.x, y);
        horse.zIndex = Math.round(depth * 100);
        // Ponies face the way they travel, so the far side of the platform turns the other way.
        const size = 0.92 + depth * 0.1;
        horse.scale.set(-Math.sin(angle) >= 0 ? size : -size, size);
        stretchSegment(poleSegments[index], point.x, y - 30, point.x, y + 4);
      }
    },
  };
};

// --- Bumble Coach ----------------------------------------------------------

const createBumbleCoach = (definition: BuildDefinition, rotation: Rotation, paint: RidePaint): RideArt => {
  const primary = paint('primary', definition.color);
  const secondary = paint('secondary', definition.accent);
  const container = new Container();
  // The oval is laid out in GRID cells, not screen pixels, so it runs along the plot's own
  // long axis and stays inside the 4x2 footprint however the ride is rotated.
  const [longAxis, shortAxis] = alongFootprint(rotation, 1.3, 0.5);
  const [halfWidth, halfDepth] = alongFootprint(rotation, 2, 1);
  const trackPoint = (angle: number): { x: number; y: number } =>
    cellPoint(Math.cos(angle) * longAxis, Math.sin(angle) * shortAxis);

  const structure = new Graphics();
  groundPlate(structure, halfWidth, halfDepth, 0x7fbf7a, 0.9);
  structure.poly(loopOutline(longAxis, shortAxis), true).stroke({ color: CONCRETE, width: 11 });
  structure.poly(loopOutline(longAxis, shortAxis), true).stroke({ color: 0x6f6053, width: 1.6 });
  for (let index = 0; index < 24; index += 1) {
    const angle = index * Math.PI * 2 / 24;
    const inner = cellPoint(Math.cos(angle) * longAxis * 0.9, Math.sin(angle) * shortAxis * 0.9);
    const outer = cellPoint(Math.cos(angle) * longAxis * 1.1, Math.sin(angle) * shortAxis * 1.1);
    structure.moveTo(inner.x, inner.y).lineTo(outer.x, outer.y)
      .stroke({ color: TIMBER, width: 2, alpha: 0.65 });
  }
  container.addChild(structure);

  const lawn = new Graphics();
  lawn.ellipse(0, 0, 20, 10).fill(0x6fae6a);
  lawn.roundRect(-3, -36, 6, 34, 3).fill(TIMBER);
  lawn.circle(-8, -42, 12).fill(0x3f8f5c);
  lawn.circle(7, -45, 11).fill(0x4fa96b);
  lawn.circle(0, -55, 10).fill(0x5cb977);
  container.addChild(lawn);

  // The platform sits on the near side of the loop, where guests would step aboard.
  const boarding = trackPoint(Math.atan2(shortAxis, longAxis));
  const station = new Graphics();
  station.roundRect(-22, -5, 44, 10, 4).fill(CONCRETE).stroke({ color: 0xffffff, alpha: 0.4, width: 1.5 });
  station.roundRect(-19, -28, 3, 24, 1.5).fill(STEEL);
  station.roundRect(16, -28, 3, 24, 1.5).fill(STEEL);
  station.roundRect(-24, -35, 48, 9, 4).fill(primary).stroke({ color: 0x2b2d42, width: 1.5 });
  for (let index = 0; index < 4; index += 1) {
    station.rect(-24 + index * 12, -35, 6, 9).fill({ color: 0xfff0c8, alpha: 0.55 });
  }
  station.position.set(boarding.x, boarding.y + 9);
  container.addChild(station);

  const cars = new Container();
  // Named so the plot-containment test can pick the ground-level vehicles out of the art.
  cars.label = VEHICLE_LAYER;
  cars.sortableChildren = true;
  container.addChild(cars);
  const couplings = new Container();
  container.addChild(couplings);
  const couplingSegments = Array.from({ length: 2 }, () => {
    const segment = createSegment(0x2b2d42, 2);
    couplings.addChild(segment);
    return segment;
  });
  const train = Array.from({ length: 3 }, (_unused, index) => {
    const holder = new Container();
    const graphic = new Graphics();
    graphic.ellipse(0, 3, 12, 4).fill({ color: SHADOW, alpha: 0.2 });
    if (index === 0) {
      graphic.roundRect(-13, -13, 26, 13, 5).fill(primary).stroke({ color: secondary, width: 1.8 });
      graphic.roundRect(3, -22, 8, 10, 3).fill(secondary);
      graphic.roundRect(-12, -19, 7, 8, 2.5).fill(0x4a4a4a);
      graphic.circle(11, -6, 3.2).fill(0xfff3d0);
    } else {
      graphic.roundRect(-12, -11, 24, 11, 4).fill(secondary).stroke({ color: primary, width: 1.8 });
      graphic.roundRect(-9, -20, 18, 9, 3).fill({ color: primary, alpha: 0.85 });
      seatedRider(graphic, -4, -11, 0x6fd1c0);
      seatedRider(graphic, 5, -11, 0xef6f8f);
    }
    for (const x of [-7, 7]) graphic.circle(x, 0, 3).fill(0x2b2d42).stroke({ color: 0xd9d9d9, width: 1 });
    holder.addChild(graphic);
    cars.addChild(holder);
    return holder;
  });

  const smoke = new Container();
  container.addChild(smoke);
  const puffs = Array.from({ length: 3 }, () => {
    const puff = new Graphics();
    puff.circle(0, 0, 1).fill(0xffffff);
    smoke.addChild(puff);
    return puff;
  });

  return {
    container,
    animate: ({ spin, motion }) => {
      const head = spin * 0.0007;
      let previous: { x: number; y: number } | null = null;
      for (const [index, car] of train.entries()) {
        const angle = head - index * 0.34;
        const point = trackPoint(angle);
        const ahead = trackPoint(angle + 0.05);
        const depth = point.y;
        car.position.set(point.x, point.y);
        car.zIndex = Math.round(depth * 4);
        const size = 0.88 + depth / 70;
        const facing = ahead.x >= point.x ? 1 : -1;
        car.scale.set(size * facing, size);
        // Cars follow the track's slope in screen space; mirrored art needs the opposite sign.
        car.rotation = Math.atan2((ahead.y - point.y) * facing, Math.abs(ahead.x - point.x) || 1e-6) * 0.75;
        if (previous) {
          stretchSegment(couplingSegments[index - 1], previous.x, previous.y - 5, point.x, point.y - 5);
        }
        previous = point;
      }
      smoke.visible = motion >= 0.25;
      if (!smoke.visible) return;
      const stack = train[0].position;
      for (const [index, puff] of puffs.entries()) {
        const age = (spin * 0.0012 + index * 0.34) % 1;
        puff.position.set(stack.x + 6 + age * 5, stack.y - 26 - age * 18);
        puff.scale.set(3 + age * 4);
        puff.alpha = (1 - age) * 0.4 * motion;
      }
    },
  };
};

// --- Harbor Swings ---------------------------------------------------------

const createHarborSwings = (definition: BuildDefinition, paint: RidePaint): RideArt => {
  const primary = paint('primary', definition.color);
  const secondary = paint('secondary', definition.accent);
  const container = new Container();
  const rotorY = -92;

  const structure = new Graphics();
  groundPad(structure, 62);
  platter(structure, 54, -10, 0x2f5d63, 0x3f7f8c);
  structure.roundRect(-36, -30, 20, 20, 4).fill(0x2f5d63).stroke({ color: 0xffffff, alpha: 0.35, width: 1.4 });
  structure.rect(-32, -25, 12, 3).fill(secondary);
  structure.moveTo(-11, -10).lineTo(-6, rotorY + 6).lineTo(6, rotorY + 6).lineTo(11, -10).closePath()
    .fill(STEEL);
  structure.moveTo(-4, -10).lineTo(-2, rotorY + 6).stroke({ color: 0xffffff, alpha: 0.2, width: 3 });
  container.addChild(structure);

  const chains = new Container();
  container.addChild(chains);
  const chainSegments = Array.from({ length: 16 }, () => {
    const segment = createSegment(0xd8e6e4, 1.1, 0.9);
    chains.addChild(segment);
    return segment;
  });

  const rotor = new Container();
  container.addChild(rotor);
  const rotorDisc = new Graphics();
  rotorDisc.ellipse(0, rotorY, 30, 15).fill(0x35707d).stroke({ color: 0xffffff, alpha: 0.3, width: 1.5 });
  rotor.addChild(rotorDisc);
  const rotorBands = createBandSet(rotor, rotorY + 4, 8, 24, 10, secondary);

  const seats = new Container();
  seats.sortableChildren = true;
  container.addChild(seats);
  const chairs = Array.from({ length: 8 }, (_unused, index) => {
    const holder = new Container();
    const graphic = new Graphics();
    graphic.roundRect(-7, -2, 14, 4, 2).fill(index % 2 ? primary : secondary)
      .stroke({ color: 0xffffff, alpha: 0.6, width: 1 });
    graphic.roundRect(-7, -12, 3, 12, 1.5).fill(STEEL_LIGHT);
    graphic.roundRect(4, -12, 3, 12, 1.5).fill(STEEL_LIGHT);
    graphic.roundRect(-6, -14, 12, 4, 2).fill({ color: primary, alpha: 0.8 });
    seatedRider(graphic, 0, -2, 0xffd166);
    holder.addChild(graphic);
    seats.addChild(holder);
    return holder;
  });

  const canopy = new Graphics();
  canopyCone(canopy, -128, -108, 48, primary, paint('trim', 0xfff0c8));
  canopy.circle(0, -132, 5).fill(secondary);
  container.addChild(canopy);

  return {
    container,
    animate: ({ spin, motion }) => {
      const phase = spin * 0.0016;
      rotorBands.update(phase);
      const flyOut = 26 + motion * 30;
      for (const [index, chair] of chairs.entries()) {
        const angle = phase + index * Math.PI / 4;
        const point = orbit(angle, flyOut);
        const depth = depthOf(angle);
        const y = point.y + rotorY + 40 - motion * 14;
        chair.position.set(point.x, y);
        chair.zIndex = Math.round(depth * 100);
        chair.scale.set(0.9 + depth * 0.12);
        // Chairs trail behind the rotor arm, so they lean out further the faster it turns.
        chair.rotation = -Math.cos(angle) * motion * 0.42;
        const anchor = orbit(angle, 24);
        for (const [side, offset] of [-6, 6].entries()) {
          stretchSegment(
            chainSegments[index * 2 + side],
            anchor.x + offset * 0.5,
            anchor.y + rotorY + 2,
            point.x + offset * 0.6,
            y - 13,
          );
        }
      }
    },
  };
};

// --- Splash Rings ----------------------------------------------------------

const createSplashRings = (definition: BuildDefinition, rotation: Rotation, paint: RidePaint): RideArt => {
  const primary = paint('primary', definition.color);
  const secondary = paint('secondary', definition.accent);
  const container = new Container();
  // Cell-space channel: the flume follows the plot's long axis inside the 4x3 footprint.
  const [longAxis, shortAxis] = alongFootprint(rotation, 1.35, 0.92);
  const [halfWidth, halfDepth] = alongFootprint(rotation, 2, 1.5);
  const channelPoint = (angle: number): { x: number; y: number } =>
    cellPoint(Math.cos(angle) * longAxis, Math.sin(angle) * shortAxis);

  const structure = new Graphics();
  groundPlate(structure, halfWidth, halfDepth, 0x8fb6a8, 0.9);
  structure.poly(loopOutline(longAxis, shortAxis), true).stroke({ color: CONCRETE, width: 17 });
  structure.poly(loopOutline(longAxis, shortAxis), true).stroke({ color: WATER, width: 11 });
  for (let index = 0; index < 18; index += 1) {
    const angle = index * Math.PI * 2 / 18;
    const point = channelPoint(angle);
    structure.circle(point.x, point.y, 2).fill({ color: 0xbde0fe, alpha: 0.55 });
  }
  // The lift conveyor climbs one quarter of the loop; the chute drops on the opposite side.
  const liftFrom = channelPoint(LIFT_START * Math.PI * 2);
  const liftTo = channelPoint(LIFT_TOP * Math.PI * 2);
  structure.moveTo(liftFrom.x, liftFrom.y).lineTo(liftTo.x, liftTo.y - LIFT_HEIGHT)
    .stroke({ color: 0xa8bcb6, width: 13 });
  structure.moveTo(liftFrom.x, liftFrom.y).lineTo(liftTo.x, liftTo.y - LIFT_HEIGHT)
    .stroke({ color: 0xffffff, alpha: 0.35, width: 3 });
  const dropFrom = channelPoint(DROP_START * Math.PI * 2);
  const dropTo = channelPoint(DROP_END * Math.PI * 2);
  structure.moveTo(dropFrom.x, dropFrom.y - LIFT_HEIGHT).lineTo(dropTo.x, dropTo.y)
    .stroke({ color: 0xdfeaf2, width: 12 });
  structure.moveTo(dropFrom.x, dropFrom.y - LIFT_HEIGHT).lineTo(dropTo.x, dropTo.y)
    .stroke({ color: 0xffffff, alpha: 0.6, width: 3 });
  structure.roundRect(liftTo.x - 12, liftTo.y - LIFT_HEIGHT - 14, 24, 11, 4)
    .fill(primary).stroke({ color: 0xffffff, alpha: 0.5, width: 1.5 });
  container.addChild(structure);

  const wake = new Container();
  container.addChild(wake);
  // One wake ring and one foam burst per boat, moved instead of redrawn.
  const wakes = Array.from({ length: 4 }, () => {
    const ring = new Graphics();
    ring.ellipse(0, 0, 13, 4).fill({ color: 0xffffff, alpha: 0.3 });
    const burst = new Container();
    const drops = Array.from({ length: 5 }, () => {
      const drop = new Graphics();
      drop.circle(0, 0, 1).fill(0xffffff);
      burst.addChild(drop);
      return drop;
    });
    wake.addChild(ring, burst);
    return { ring, burst, drops };
  });

  const boats = new Container();
  boats.label = VEHICLE_LAYER;
  boats.sortableChildren = true;
  container.addChild(boats);
  const tubes = Array.from({ length: 4 }, (_unused, index) => {
    const holder = new Container();
    const graphic = new Graphics();
    graphic.ellipse(0, 2, 13, 5).fill({ color: 0x123f4c, alpha: 0.25 });
    graphic.ellipse(0, -4, 14, 7).fill(index % 2 ? primary : secondary)
      .stroke({ color: 0xffffff, alpha: 0.8, width: 2 });
    graphic.ellipse(0, -4, 7, 3.4).fill(0x1c5563);
    seatedRider(graphic, -4, -4, 0xffd166);
    seatedRider(graphic, 4, -4, 0xef6f8f);
    holder.addChild(graphic);
    boats.addChild(holder);
    return holder;
  });

  return {
    container,
    animate: ({ spin, motion }) => {
      const head = spin * 0.0006;
      for (const [index, boat] of tubes.entries()) {
        const angle = head + index * Math.PI / 2;
        const lap = ((angle / (Math.PI * 2)) % 1 + 1) % 1;
        // Winched up the conveyor, coasting the high stretch, then falling down the chute.
        let lift = 0;
        if (lap > LIFT_START && lap <= LIFT_TOP) lift = (lap - LIFT_START) / (LIFT_TOP - LIFT_START) * LIFT_HEIGHT;
        else if (lap > LIFT_TOP && lap <= DROP_START) lift = LIFT_HEIGHT;
        else if (lap > DROP_START && lap <= DROP_END) {
          lift = LIFT_HEIGHT * (1 - (lap - DROP_START) / (DROP_END - DROP_START));
        }
        const point = channelPoint(angle);
        const y = point.y - lift;
        boat.position.set(point.x, y + Math.sin(spin * 0.004 + index) * 1.2 * motion);
        boat.zIndex = Math.round(point.y * 4);
        boat.scale.set(0.9 + point.y / 90);
        boat.rotation = Math.sin(spin * 0.005 + index * 2) * 0.09 * motion;
        const trail = wakes[index];
        trail.ring.position.set(point.x, y + 5);
        trail.ring.scale.x = 1 + Math.sin(spin * 0.006 + index) * 0.15;
        trail.ring.alpha = (0.18 + motion * 0.12) / 0.3;
        // Foam bursts right where the chute meets the channel again.
        trail.burst.visible = lap > DROP_END && lap < DROP_END + 0.12;
        if (!trail.burst.visible) continue;
        const burst = (lap - DROP_END) / 0.12;
        for (const [drop, foam] of trail.drops.entries()) {
          const spread = (drop - 2) * 6 * (0.4 + burst);
          foam.position.set(point.x + spread, y + 2 - burst * 11 + Math.abs(spread) * 0.25);
          foam.scale.set(Math.max(0.1, 4 - burst * 2));
          foam.alpha = (1 - burst) * 0.7;
        }
      }
    },
  };
};

// --- Gale Spinner ----------------------------------------------------------

const createGaleSpinner = (definition: BuildDefinition, paint: RidePaint): RideArt => {
  const primary = paint('primary', definition.color);
  const secondary = paint('secondary', definition.accent);
  const container = new Container();
  const hubY = -72;
  const armLength = 46;

  const structure = new Graphics();
  groundPad(structure, 58);
  structure.ellipse(0, -8, 48, 24).fill(paint.tone('primary', 0x3c2f5e, definition.color)).stroke({ color: 0xffffff, alpha: 0.25, width: 2 });
  for (const side of [-1, 1]) {
    structure.moveTo(side * 30, -4).lineTo(side * 8, hubY).lineTo(side * 15, -4).closePath().fill(STEEL);
    structure.roundRect(side * 30 - 7, -8, 14, 6, 3).fill(0x1d454c);
  }
  structure.moveTo(-24, -30).lineTo(24, -30).stroke({ color: STEEL_LIGHT, width: 3 });
  structure.roundRect(-34, -28, 18, 20, 4).fill(paint.tone('primary', 0x3f3a63, definition.color)).stroke({ color: 0xffffff, alpha: 0.3, width: 1.4 });
  container.addChild(structure);

  const streaks = new Container();
  streaks.position.set(0, hubY);
  container.addChild(streaks);
  // Motion trails: fixed arcs that rotate with the arm instead of being redrawn.
  const streakArcs = Array.from({ length: 3 }, (_unused, trail) => {
    const arc = new Container();
    const graphic = new Graphics();
    for (const half of [0, Math.PI]) {
      graphic.arc(0, 0, armLength, half, half + 0.2)
        .stroke({ color: secondary, alpha: 0.28 - (trail + 1) * 0.07, width: 6 });
    }
    arc.addChild(graphic);
    arc.rotation = -(trail + 1) * 0.22;
    streaks.addChild(arc);
    return arc;
  });

  const arm = new Container();
  arm.position.set(0, hubY);
  const armArt = new Graphics();
  armArt.roundRect(-armLength, -5, armLength * 2, 10, 5).fill(primary)
    .stroke({ color: 0xffffff, alpha: 0.6, width: 2 });
  armArt.roundRect(-armLength, -2, armLength * 2, 3, 1.5).fill({ color: 0xffffff, alpha: 0.25 });
  armArt.circle(0, 0, 13).fill(STEEL).stroke({ color: secondary, width: 3 });
  armArt.circle(0, 0, 5).fill(secondary);
  arm.addChild(armArt);
  container.addChild(arm);

  const pods = new Container();
  pods.position.set(0, hubY);
  container.addChild(pods);
  const gondolas = Array.from({ length: 2 }, (_unused, index) => {
    const holder = new Container();
    const graphic = new Graphics();
    graphic.circle(0, 0, 15).fill(index ? secondary : primary)
      .stroke({ color: 0xffffff, alpha: 0.8, width: 2 });
    graphic.circle(0, 0, 6).fill(STEEL);
    for (let seat = 0; seat < 4; seat += 1) {
      const angle = seat * Math.PI / 2 + Math.PI / 4;
      graphic.roundRect(Math.cos(angle) * 10 - 3.5, Math.sin(angle) * 10 - 3.5, 7, 7, 2.5)
        .fill(0x1f4a52).stroke({ color: 0xffffff, alpha: 0.5, width: 1 });
      graphic.circle(Math.cos(angle) * 10, Math.sin(angle) * 10, 2).fill(0xffd3a6);
    }
    holder.addChild(graphic);
    pods.addChild(holder);
    return holder;
  });

  return {
    container,
    animate: ({ spin, motion }) => {
      const rotation = spin * 0.0013;
      arm.rotation = rotation;
      streaks.visible = motion > 0.3;
      if (streaks.visible) {
        for (const arc of streakArcs) arc.alpha = motion;
        streaks.rotation = rotation;
      }
      for (const [index, gondola] of gondolas.entries()) {
        const angle = rotation + index * Math.PI;
        gondola.position.set(Math.cos(angle) * armLength, Math.sin(angle) * armLength);
        // Pods counter-rotate on their own pins, which is where the intensity comes from.
        gondola.rotation = -rotation * 2.4;
      }
    },
  };
};

// --- Thunder Drum ----------------------------------------------------------

const createThunderDrum = (definition: BuildDefinition, paint: RidePaint): RideArt => {
  const primary = paint('primary', definition.color);
  const secondary = paint('secondary', definition.accent);
  const container = new Container();
  const structure = new Graphics();
  groundPad(structure, 60);
  structure.ellipse(0, -6, 52, 26).fill(paint.tone('primary', 0x4a2320, definition.color)).stroke({ color: 0xffffff, alpha: 0.22, width: 2 });
  for (const side of [-1, 1]) {
    structure.moveTo(side * 46, -6).quadraticCurveTo(side * 44, -46, side * 26, -54)
      .stroke({ color: STEEL, width: 8 });
    structure.roundRect(side * 46 - 9, -10, 18, 8, 3).fill(0x1d454c);
  }
  structure.roundRect(-34, -30, 20, 22, 4).fill(paint.tone('primary', 0x5c2b26, definition.color)).stroke({ color: 0xffffff, alpha: 0.3, width: 1.4 });
  structure.rect(-30, -25, 12, 4).fill(secondary);
  container.addChild(structure);

  const drum = new Container();
  drum.position.set(0, -16);
  const shell = new Graphics();
  shell.ellipse(0, 0, 44, 15).fill(paint.tone('primary', 0x7a1f16, definition.color));
  shell.rect(-44, -56, 88, 56).fill(primary);
  shell.ellipse(0, -56, 44, 15).fill(paint.tone('primary', 0x8f2a1f, definition.color)).stroke({ color: 0xffffff, alpha: 0.35, width: 2 });
  shell.ellipse(0, 0, 44, 15).stroke({ color: 0xffffff, alpha: 0.35, width: 2 });
  shell.rect(-44, -34, 88, 5).fill({ color: 0x2b2d42, alpha: 0.55 });
  drum.addChild(shell);
  const bands = new Container();
  drum.addChild(bands);
  const drumBands = createBandSet(bands, -4, 52, 42, 12, 0x2b2d42);
  // Riders pinned to the wall, sweeping past with the drum itself.
  const riders = Array.from({ length: 6 }, (_unused, index) => {
    const rider = new Graphics();
    rider.roundRect(-4, -40, 8, 22, 4).fill(index % 2 ? 0x6fd1c0 : 0xffd166);
    rider.circle(0, -44, 3.4).fill(0xffd3a6);
    bands.addChild(rider);
    return rider;
  });
  const cage = new Graphics();
  cage.ellipse(0, -56, 44, 15).stroke({ color: 0xffe9a8, alpha: 0.5, width: 1.5 });
  cage.moveTo(-16, -66).lineTo(-6, -58).lineTo(-11, -58).lineTo(-2, -48)
    .stroke({ color: secondary, width: 3 });
  drum.addChild(cage);
  container.addChild(drum);

  const glow = new Graphics();
  glow.ellipse(0, -46, 56, 40).fill(definition.accent); // a glow: fixed
  container.addChild(glow);

  return {
    container,
    animate: ({ spin, motion, elapsedMs }) => {
      const phase = spin * 0.0028;
      drumBands.update(phase);
      for (const [index, rider] of riders.entries()) {
        const angle = phase + index * Math.PI / 3;
        const facing = Math.cos(angle);
        rider.visible = facing > 0.05;
        if (!rider.visible) continue;
        rider.position.x = Math.sin(angle) * 38;
        rider.alpha = 0.35 + facing * 0.6;
      }
      // The whole rotor tips as it spins up, then rocks while it holds speed.
      drum.rotation = motion * (0.1 + 0.1 * Math.sin(spin * 0.0009));
      drum.position.y = -16 - motion * 6;
      glow.visible = motion > 0.35;
      if (!glow.visible) return;
      glow.alpha = Math.max(0, Math.sin(elapsedMs * 0.009)) ** 6 * motion * 0.22;
    },
  };
};

// --- Fallback --------------------------------------------------------------

const createGenericRide = (definition: BuildDefinition): RideArt => {
  const container = new Container();
  const structure = new Graphics();
  groundPad(structure, 62);
  platter(structure, 54, -10, 0x35635f, 0x4a7f78);
  structure.roundRect(-6, -62, 12, 54, 5).fill(STEEL);
  container.addChild(structure);
  const hub = new Container();
  container.addChild(hub);
  const hubBands = createBandSet(hub, -10, 50, 14, 8, definition.accent);
  const seats = new Container();
  seats.sortableChildren = true;
  container.addChild(seats);
  const cars = Array.from({ length: 6 }, (_unused, index) => {
    const holder = new Container();
    const graphic = new Graphics();
    graphic.roundRect(-9, -12, 18, 12, 5).fill(index % 2 ? definition.color : definition.accent)
      .stroke({ color: 0xffffff, alpha: 0.7, width: 1.5 });
    seatedRider(graphic, 0, -10, 0xffd166);
    holder.addChild(graphic);
    seats.addChild(holder);
    return holder;
  });
  return {
    container,
    animate: ({ spin, motion }) => {
      hubBands.update(spin * 0.0012);
      const base = spin * 0.0012;
      for (const [index, car] of cars.entries()) {
        const angle = base + index * Math.PI / 3;
        const point = orbit(angle, 40);
        const depth = depthOf(angle);
        car.position.set(point.x, point.y - 20 - motion * 4);
        car.zIndex = Math.round(depth * 100);
        car.scale.set(0.9 + depth * 0.12);
        car.rotation = -Math.cos(angle) * motion * 0.2;
      }
    },
  };
};

/**
 * Rotation reaches the builders that have a long axis to align with the plot. Radially
 * symmetric machinery ignores it, exactly as its footprint does.
 */
type RideArtBuilder = (definition: BuildDefinition, rotation: Rotation, paint: RidePaint) => RideArt;

const BUILDERS: Record<string, RideArtBuilder> = {
  'petal-roundabout': (definition, _rotation, paint) => createPetalRoundabout(definition, paint),
  'comet-cups': (definition, _rotation, paint) => createCometCups(definition, paint),
  'tiki-tumbler': (definition, _rotation, paint) => createTikiTumbler(definition, paint),
  'cloud-hopper': (definition, _rotation, paint) => createCloudHopper(definition, paint),
  'aurora-wheel': (definition, _rotation, paint) => createAuroraWheel(definition, paint),
  'moonpetal-carousel': (definition, _rotation, paint) => createMoonpetalCarousel(definition, paint),
  'bumble-coach': createBumbleCoach,
  'harbor-swings': (definition, _rotation, paint) => createHarborSwings(definition, paint),
  'splash-rings': createSplashRings,
  'gale-spinner': (definition, _rotation, paint) => createGaleSpinner(definition, paint),
  'thunder-drum': (definition, _rotation, paint) => createThunderDrum(definition, paint),
};

/** Ride ids that have bespoke machinery rather than the generic spinner. */
export const BESPOKE_RIDE_ART_IDS: readonly string[] = Object.keys(BUILDERS);

/**
 * Builds the animated machinery for one ride definition; unknown ids get a generic spinner. `colours`
 * is the placed object's record (Phase 28): null or absent draws the catalog colours.
 */
export const createRideArt = (
  definition: BuildDefinition,
  rotation: Rotation = 0,
  colours?: ObjectColours | null,
): RideArt => {
  const builder = BUILDERS[definition.id];
  return builder ? builder(definition, rotation, ridePaintFor(definition.id, colours)) : createGenericRide(definition);
};
