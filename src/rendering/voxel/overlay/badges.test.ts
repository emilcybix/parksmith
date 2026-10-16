import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ParkSession } from '../../../game/session/ParkSession';
import { countGraphicsDrawCalls } from '../../drawCallCounter';
import { VIEW_ROTATIONS } from '../../viewRotation';
import { footprintSize } from '../../../game/types';
import { BUILD_BY_ID } from '../../../game/content/catalog';
import { ALERT_BOB_STEP_MS, BIN_BAR_MAX_TEXELS, VoxelBadges } from './badges';
import { viewFrameOf } from './overlayTestKit';

const TOP = 20;

const rig = () => {
  const session = new ParkSession(null);
  const root = new Container();
  const tops = new Map<number, number>();
  const badges = new VoxelBadges(root, () => session, (id) => tops.get(id) ?? null);
  const layer = root.children[0] as Container;
  const addBin = (x: number, y: number): number => {
    const object = session.world.seedScenarioObject('tidy-totem', { x, y })!;
    session.operations.syncWithWorld();
    tops.set(object.id, TOP);
    return object.id;
  };
  const addRide = (x: number, y: number): number => {
    const object = session.world.seedScenarioObject('petal-roundabout', { x, y })!;
    session.rides.syncWithWorld();
    tops.set(object.id, 60);
    return object.id;
  };
  const addService = (x: number, y: number): number => {
    const object = session.world.seedScenarioObject('fizz-foundry', { x, y })!;
    session.shops.syncWithWorld();
    tops.set(object.id, 40);
    return object.id;
  };
  /** The default map's gate is (15, 31): a path up column 15 to row 20 reaches anything beside it. */
  const connect = (): void => {
    session.world.seedScenarioPaths(Array.from({ length: 11 }, (_unused, index) => ({ x: 15, y: 30 - index })));
  };
  const visible = (): Container[] => layer.children.filter((child) => child.visible) as Container[];
  return { session, badges, layer, addBin, addRide, addService, connect, visible, tops };
};

/** The fill colours a badge's alert graphic paints. */
const fillsOf = (badge: Container): number[] =>
  ((badge.children[0] as Graphics).context.instructions).map((i) => (i.data as { style: { color: number } }).style.color);

const SLATE = 0x8fa6bd;

describe('bin badges', () => {
  it('stay hidden at 0 fill and are empty', () => {
    const { badges, addBin, visible } = rig();
    addBin(5, 5);
    badges.update(0);
    expect(badges.isEmpty).toBe(true);
    expect(visible()).toHaveLength(0);
  });

  it('grow a bar by whole texels with the fill and turn red when full', () => {
    const { session, badges, addBin, visible } = rig();
    const id = addBin(5, 5);
    const bin = session.operations.bins.get(id)!;
    bin.fill = bin.capacity / 2;
    badges.update(0);
    const [badge] = visible();
    const bar = badge.children[1] as Graphics;
    expect(bar.scale.y).toBe(BIN_BAR_MAX_TEXELS / 2);
    expect(bar.tint).toBe(0x58d9ad);
    bin.fill = 1;
    badges.update(0);
    expect(bar.scale.y, 'any rubbish shows at least one texel').toBe(Math.max(1, Math.round(BIN_BAR_MAX_TEXELS / bin.capacity)));
    bin.fill = bin.capacity;
    badges.update(0);
    expect([bar.scale.y, bar.tint]).toEqual([BIN_BAR_MAX_TEXELS, 0xff6277]);
    bin.fill = 0;
    badges.update(0);
    expect(badges.isEmpty).toBe(true);
  });

  it('sit above the object top at its whole-texel ground centre', () => {
    const { session, badges, addBin, visible } = rig();
    const id = addBin(5, 3);
    session.operations.bins.get(id)!.fill = 5;
    badges.update(0);
    const [badge] = visible();
    // Cell (5, 3): centre texel (32 (5 − 3), 16 (5 + 3 + 1)), lifted by the top and the 3 texel gap.
    expect([badge.x, badge.y]).toEqual([64, 16 * 9 - TOP - 3]);
    expect(Number.isInteger(badge.x) && Number.isInteger(badge.y)).toBe(true);
  });

  it('are removed with their object, and wait for an unknown top', () => {
    const { session, badges, addBin, visible, layer, tops } = rig();
    const id = addBin(5, 5);
    session.operations.bins.get(id)!.fill = 5;
    tops.delete(id);
    badges.update(0);
    expect(badges.isEmpty, 'top unknown: hidden').toBe(true);
    tops.set(id, TOP);
    badges.update(0);
    expect(visible()).toHaveLength(1);
    const version = badges.version;
    session.world.objects.delete(id);
    session.operations.syncWithWorld();
    badges.update(0);
    expect(layer.children).toHaveLength(0);
    expect(badges.isEmpty).toBe(true);
    expect(badges.version).toBeGreaterThan(version);
  });
});

