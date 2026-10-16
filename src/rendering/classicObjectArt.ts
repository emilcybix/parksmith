import { Container, Graphics, Text } from 'pixi.js';
import type { ObjectColours } from '../game/content/colours';
import type { BuildDefinition } from '../game/types';
import { ridePaintFor } from './classicPaint';

/**
 * Classic art of everything that is neither a ride nor a coaster track: stalls and facilities, the bench,
 * the bin, scenery, and the entrance gate (Phase 28 step 2: they take the colour record like a ride does).
 *
 * The contract is step 1's: every colour that belongs to a slot is asked for through `paint(slot, fallback)`,
 * where `fallback` is the literal the part has always been drawn with. An object with no record (or one whose
 * every slot is the default colour) therefore draws EXACTLY the instructions it drew before colours existed,
 * pinned by the fingerprint baseline of the extended park. Parts that are not in a slot (the door, the
 * window, the lights, the water, the leaves, the soil) keep their literals.
 *
 * Slot ids are the ones colours.ts declares for the definition, and the voxel blueprints tag the same parts
 * (a cross-check test compares the two renderers' ids).
 */

/** The art of one non-ride, non-coaster definition. Pure construction: nothing here runs per frame. */
export const createObjectArt = (definition: BuildDefinition, colours: ObjectColours | null = null): Container => {
  const paint = ridePaintFor(definition.id, colours);
  const art = new Container();
  const graphic = new Graphics();
  if (definition.kind === 'shop' || definition.kind === 'facility') {
    const roof = paint('secondary', definition.accent);
    graphic.roundRect(-31, -45, 62, 43, 5).fill(paint('primary', definition.color)).stroke({ color: 0xffffff, alpha: 0.7, width: 2 });
    graphic.moveTo(-34, -44).lineTo(0, -67).lineTo(34, -44).closePath().fill(roof).stroke({ color: 0x275b66, width: 2 });
    graphic.roundRect(-16, -25, 32, 18, 4).fill(0x193e42);
    graphic.rect(-13, -22, 26, 5).fill(roof);
  } else if (definition.id === 'ribbon-bench') {
    graphic.roundRect(-20, -19, 40, 8, 3).fill(paint('primary', definition.color));
    graphic.roundRect(-20, -31, 40, 8, 3).fill(paint('secondary', definition.accent));
    graphic.rect(-15, -12, 4, 12).fill(0x315c54);
    graphic.rect(11, -12, 4, 12).fill(0x315c54);
  } else if (definition.id === 'tidy-totem') {
    graphic.roundRect(-11, -34, 22, 34, 5).fill(paint('primary', definition.color)).stroke({ color: paint('secondary', definition.accent), width: 2 });
    graphic.roundRect(-8, -27, 16, 7, 3).fill(0x193e42);
  } else if (definition.id === 'confetti-tree') {
    // Trees stay fixed (not colourable): no paint calls.
    graphic.roundRect(-5, -40, 10, 40, 4).fill(0x79543a);
    graphic.circle(-8, -46, 19).fill(definition.color);
    graphic.circle(10, -48, 18).fill(definition.accent);
    graphic.circle(0, -64, 20).fill(0x48a96b);
  } else if (definition.id === 'lantern-maple') {
    // Phase 22: a red maple (fixed, like the other trees: no paint calls). Two crown circles, the darker one low, and
    // three paper lanterns hanging from the lower crown.
    graphic.roundRect(-5, -38, 10, 38, 4).fill(0x79543a);
    graphic.circle(0, -42, 21).fill(0xc0392b);
    graphic.circle(0, -58, 17).fill(definition.color);
    graphic.circle(-12, -36, 3.5).fill(definition.accent);
    graphic.circle(0, -30, 3.5).fill(definition.accent);
    graphic.circle(12, -36, 3.5).fill(definition.accent);
  } else if (definition.id === 'lollipop-lamp') {
    graphic.roundRect(-3, -48, 6, 48, 3).fill(paint('primary', definition.color));
    graphic.circle(0, -52, 11).fill(paint('secondary', definition.accent)).stroke({ color: 0xffffff, alpha: 0.7, width: 3 });
  } else if (definition.id === 'ripple-fountain') {
    graphic.ellipse(0, -4, 43, 18).fill(0x2b6f8e).stroke({ color: definition.accent, width: 4 });
    graphic.ellipse(0, -9, 29, 12).fill(paint('primary', definition.color));
    graphic.moveTo(0, -12).quadraticCurveTo(-12, -42, 0, -50).quadraticCurveTo(12, -42, 0, -12).fill(definition.accent);
  } else {
    // Sunburst flowers: the soil bed is fixed; the odd blooms are the Blooms slot, the pink ones the Petals slot.
    const blooms = paint('primary', definition.accent);
    const petals = paint('secondary', 0xff7ca3);
    graphic.ellipse(0, -4, 25, 11).fill(0x347857);
    for (let i = 0; i < 7; i += 1) {
      const angle = i * 2.4;
      graphic.circle(Math.cos(angle) * 17, -10 + Math.sin(angle) * 7, 5).fill(i % 2 ? blooms : petals);
    }
  }
  art.addChild(graphic);
  return art;
};

/** The shipped colours of the entrance gate: the same literals the slot table defaults to (colours.ts). */
const GATE_ARCH = 0xff6f91;
const GATE_SIGN = 0xffd166;
const GATE_POSTS = 0x254f4a;

/**
 * Fills `group` (the entrance display, positioned by the renderer) with the gate: two posts, the sign, the
 * arch and the lettering. Slots: primary is the arch, secondary the sign board, trim the posts; the sign's
 * outline and the lettering stay fixed. Called once per drawing (first sync, a recolour, a view turn does not
 * need it: the gate is symmetric).
 */
export const drawEntranceArt = (group: Container, colours: ObjectColours | null): void => {
  const paint = ridePaintFor('park-entrance', colours);
  const posts = paint('trim', GATE_POSTS);
  const art = new Graphics();
  art.roundRect(-25, -43, 7, 43, 3).fill(posts);
  art.roundRect(18, -43, 7, 43, 3).fill(posts);
  art.roundRect(-28, -51, 56, 13, 6).fill(paint('secondary', GATE_SIGN)).stroke({ color: 0x173f3b, width: 2 });
  art.moveTo(-20, -38).quadraticCurveTo(0, -58, 20, -38).stroke({ color: paint('primary', GATE_ARCH), width: 5 });
  group.addChild(art);
  const label = new Text({ text: 'WELCOME', style: { fontFamily: 'Arial', fontWeight: '700', fontSize: 7, fill: 0x173f3b, letterSpacing: 1 } });
  label.anchor.set(0.5);
  label.position.set(0, -44);
  group.addChild(label);
};
