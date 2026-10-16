import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 30 review (feature end to end): the owner's request, "when guests complain about long queues or expensive
 * prices, the player must be able to click to get to the building they complain about". Real simulation paths make
 * the complaint (a ride queue abandoned, a ride price refused at the entrance, a stall price refused at the door); the
 * published Pulse insight must carry that building's id and name; focusBuilding (what the link calls) must close the
 * dashboard and open the right inspector; and a click near the complaining guest must open the guest inspector whose
 * markup shows the same link. Harness copied from GameApp.guestInspector.test.ts.
 *
 * (Original header follows.) Phase 30 in GameApp: the guest inspector (the pointer's click on a guest figure where no ride or stall is, the
 * bridge's selectGuest, Escape, the close, a guest who leaves, a session swap, the paint tool) and focusBuilding as the
 * complaint links use it (closes the management dashboard, eases the camera, opens the inspector, drops a guest
 * selection). Fake renderer and stubbed window as in GameApp.demolish.test.ts.
 */

type CellLike = { x: number; y: number };
type Handlers = {
  hover(cell: CellLike | null): void;
  start(cell: CellLike): void;
  move(cell: CellLike): void;
  end(cell: CellLike): void;
  cancel(): void;
};
let inputHandlers: Handlers | null = null;
let frameCallback: ((deltaMs: number) => void) | null = null;
const focusCalls: Array<{ kind: 'cell' | 'entrance'; motion: string | undefined }> = [];
const selectCalls: Array<number | null> = [];

class FakeRenderer {
  get hoveredCell() { return null; }
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(callback: (deltaMs: number) => void): void { frameCallback = callback; }
  setSession(): void {}
  syncWorld(): void {}
  update(): void {}
  getPerformance() { return { fps: 60, renderMs: 16, entities: 0 }; }
  setTimeOfDay(): void {}
  setWeather(): void {}
  setInputHandlers(handlers: Handlers): void { inputHandlers = handlers; }
  setViewInputEnabled(): void {}
  setToolCursor(): void {}
  focusCell(_cell: CellLike, motion?: string): void { focusCalls.push({ kind: 'cell', motion }); }
  focusEntrance(motion?: string): void { focusCalls.push({ kind: 'entrance', motion }); }
  setGridVisible(): void {}
  setSceneryInfluenceVisible(): void {}
  selectObject(object: { id: number } | null): void { selectCalls.push(object === null ? null : object.id); }
  drawPreview(): void {}
  clearPreview(): void {}
  setHintMarkers(): void {}
  drawCoasterDraft(): void {}
}

vi.mock('./rendererFlag', () => ({
  RENDERER_KIND: 'classic', LIGHT_PRESET: 'day', LIGHT_OVERRIDE: null, TIME_OVERRIDE: null, ZOOM_OVERRIDE: null, ALLOW_SOFTWARE_GPU: false, VOXEL_GPU_MIN: false,
}));
vi.mock('../rendering/WorldRenderer', () => ({ WorldRenderer: FakeRenderer }));

const { GameApp } = await import('./GameApp');
const { gameBridge } = await import('./gameBridge');
const { useUiStore } = await import('../ui/store');
const { activeInputContext } = await import('../ui/inputContext');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./saves/SaveManager');
const { BUILD_BY_ID } = await import('../game/content/catalog');
const { renderToStaticMarkup } = await import('react-dom/server');
const { createElement } = await import('react');
const { GuestInspector, ParkPulse } = await import('../ui/Hud');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const games: Array<{ destroy(): void }> = [];
const makeGame = async () => {
  const store = new MemorySaveStore();
  const game = new GameApp({
    saveStore: store,
    saveWriter: createHashingWriter(store, {
      kind: 'idle', seal: async (state) => computeStateSeal(state), dispose: () => undefined,
    }),
  });
  await game.mount({} as HTMLElement);
  await settle();
  games.push(game);
  game.world.addMoney(200_000);
  runFrames(8);
  return game;
};

const runFrames = (count: number, deltaMs = 250): void => {
  for (let i = 0; i < count; i += 1) frameCallback?.(deltaMs);
};

const ui = () => useUiStore.getState();
const click = (cell: CellLike): void => { inputHandlers!.start(cell); inputHandlers!.end(cell); };

const CAROUSEL = BUILD_BY_ID.get('moonpetal-carousel')!;
const PICNIC = BUILD_BY_ID.get('picnic-pocket')!;

beforeEach(() => {
  inputHandlers = null;
  frameCallback = null;
  focusCalls.length = 0;
  selectCalls.length = 0;
  handlers = new Map();
  const storage = new Map<string, string>([
    ['parksmith-profile', JSON.stringify({ version: 1, discoveredCardIds: [], tour: {}, ui: { mapSeen: true, tourOffered: true } })],
  ]);
  const register = (type: string, handler: Handler): void => { handlers.set(type, [...(handlers.get(type) ?? []), handler]); };
  vi.stubGlobal('window', {
    addEventListener: register,
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
  });
  vi.stubGlobal('document', { addEventListener: register, removeEventListener: () => undefined, visibilityState: 'visible' });
  ui().setToast(null);
  ui().selectPointer();
  ui().closeDemolishConfirm();
  ui().closeManagement();
});

afterEach(() => {
  for (const game of games.splice(0)) game.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


type Game = InstanceType<typeof GameApp>;
type GuestT = ReturnType<Game['guests']['guests']['get']> & object;

/** A guest standing on the gate cell (a path), wandering, ready to be handed a scripted errand. */
const guestAtGate = (game: Game): GuestT => {
  game.guests.spawnGuests(1);
  const guest = [...game.guests.guests.values()].at(-1)!;
  const gate = { x: game.world.entrance.x, y: game.world.entrance.y };
  guest.position = { ...gate };
  guest.currentCell = { ...gate };
  guest.route = [{ ...gate }];
  guest.routeIndex = 1;
  guest.state = 'wandering';
  guest.stateTimerSeconds = 0;
  return guest as GuestT;
};

/** Sends the guest "arriving" at a building this step: the route ends where they stand. */
const arriveAt = (guest: GuestT, objectId: number, state: 'walkingToRide' | 'walkingToShop'): void => {
  guest.state = state;
  guest.destinationObjectId = objectId;
  guest.route = [{ ...guest.currentCell }];
  guest.routeIndex = 0;
};

const stepSim = (game: Game, ms = 100, count = 1): void => {
  // The session is private to GameApp; the test steps it directly so the complaint happens on one known tick.
  const { session } = game as unknown as { session: { step(ms: number): unknown } };
  for (let i = 0; i < count; i += 1) session.step(ms);
};

/** Server-renders a HUD element from the live store (the hooks read the initial state on the server, so it is patched). */
const renderLive = (element: Parameters<typeof renderToStaticMarkup>[0]): string => {
  const seed = useUiStore.getInitialState() as unknown as Record<string, unknown>;
  const live = ui() as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = { ...seed };
  Object.assign(seed, live);
  try {
    return renderToStaticMarkup(element);
  } finally {
    for (const key of Object.keys(seed)) if (!(key in saved)) delete seed[key];
    Object.assign(seed, saved);
  }
};

const insightFor = (text: string) => ui().pulseInsights.find((line) => line.text === text);

describe('the owner feature end to end: complaint -> Pulse link -> inspector', () => {
  it('guests who abandon a ride queue: the Pulse names the ride, the link opens the ride inspector with the dashboard closed', async () => {
    const game = await makeGame();
    game.setSpeed(0);
    const ride = game.world.buildObject(CAROUSEL.id, { x: 20, y: 10 })!;
    game.rides.syncWithWorld(game.guests.guests);
    expect(game.rides.isAvailable(ride.id)).toBe(true);
    const quitters = [guestAtGate(game), guestAtGate(game)];
    for (const guest of quitters) {
      expect(game.rides.joinQueue(ride.id, guest)).toBe('joined');
      guest.destinationObjectId = ride.id;
      guest.stateTimerSeconds = guest.patienceSeconds + 1;
    }
    stepSim(game);
    for (const guest of quitters) {
      expect(guest.currentThought).toBe('This queue is taking forever.');
      expect(guest.thoughtObjectId).toBe(ride.id);
    }
    runFrames(2);
    const line = insightFor('guests are frustrated by a long queue.');
    expect(line, JSON.stringify(ui().pulseInsights)).toMatchObject({ count: 2, objectId: ride.id, objectName: CAROUSEL.name });
    // The Pulse markup renders the link for it.
    const pulse = renderLive(createElement(ParkPulse));
    expect(pulse).toContain(`>${CAROUSEL.name}</button>`);

    ui().openManagement('activity');
    gameBridge.focusBuilding(line!.objectId!);
    expect(ui().managementOpen).toBe(false);
    expect(ui().selectedRide?.objectId).toBe(ride.id);
    expect(ui().selectedService).toBeNull();
    expect(activeInputContext(ui())).toBe('inspector');
  });

  it('a guest who refuses the ride price at its entrance: the insight and the guest inspector both link the ride', async () => {
    const game = await makeGame();
    game.setSpeed(0);
    const ride = game.world.buildObject(CAROUSEL.id, { x: 20, y: 10 })!;
    game.rides.syncWithWorld(game.guests.guests);
    game.rides.setTicketPrice(ride.id, 10);
    // The Pulse lists a thought only once two guests share it.
    const [guest, other] = [guestAtGate(game), guestAtGate(game)];
    for (const each of [guest, other]) {
      each.money = 1;
      arriveAt(each, ride.id, 'walkingToRide');
    }
    stepSim(game);
    for (const each of [guest, other]) expect([each.currentThought, each.thoughtObjectId]).toEqual(["I'm not paying that much.", ride.id]);
    runFrames(2);
    expect(insightFor('guests think a price is too high.')).toMatchObject({ count: 2, objectId: ride.id, objectName: CAROUSEL.name });

    // A click on the guest's own cell (nothing built there) opens the guest inspector with the link.
    click({ x: Math.round(guest.position.x), y: Math.round(guest.position.y) });
    expect(ui().selectedGuest?.id).toBe(guest.id);
    expect(ui().selectedGuest).toMatchObject({ thoughtObjectId: ride.id, thoughtObjectName: CAROUSEL.name });
    const html = renderLive(createElement(GuestInspector));
    expect(html).toContain('inspector-link');
    expect(html).toContain(`>${CAROUSEL.name}</button>`);
    // Following it swaps the guest inspector for the ride's.
    ui().openManagement('overview');
    gameBridge.focusBuilding(ui().selectedGuest!.thoughtObjectId!);
    expect(ui().managementOpen).toBe(false);
    expect(ui().selectedGuest).toBeNull();
    expect(ui().selectedRide?.objectId).toBe(ride.id);
  });

  it('a guest turned away at a stall for its price: the Pulse links the stall and the link opens the stall inspector', async () => {
    const game = await makeGame();
    game.setSpeed(0);
    const stall = game.world.buildObject(PICNIC.id, { x: 6, y: 6 })!;
    game.shops.syncWithWorld(game.guests.guests);
    game.shops.setPrice(stall.id, 12);
    const pair = [guestAtGate(game), guestAtGate(game)];
    for (const guest of pair) {
      guest.money = 100;
      guest.servicePriceLimit = 4;
      arriveAt(guest, stall.id, 'walkingToShop');
    }
    stepSim(game);
    for (const guest of pair) expect([guest.currentThought, guest.thoughtObjectId]).toEqual(["I'm not paying that much.", stall.id]);
    runFrames(2);
    const line = insightFor('guests think a price is too high.');
    expect(line).toMatchObject({ count: 2, objectId: stall.id, objectName: PICNIC.name });
    expect(renderLive(createElement(ParkPulse))).toContain(`>${PICNIC.name}</button>`);

    ui().openManagement('activity');
    gameBridge.focusBuilding(line!.objectId!);
    expect(ui().managementOpen).toBe(false);
    expect(ui().selectedService?.objectId).toBe(stall.id);
    expect(ui().selectedRide).toBeNull();
    expect(activeInputContext(ui())).toBe('inspector');
  });
});