describe('ride alerts', () => {
  it('show a broken or maintenance glyph in the legacy colours and swap between them', () => {
    const { session, badges, addRide, connect, layer } = rig();
    connect();
    // Beside the path, so it has access and only its breakdowns show.
    const id = addRide(16, 22);
    const ride = session.rides.rides.get(id)!;
    badges.update(0);
    expect(layer.children, 'a healthy ride has none').toHaveLength(0);
    ride.broken = true;
    badges.update(0);
    const broken = layer.children[0] as Container;
    expect(broken.visible).toBe(true);
    const brokenFills = ((broken.children[0] as Graphics).context.instructions).map((i) => (i.data as { style: { color: number } }).style.color);
    expect(brokenFills).toContain(0xff6277);
    ride.broken = false;
    (ride as { maintenanceKind: unknown }).maintenanceKind = 'inspection';
    badges.update(0);
    expect(layer.children).toHaveLength(1);
    const maintenance = layer.children[0] as Container;
    expect(maintenance).not.toBe(broken);
    const fills = ((maintenance.children[0] as Graphics).context.instructions).map((i) => (i.data as { style: { color: number } }).style.color);
    expect(fills).toContain(0xf4b94e);
    expect(fills).not.toContain(0xff6277);
    (ride as { maintenanceKind: unknown }).maintenanceKind = null;
    badges.update(0);
    expect(layer.children).toHaveLength(0);
    expect(badges.isEmpty).toBe(true);
  });

  it('bob between two whole-texel steps and only bump the version when the picture changes', () => {
    const { session, badges, addRide, visible } = rig();
    const id = addRide(8, 8);
    session.rides.rides.get(id)!.broken = true;
    badges.update(0);
    const [badge] = visible();
    const low = badge.y;
    const version = badges.version;
    badges.update(ALERT_BOB_STEP_MS - 1);
    expect([badge.y, badges.version], 'same step').toEqual([low, version]);
    badges.update(ALERT_BOB_STEP_MS);
    expect(badge.y, 'up one texel').toBe(low - 1);
    expect(badges.version).toBe(version + 1);
    badges.update(2 * ALERT_BOB_STEP_MS);
    expect(badge.y).toBe(low);
    expect(Number.isInteger(low)).toBe(true);
  });
});

describe('no path access alerts (Phase 11, PA-024)', () => {
  it('appear on a ride with no path from the gate, vanish when a path reaches it and come back when it goes', () => {
    const { session, badges, addRide, connect, visible } = rig();
    const id = addRide(16, 22);
    badges.update(0);
    const [badge] = visible();
    expect(badge, 'unconnected: the no-access badge').toBeDefined();
    expect(fillsOf(badge)).toContain(SLATE);
    expect(session.management.hasPathAccess(id)).toBe(false);
    connect();
    badges.update(16);
    expect(badges.isEmpty, 'a path reaches it: gone').toBe(true);
    session.world.bulldoze({ x: 15, y: 26 });
    badges.update(32);
    expect(visible(), 'the path is cut: back').toHaveLength(1);
  });

  it('draw a slate disc with an 8 x 2 ink bar, unlike the "!" and the spanner', () => {
    const { badges, addRide, visible } = rig();
    addRide(8, 8);
    badges.update(0);
    const [badge] = visible();
    const fills = fillsOf(badge);
    expect(fills).toEqual(expect.arrayContaining([0xffffff, SLATE, 0x173f3b]));
    expect(fills).not.toContain(0xff6277);
    expect(fills).not.toContain(0xf4b94e);
    const ink = (badge.children[0] as Graphics).context.instructions
      .filter((i) => (i.data as { style: { color: number } }).style.color === 0x173f3b)
      .map((i) => (i.data as unknown as { path: { shapePath: { shapePrimitives: { shape: { width: number; height: number } }[] } } }).path.shapePath.shapePrimitives[0].shape);
    expect(ink.map((shape) => [shape.width, shape.height])).toEqual([[8, 1], [8, 1]]);
  });

  it('stay still (no bob) and keep the version through the bob steps', () => {
    const { badges, addRide, visible } = rig();
    addRide(8, 8);
    badges.update(0);
    const [badge] = visible();
    const y = badge.y;
    const version = badges.version;
    badges.update(ALERT_BOB_STEP_MS);
    badges.update(3 * ALERT_BOB_STEP_MS);
    expect([badge.y, badges.version]).toEqual([y, version]);
    // Same anchor as the alarms' resting step: ground centre, top 60, 9 texel gap.
    expect(badge.y).toBe(Math.round((9 + 9) * 16 + 16 - 60) - 9);
  });

  it('rank below broken and maintenance: broken > maintenance > no access', () => {
    const { session, badges, addRide, layer } = rig();
    const ride = session.rides.rides.get(addRide(8, 8))!;
    ride.broken = true;
    (ride as { maintenanceKind: unknown }).maintenanceKind = 'inspection';
    badges.update(0);
    expect(layer.children).toHaveLength(1);
    expect(fillsOf(layer.children[0] as Container)).toContain(0xff6277);
    ride.broken = false;
    badges.update(0);
    expect(layer.children).toHaveLength(1);
    expect(fillsOf(layer.children[0] as Container)).toContain(0xf4b94e);
    (ride as { maintenanceKind: unknown }).maintenanceKind = null;
    badges.update(0);
    expect(layer.children).toHaveLength(1);
    expect(fillsOf(layer.children[0] as Container)).toContain(SLATE);
    expect(badges.isEmpty).toBe(false);
  });

  it('cover services too, and follow their access', () => {
    const { badges, addService, connect, visible } = rig();
    addService(13, 25);
    badges.update(0);
    const [badge] = visible();
    expect(fillsOf(badge)).toContain(SLATE);
    connect();
    badges.update(16);
    expect(badges.isEmpty).toBe(true);
  });

  it('draw nothing and keep a stable version in a steady frame', () => {
    const { badges, addRide, addService } = rig();
    addRide(8, 8);
    addService(4, 4);
    badges.update(0);
    expect(badges.isEmpty).toBe(false);
    const version = badges.version;
    const calls = countGraphicsDrawCalls(() => {
      for (let frame = 1; frame <= 40; frame += 1) badges.update(frame * 50);
    });
    expect(calls).toBe(0);
    expect(badges.version, 'static across bob steps').toBe(version);
  });

  it('follow the view rotation without a bob offset', () => {
    for (const q of VIEW_ROTATIONS) {
      const { session, badges, addRide, visible } = rig();
      const id = addRide(8, 12);
      badges.update(ALERT_BOB_STEP_MS);
      badges.setView(viewFrameOf(q, session.world.width, session.world.height));
      badges.update(ALERT_BOB_STEP_MS);
      const object = session.world.objects.get(id)!;
      const size = footprintSize(BUILD_BY_ID.get(object.definitionId)!, object.rotation);
      const cx = object.anchor.x + (size[0] - 1) / 2;
      const cy = object.anchor.y + (size[1] - 1) / 2;
      const w = session.world.width;
      const h = session.world.height;
      const [u, v] = q === 1 ? [h - 1 - cy, cx] : q === 2 ? [w - 1 - cx, h - 1 - cy] : q === 3 ? [cy, w - 1 - cx] : [cx, cy];
      expect(visible().map((badge) => [badge.x, badge.y]), `view ${q}`).toEqual([[Math.round((u - v) * 32), Math.round((u + v) * 16 + 16 - 60) - 9]]);
    }
  });
});

describe('steady state and session swaps', () => {
  it('draws nothing and keeps a stable version in a steady frame', () => {
    const { session, badges, addBin, addRide } = rig();
    session.operations.bins.get(addBin(5, 5))!.fill = 4;
    session.rides.rides.get(addRide(12, 12))!.maintenanceKind = 'inspection' as never;
    badges.update(0);
    const version = badges.version;
    const calls = countGraphicsDrawCalls(() => {
      for (let frame = 1; frame <= 20; frame += 1) badges.update(frame * 16);
    });
    expect(calls).toBe(0);
    expect(badges.version, 'nothing changed inside one bob step').toBe(version);
  });

  it('reset drops every badge', () => {
    const { session, badges, addBin, layer } = rig();
    session.operations.bins.get(addBin(5, 5))!.fill = 4;
    badges.update(0);
    expect(badges.isEmpty).toBe(false);
    const version = badges.version;
    badges.reset();
    expect([layer.children.length, badges.isEmpty]).toEqual([0, true]);
    expect(badges.version).toBeGreaterThan(version);
    badges.destroy();
  });
});

describe('badges in a turned view (Phase 26)', () => {
  it('anchor at the view-mapped footprint centre, at the object top, in every view', () => {
    for (const q of VIEW_ROTATIONS) {
      const { session, badges, addBin, addRide, visible } = rig();
      const width = session.world.width;
      const height = session.world.height;
      const bin = addBin(5, 3);
      session.operations.bins.get(bin)!.fill = 5;
      const ride = addRide(8, 12);
      session.rides.rides.get(ride)!.broken = true;
      badges.update(0);
      badges.setView(viewFrameOf(q, width, height));
      badges.update(0);
      const mapPoint = (x: number, y: number): [number, number] => {
        switch (q) {
          case 1: return [height - 1 - y, x];
          case 2: return [width - 1 - x, height - 1 - y];
          case 3: return [y, width - 1 - x];
          default: return [x, y];
        }
      };
      const expected = (id: number, top: number, clearance: number): [number, number] => {
        const object = session.world.objects.get(id)!;
        const size = footprintSize(BUILD_BY_ID.get(object.definitionId)!, object.rotation);
        const [u, v] = mapPoint(object.anchor.x + (size[0] - 1) / 2, object.anchor.y + (size[1] - 1) / 2);
        return [Math.round((u - v) * 32), Math.round((u + v) * 16 + 16 - top) - clearance];
      };
      const positions = visible().map((badge) => [badge.x, badge.y]);
      expect(positions, `view ${q}`).toEqual([expected(bin, 20, 3), expected(ride, 60, 9)]);
    }
  });

  it('re-places every shown badge on the turn, bumps the version once, and the next update draws nothing', () => {
    const { session, badges, addBin, visible } = rig();
    session.operations.bins.get(addBin(5, 3))!.fill = 5;
    badges.update(0);
    const [badge] = visible();
    const flat = [badge.x, badge.y];
    const before = badges.version;
    badges.setView(viewFrameOf(1, session.world.width, session.world.height));
    expect(badges.version).toBe(before + 1);
    expect([badge.x, badge.y]).not.toEqual(flat);
    const turned = badges.version;
    badges.update(16);
    expect(badges.version, 'update after the turn finds every badge in place').toBe(turned);
    badges.setView(viewFrameOf(1, session.world.width, session.world.height));
    expect(badges.version, 'a repeat is free').toBe(turned);
    badges.setView(viewFrameOf(0, session.world.width, session.world.height));
    expect([badge.x, badge.y], 'turning back restores view 0').toEqual(flat);
  });
});
