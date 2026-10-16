# Playability Audit

A sandbox playtest performed by reading the code, since the game cannot be played in this
session. Everything below is a claim about what the player sees and can do, traced to a file and
line. Developer tools (`＋$`, `＋G`, `＋＋G`, `−G`, dev park, force breakdown) are treated as
unavailable, as a real playtest would.

Companion document: `AUDIT_FINDINGS.md` (verification audit).

---

## Part 1 — Sandbox playtest by code reading

### The starting state

`App` mounts `GameApp`, which constructs `new ParkSession(null)` — sandbox, no scenario, no
cards (`src/app/GameApp.ts:67`). The Parks modal is **not** shown. So the first frame is:

- A 32×32 grass plot, grid on, camera centred a little above the entrance at cell (15, 31)
  (`src/rendering/WorldRenderer.ts:232-241`).
- `$15,000`, park **open**, speed 1× (`src/game/config.ts:4, 9`).
- Build dock on the Paths tab with `sunstone-path` pre-selected and the build tool armed
  (`src/ui/store.ts:129-131`).
- Park Pulse showing `0 guests · — happiness · — rating` and the line
  *"Sketch a path from the gate, then add your first attraction."* (`src/ui/Hud.tsx:85-87`).
- A help hint: *Drag to build · R to rotate · Wheel to zoom · Middle-drag · WASD to pan · Esc to
  cancel* (`src/ui/Hud.tsx:544`).
- A utility column of seven buttons, four of which are developer cheats
  (`src/ui/Hud.tsx:263-271`).

This opening is good. The one pre-selected tool is the right one, the Pulse tells you what to do,
and the help hint covers every camera and build gesture.

### 0–5 minutes — first path, first ride

The player drags a path. It paints continuously, the cursor readout shows the running cost, and
the release toast reports `N path tiles built · -$N` (`src/app/GameApp.ts:536-538`). This is the
best-feeling interaction in the game.

Then they open **Rides** and meet twelve cards, eight of which carry a `LOCKED` badge
(`src/game/progression/content.ts` locks `comet-cups`, `cloud-hopper`, `aurora-wheel`,
`bumble-coach`, `splash-rings`, `gale-spinner`, `thunder-drum`, `skyline-serpent`). Three flat
rides are buildable: Petal Roundabout $1,150, Moonpetal Carousel $900, Harbor Swings $1,600. The
catalog order puts three locked cards between the first and the cheapest one.

> **"What is this?"** — The two cheapest-looking ride cards, *Comet Trail* "from $400" and
> *Star Chaser* "from $550", are not rides at all. They open the coaster designer. A player who
> clicks the cheapest card and then clicks the grass gets a track piece, a designer panel, and no
> ride. The "from " prefix (`src/ui/Hud.tsx:212`) is the only warning. → **PA-013**

Placing a flat ride works well: the blueprint is the actual building, ghosted, at the real
footprint (`src/rendering/WorldRenderer.ts:293-313`), the readout shows `⟳ 3×3 · R to rotate`,
and the toast confirms the spend. If the ride touches a path, guests begin arriving within a
second or two: arrivals need `parkOpen`, ≥1 reachable open ride, and ≥3 path tiles
(`src/game/guests/GuestSimulation.ts:234-238`), and the spawn timer starts at 1 s
(`src/game/guests/GuestSimulation.ts:77`).

> **"Why is nothing happening?"** — If the ride does *not* touch a path, nothing happens at all
> and nothing says why. The Pulse fallback does cover it — *"Connect a path beside a ride so
> guests can discover it."* (`src/ui/Hud.tsx:88-89`) — which is a genuinely good catch. But the
> ride plot's fence opening, which is the visual signal for the access rule
> (`src/rendering/WorldRenderer.ts:802-820`), is drawn only where a path already touches, so an
> unreachable ride simply looks like a fully fenced ride. There is no "not connected" badge.

Two frictions arrive almost immediately:

> **"Where did my tool go?"** — With the path tool armed, starting a drag on top of the ride you
> just built selects the ride and **silently disarms the build tool**
> (`src/app/GameApp.ts:473-481` → `selectObjectAt` → `cancelTool` at `src/app/GameApp.ts:786`).
> Rides are 3×3 or 4×3, so this happens constantly when routing a path past an attraction.
> → **PA-007**

> **"Why can't I click this?"** — After two rides and a stall the player drops under $1,600, and
> Harbor Swings goes grey and stops responding, with no badge, no tooltip and no message
> (`src/ui/Hud.tsx:174, 189-195`). The locked cards next to it explain themselves in full. Money
> is the only build blocker in the game that says nothing. → **PA-003**

### 5–15 minutes — needs, services, the first plateau

Thirst grows at 0.34/s from a 8–35 start (`src/game/config.ts:18`, `GuestSimulation.ts:144`), so
the drink threshold of 34 (`src/game/config.ts:42`) is crossed within roughly a minute of a
guest arriving. Hunger follows in two to five minutes. Without stalls, guests think *"I can't
find anything to drink."*, Park Pulse aggregates it into *"N guests cannot find a drink stall."*
(`src/game/guests/GuestSimulation.ts:47-65, 216-232`), and eventually they leave. This is the
loop working exactly as designed, and the feedback is excellent.

The player builds a Fizz Foundry ($420) and a Picnic Pocket ($480). Litter starts appearing from
completed purchases, a `cleanlinessLow` notification fires, and the Operations tab explains bins
and cleaners in plain language (`src/ui/ManagementDashboard.tsx:473-477`). Also good.

Then the crowd stops growing.

> **"Why has this stopped?"** — Guest arrivals are capped by
> `calculateOrganicGuestPotential() = floor((8 + attractionCapacity × 2.2) × (0.45 + rating/100))`
> (`src/game/guests/GuestSimulation.ts:258-268`). With one 14-capacity carousel at rating 50 that
> is **36 guests**, and the park sits there forever. Nothing in the UI names this number, this
> formula, or the fact that ride *capacity* — not ride count, not path length, not scenery — is
> what raises it. `organicGuestPotential()` is a public method that exists and is never called by
> the game (`AUDIT_FINDINGS.md` §8). → **PA-009**

> **"Is money supposed to matter?"** — Every unlocked item in the catalog together costs about
> **$6,400** (3 flat rides $3,650 + 4 stalls $1,900 + Comfort Cabin $650 + comforts and scenery
> ~$190). The player starts with **$15,000**. There is no point in the first session where a
> build decision is a trade-off; the only real constraint is the research tree. The design promise
> "guests and finances make every layout choice matter" (`GAME_DESIGN.md`) does not bite here.
> → **PA-010**

### 15–30 minutes — research, breakdowns, the coaster

Research points are earned per completed rider: 1 RP each (`src/game/config.ts:46`,
`ProgressionSimulation.ts:143-157`). A 14-seat carousel cycling every ~46 s therefore produces
~14 RP per cycle. The three tier-1 projects cost 25–30 RP each.

> **"That was it?"** — All three opening projects are affordable within two or three minutes of
> the first ride running, and the `experiences-25` and `experiences-100` milestones fall almost
> immediately. The branch the design describes ("a real branch between another ride, a faster food
> counter, and landmark scenery") never happens: the player buys all three. After that, everything
> is gated on rating 60/70 and cash, and the RP counter is decorative. → **PA-014**

Around here rides begin to wear and break. This part reads very well: an `!` badge over the ride
(`src/rendering/WorldRenderer.ts:977-1007`), a `critical` notification, a condition meter with
reliability and per-cycle breakdown risk in the inspector (`src/ui/Hud.tsx:364-384`), and
Operations advice naming the fix. Nothing to change.

A thrill-seeking player now tries a coaster, and this is where the session can genuinely fall
apart.

> **"I just lost twenty minutes."** — The coaster draft is destroyed, with no confirmation and no
> way back, by: right-clicking (`src/rendering/WorldRenderer.ts:1104` → `cancelTool` →
> `clearCoasterDraft`, `src/app/GameApp.ts:729-735`), pressing Escape, or hovering the grid after
> clicking any other catalog card (`src/app/GameApp.ts:454`). Right-click is the natural "undo
> that last piece" reflex, and it wipes a 30-piece layout. `Undo` only pops one piece
> (`src/app/GameApp.ts:598-602`). → **PA-008**

> **"Where did my grid button go?"** — The designer panel sits at `left: 18px; top: 94px`
> (`src/ui/styles.css:1121-1124`), exactly on top of the utility column at `left: 18px; top: 96px`
> (`src/ui/styles.css:502-509`). It is later in the DOM (`src/ui/App.tsx:29` vs `:36`) and has
> `pointer-events: auto`, so it completely hides and blocks the grid toggle, the scenery heatmap
> toggle and the performance overlay toggle — while the player is doing the one task in the game
> that most needs the grid. → **PA-004**

> **"How do I make a hill?"** — `R`/`F` set a *target* height that new pieces climb toward one
> level per piece (`src/app/GameApp.ts:646-660`), and the loop must return to within one level of
> the flat station. The panel explains the controls but never the consequence: to close a loop
> that reached height 2 you must press `F` at least two pieces before you arrive back. The
> validation message that eventually appears — *"The track can only climb or fall one level per
> piece."* — names the rule but not the piece. There is no per-piece editing, only pop-the-last.

### 30–60 minutes — the ceiling

By now the park has three rides, four services, bins, a cleaner and a mechanic. The dashboard is
genuinely strong: rating with eleven evidence-backed factors, finance categories, trends,
estate overview with camera-focus rows. Two readability gaps show up when the player tries to
act on it.

> **"What does this number mean?"** — Rating factors are shown as `score / 100` with a detail
> line, but never with their **weight** (`src/ui/ManagementDashboard.tsx:76-82`;
> weights at `src/game/management/ManagementSimulation.ts:61-73`). Scenery appeal at 12 and Guest
> happiness at 12 look equally bad, but happiness is worth 0.17 of the rating and park size 0.06.
> The player cannot tell which zero to go and fix. → **PA-016**

> **"Am I lagging?"** — The performance overlay's `VISIBLE` row prints the *total* entity count,
> not a visible count (`src/rendering/WorldRenderer.ts:335-345`, `src/ui/Hud.tsx:286`). There is no
> viewport culling at all, so the label is not just wrong, it advertises a feature that does not
> exist. → **PA-017**

And then the session ends, in the worst possible way.

> **"Where is my park?"** — There is no save. Closing the tab, reloading, or a renderer crash
> destroys an hour of play. The only thing that survives is the Park Tour card collection in
> localStorage (`src/game/tour/TourManager.ts:141-148`). → **PA-001**

Also never discovered in a full hour of sandbox: Park Tour, Pulse Cards, scenarios, and the
reward-draft meta-progression. All of it is behind a `⚑ Parks` button in the top bar
(`src/ui/Hud.tsx:48-50`) that the game never opens, never mentions, and never suggests.
→ **PA-011**

---

## Part 2 — Findings

Sorted by priority, then by estimated size (small first).

---

### CRITICAL

#### PA-001 — No park save or load
- **Priority:** CRITICAL · **Category:** UX · **Size:** L
- **Where:** No serialization exists. `src/game/World.ts:47-346` (no `toJSON`/`serialize`);
  `src/game/session/ParkSession.ts:32-250`; the only persistence in the repo is
  `src/game/tour/TourManager.ts:112-148` (localStorage, tour profile only).
- **Player experience:** An hour-long park is destroyed by a reload, a tab close, a laptop sleep,
  or the renderer error path at `src/ui/App.tsx:25`. Nothing warns the player, and there is no
  "you have unsaved work" guard. This alone makes the 30–60 minute band of the game unshippable.
- **Fix:** Phase 12. Explicit typed serialization boundaries per simulation, IndexedDB store,
  autosave + manual save + slots, schema version and migrations, interrupted-session recovery.
  Renderer containers and React state must never enter a save; the seeded RNG state
  (`src/game/guests/GuestSimulation.ts:30-36`) must, or reloads are non-deterministic.

#### PA-002 — No undo for any construction gesture
- **Superseded in Phase 12 step 3.** The one-level construction undo described below (and `ConstructionUndo`, `GameWorld.undoConstruction`, `probeUndoInteraction`, the *Undo build* label and the "demolition can't be undone yet" refusal) was replaced by snapshot undo: a ring of whole-park snapshots that also covers demolition. The text below is the Phase 11 history.
- **Status:** ✅ **FIXED (Phase 11), scoped to construction.** One level of undo, 100 % refund, no
  time limit, `Ctrl+Z` and an **Undo build** control in the dock's tool row.
  `src/game/build/undo.ts` owns the rules; `src/game/World.ts:undoConstruction` performs the
  reversal (removing exactly the cells or object the gesture added and booking the refund back
  against `construction`, so the ledger nets to zero instead of showing income);
  `src/game/session/ParkSession.ts:probeUndoInteraction` answers "has anybody used this yet?" from
  the live simulations. `buildPaths` now reports the cells it accepted, so undo removes those and
  never a tile that was already there.
  - Undo is withdrawn for exactly three reasons, and the control names which one applies:
    a guest or staff member has interacted with **that** object (queued, ridden, used the bin, or
    been assigned it as a work task); the player has changed **that** object's opening or price;
    or another construction gesture has happened. Deliberately *not* invalidated by guest movement,
    payroll or any other economy tick, condition decay, revenue, breakdowns, or elapsed simulation
    time — a bench nobody has sat near is still undoable five minutes later, and there is a test
    that runs a live park for five minutes to prove it.
  - Invalidation is scoped to the built object: closing a ride at the far end of the park does not
    withdraw the undo of a bench. Rides are created `open: true`
    (`RideSimulation.syncWithWorld`), so "opened" means a deliberate act on that object, never the
    default state — otherwise every ride would be un-undoable the moment it was paid for.
  - **A demolition ends the pending undo**, detected from `GameWorld.demolitions` rather than from
    a call the UI has to remember. That is correctness, not defensiveness: bulldozing one tile of a
    five-tile drag leaves the other four standing, so a target-scoped check would have removed those
    four and refunded all five on top of the salvage already paid.
  - **Demolition is out of scope** until Phase 12 can restore a snapshot: removing a building
    destroys per-object state (ticket price, the player's open/closed intent, condition, revenue
    history) that a one-level undo cannot put back honestly. So the affordance is never called just
    "Undo": the button says **Undo build**, and after a demolition the refusal says "Nothing to
    undo — demolition can't be undone yet" rather than doing nothing. In exchange demolition got
    its own receipt (`demolitionToast` in `src/app/placementFeedback.ts`): "Demolished Moonpetal
    Carousel · $180 refunded", naming the building when a single mistaken removal is what happened.
  - The refusal is enforced in `ConstructionUndo.undo`, not just displayed, so a stale button or a
    keypress landing the same tick a guest queues cannot slip through.
  - The control names what the **next** press does in the context the player is standing in —
    *Undo track piece* inside the coaster designer, where the key repeats, and *Undo build* out in
    the world, where it does not. Button and keyboard route through the same `undoLastBuild`, so the
    label can never promise one thing and the click do another.
  - Undo is covered by `syncWorldEquivalence.test.ts` like every other world mutation: build then
    undo, for objects, path drags, a path against a ride's fence, and coasters, with a renderer sync
    in between so the incremental scene has to survive the intermediate state rather than skipping
    over it.
- **Priority:** CRITICAL · **Category:** UX · **Size:** M
- **Where:** No undo command exists (`src/app/gameBridge.ts:4-36`). The only `undo` in the tree is
  the coaster *draft* pop at `src/app/GameApp.ts:598-602`. `buildPaths`
  (`src/game/World.ts:233-245`), `buildObject` (`src/game/World.ts:247-257`), `placeCoaster`
  (`src/game/World.ts:188-222`) and `bulldoze` (`src/game/World.ts:264-295`) keep no history.
- **Player experience:** Every misclick is permanent and taxed. Bulldozing refunds 20 %
  (`src/game/config.ts:6`), so a mis-rotated $2,850 Cloud Hopper costs $2,280 to correct. Because
  paths paint on drag, a slip that paints 30 tiles into a plot costs money *and* a second gesture
  to clean up. Combined with PA-007 (a stray click disarms the tool) the opening minutes punish
  ordinary mouse noise.
- **Fix:** One gesture-scoped undo stack in `GameApp` holding inverse operations for the four
  world mutations, `Ctrl+Z` plus a dock button, cleared on session change. Refund at full cost when
  undoing rather than at the bulldoze rate. `GAME_DESIGN.md` already promises this.

---

### HIGH

#### PA-003 — An unaffordable build card is disabled with no reason given
- **Status:** ✅ **FIXED (Phase 11)** — the card is no longer `disabled`. It carries a
  `SHORT $660` badge and a reason line "⛁ Need $1,600 · you have $940", matching how locked and
  scenario-locked cards already explain themselves, and it stays pickable so the coral ghost can
  be lined up while the player earns the money. Coaster types therefore open the designer at any
  cash level; the designer's own "Not enough cash." line still gates the build.
- **Priority:** HIGH · **Category:** UX · **Size:** S
- **Where:** `src/ui/Hud.tsx:174` (`unaffordable`), `:189-195` (`disabled`, `title` undefined for
  this case), `src/ui/styles.css:476`.
- **Player experience:** The card greys out and stops responding. Locked cards beside it show a
  `LOCKED` badge, a reason line and a tooltip; scenario-locked cards show `UNAVAILABLE` and the
  constraint. Money is the only blocker in the game that explains nothing — and it is the blocker a
  new player hits first.
- **Fix:** Keep the card interactive, add a `$` badge and a reason line ("Need $1,600 — you have
  $940"), and on click select the item anyway so the coral ghost and cursor readout explain the
  rest. Same treatment for the coaster type cards, which currently cannot open the designer at all
  when cash is below the station price.

#### PA-004 — The coaster designer panel covers the utility bar
- **Status:** ✅ **FIXED (Phase 11)** — the designer moved to its own left-panel region
  (`left: 74px`), clearing the utility rail. `src/ui/styles.css` now opens with a documented map
  of every screen region and the full stacking order, and every floating panel carries an explicit
  `z-index`. Two further collisions were found while writing that map and fixed with it: the
  performance overlay also sat at `left: 68px` (moved to the bottom-left), and the help hint and
  cursor readout were drawn on top of the build dock (both raised clear of it). One remaining
  overlap is filed separately as PA-027.
- **Priority:** HIGH · **Category:** UX · **Size:** S
- **Where:** `src/ui/styles.css:1121-1134` (`left: 18px; top: 94px; width: 250px`,
  `pointer-events: auto`, no `z-index`) versus `src/ui/styles.css:502-509`
  (`left: 18px; top: 96px`). DOM order `src/ui/App.tsx:29` (UtilityBar) before `:36` (CoasterPanel).
- **Player experience:** Opening the coaster designer hides and blocks the grid toggle, the scenery
  heatmap toggle and the performance toggle — exactly when the grid is most needed to lay track.
  The buttons are still there, invisible, under the panel.
- **Fix:** Move the designer panel to the right of the utility column (`left: 74px`) or dock it
  bottom-left above the build dock. Give both a `z-index` so the stacking is intentional.

#### PA-005 — Keyboard shortcuts stay live behind modal overlays
- **Status:** ✅ **FIXED (Phase 11)** — solved structurally together with PA-020 and the `R`/`F`
  collision by the input context stack in `src/ui/inputContext.ts`, consumed by
  `GameApp.handleShortcuts` and `WorldRenderer.setViewInputEnabled`. Covered by
  `src/ui/inputContext.test.ts`.
- **Priority:** HIGH · **Category:** UX · **Size:** S
- **Where:** `src/app/GameApp.ts:834-860` — the only guard is `target?.tagName === 'INPUT'`. The
  backdrops block the pointer (`src/ui/styles.css:812-823`) but not the keyboard.
- **Player experience:** Reading the Park Tour map and pressing `1` or `2` (which read as node
  labels) silently changes the simulation speed of the park behind the modal. `b` arms the
  bulldozer, `p` swaps to the path tool, `r` rotates. The player closes the modal and their tool
  and speed have changed for no visible reason. `Ctrl+B` and `Cmd+P` also fire, because no
  modifier check exists.
- **Fix:** Gate `handleShortcuts` on "no modal open" (scenario picker, loadout, reward draft,
  result overlay), ignore events with `ctrlKey`/`metaKey`/`altKey`, and extend the input guard to
  `TEXTAREA` and `isContentEditable`. Keep `Escape` live.

#### PA-006 — Bulldozer drags skip tiles and rebuild the whole scene per tile
- **Equivalence proof:** the incremental `syncWorld` is a cache, and caches fail silently, so
  `src/rendering/syncWorldEquivalence.test.ts` runs 16 seeded sequences of 40 random world
  mutations each — 640 comparisons — and asserts after every single step that the incrementally
  maintained scene is identical to one a renderer built from scratch on the same world: same
  displays, transforms, visibility, recorded geometry and plot-art signatures. The mutation set
  covers the cases the caching is most likely to get wrong (paths appearing and disappearing
  against a ride plot, rides removed beside a path, batched drags, rotated footprints, coasters
  placed and removed), and a coverage test fails if any of them never once changed the world.
  **No divergence found.** The test was itself validated by sabotage: never rebuilding a ride
  base, never removing a destroyed object's display, and never redrawing the walkway graphic are
  each caught, with the failure naming the exact mutation that broke it.
- **Status:** ✅ **FIXED (Phase 11)** — three changes. The bulldozer drag interpolates with
  `lineCells`, so it clears every tile the pointer crossed. `GameWorld.batch()` runs a whole
  gesture as one world change, so listeners rebuild once. And `WorldRenderer.syncWorld()` is
  incremental: per-object displays created and destroyed individually, one walkway graphic
  redrawn only on a path-version change, and a ride's plot art rebuilt only when the fence
  opening actually moved. Measured against the dev park (5,081 drawing calls for a full rebuild):

  | Gesture | Before | After |
  | --- | --- | --- |
  | World change with nothing to do | 5,081 | **0** |
  | Place one decoration | 5,081 | **11** |
  | Place one ride | 5,081 | **501** |
  | Clear one path tile | 5,081 | **550** |
  | Clear twelve tiles in one drag | 60,972 | **879** |
  | Demolish one ride | 5,081 | **0** |

  Guarded by `src/rendering/constructionCost.test.ts` with both absolute ceilings and fractions of
  a measured full rebuild. A hidden scenery heatmap is also no longer built on every placement.
- **Priority:** HIGH · **Category:** PERFORMANCE · **Size:** S
- **Where:** `src/app/GameApp.ts:496-500` bulldozes only the current cell, with no
  `lineCells` interpolation — unlike the path branch at `src/app/GameApp.ts:508-513`. Each
  `world.bulldoze` fires `changed()` (`src/game/World.ts:272, 291`) →
  `GameApp.onWorldChanged` (`src/app/GameApp.ts:737-746`) → `renderer.syncWorld()`
  (`src/rendering/WorldRenderer.ts:243-260`), which destroys and rebuilds **every** path,
  ride, coaster and decoration display in the park.
- **Player experience:** Dragging the bulldozer along a path leaves a dotted line of surviving
  tiles that must be cleaned up by hand, and in a built-up park each cleared tile costs a full
  scene rebuild, so the drag stutters exactly while it is being imprecise.
- **Fix:** Interpolate the bulldozer drag with `lineCells`, and batch the gesture: suppress
  `changed()` until pointer-up, or make `syncWorld` incremental (rebuild only the affected
  object/path displays). The batching also removes the stutter when path painting commits.

#### PA-007 — Clicking a building silently disarms the active build tool
- **Status:** ✅ **FIXED (Phase 11)** — `ToolMode` gained an explicit `pointer` tool and lost
  `null`, so exactly one tool is armed at all times and only the player changes it. `handleStart`
  no longer inspects on behalf of a build tool, `selectObjectAt` no longer calls `cancelTool`, and
  a blocked placement now names what is in the way and points at `Esc`. The armed tool is stated
  three ways: the Select button in the dock, a persistent armed-tool line under the tabs, and the
  canvas cursor. Covered by `src/ui/store.test.ts`.
- **Priority:** HIGH · **Category:** UX · **Size:** S
- **Where:** `src/app/GameApp.ts:473-481` checks `world.objectAt(cell)` *before* the selected
  definition; `selectObjectAt` then calls `useUiStore.getState().cancelTool()`
  (`src/app/GameApp.ts:786`).
- **Player experience:** Placing a row of benches or routing a path past a 3×3 ride, one click
  lands on the ride: the inspector opens, the tool is gone, the next click does nothing, and the
  player has to go back to the dock and re-pick the item. There is no message. Because rides and
  stalls occupy large footprints near paths, this fires several times a minute.
- **Fix:** While a build tool is armed, a click on an occupied cell should report "That footprint
  is blocked" and keep the tool. Reserve object selection for the pointer tool (no definition
  selected) and an explicit modifier or right-click-free inspect gesture. At minimum, restore the
  previous tool when the inspector closes.

#### PA-008 — An in-progress coaster layout is discarded silently
- **Status:** ✅ **FIXED (Phase 11)** — reported from a browser playtest, which turned up a second
  bug the code reading had missed: the layout was *drawn* into the preview layer, which is cleared
  on every pointer move, so the track vanished from the plot whenever the cursor left it or crossed
  a panel while the panel still read "2 pcs". The layout now owns its own render layer, dimmed to
  0.45 while another tool is armed. It survives tool changes and coaster-type changes, and re-arming
  the type brings the panel and the track straight back without waiting for a hover. `Escape` and
  right-click step back one piece instead of discarding; only Clear discards, and above four pieces
  it asks first. Covered by `src/rendering/coasterDraft.test.ts`.
- **Priority:** HIGH · **Category:** UX · **Size:** M
- **Where:** `src/app/GameApp.ts:729-735` (`cancelTool` → `clearCoasterDraft`), reached from
  right-click (`src/rendering/WorldRenderer.ts:1104`) and `Escape` (`src/app/GameApp.ts:841`);
  plus `src/app/GameApp.ts:454`, which clears the draft as soon as the cursor moves over the grid
  with any other definition selected. `coasterUndo` only pops one piece
  (`src/app/GameApp.ts:598-602`).
- **Player experience:** Twenty minutes of track design vanish because the player right-clicked
  — the standard "cancel the last thing" reflex — or clicked another catalog card to check a
  price. No confirmation, no recovery.
- **Fix:** Keep the draft when the tool changes and restore it when the coaster type is
  re-selected. Make right-click and `Escape` step back one piece while a draft exists, and require
  the explicit **Clear** button (with a confirm above ~5 pieces) to discard the whole layout.

#### PA-009 — The guest count silently hits an invisible ceiling
- **Status:** ✅ **FIXED (Phase 11, 2026-10-14)** — `GuestSimulation.capacityView()` reads the ceiling exactly as
  `updateArrivals` compares against it (one shared helper, so the numbers are identical; the formula has since gained
  the card `crowdCapacityMultiplier` and the 1,000-guest maximum). The Pulse guests stat reads `41` over `of 52 guests`
  (`max 491 guests` while more guests are inside than the ceiling allows), the Overview has a GUESTS `of 52` KPI and a
  "Park capacity" section after the rating that names ride seats, the rating, an active card multiplier, the hard
  maximum, or why nobody arrives (park closed, outside opening hours, fewer than 3 path tiles, no reachable open ride).
  After 10 simulated seconds at the ceiling the number turns amber and a `◍` "At capacity" line joins the Pulse; after
  60 s one `important` toast fires. That notice is app-layer (`src/app/capacityNotice.ts`) and never saved, because a
  new Management notification would change saved state. Copy: `src/ui/capacityModel.ts`.
- **Priority:** HIGH · **Category:** READABILITY · **Size:** M
- **Where:** `src/game/guests/GuestSimulation.ts:258-268`
  (`floor((8 + attractionCapacity × 2.2) × (0.45 + rating / 100))`), enforced at
  `src/game/guests/GuestSimulation.ts:238`. `organicGuestPotential()` exists as a public accessor
  (`:208-212`) and is never called by the game or the UI.
- **Player experience:** The crowd grows, then stops dead — 36 guests with one carousel, and it
  will not move no matter how many paths, benches, stalls or trees are added. Nothing anywhere
  states the ceiling or that **ride capacity** and **park rating** are the only two inputs. The
  player concludes the simulation is broken, or that the game is over.
- **Fix:** Surface it. A "Park capacity: 41 of 52 guests" line in the Park Pulse header and a
  matching rating-adjacent stat in the Overview tab, with a one-line explanation naming ride
  capacity and rating. A notification when the park sits at capacity for a sustained period.

#### PA-010 — Starting cash exceeds the entire unlocked catalog
- **Leak check:** all four scenarios declare their own starting cash ($9,000 / $11,000 / $14,000 /
  $16,000) and every tour node references a scenario by id, so the sandbox change did not reach
  Park Tour. Now guarded by tests in `src/game/scenarios/ScenarioSimulation.test.ts`, so a future
  scenario cannot silently inherit the sandbox constant.
- **Consequence found:** the smaller reserve made PA-028 (a permanent no-win state) materially
  easier to reach.
- **Status:** ✅ **FIXED (Phase 16, confirmed 2026-10-13)** — starting cash $15,000 → $5,000 in the
  Phase 11 pre-task, confirmed by the Phase 16 balance pass with bot evidence (BN-001 in
  `BALANCE_NOTES.md`, no longer PROVISIONAL). The three strategy bots (`src/game/balance/`) spend
  $3,424–$3,819 on their openings, bottom out at $396–$417 and are healthy at 45 minutes; the browser
  audit placed each opening by hand from $5,000 with at least $1,150 left. Ride prices, ticket
  prices and running costs were confirmed unchanged (they are read live by saved parks), and the
  scenario starting cash ($9,000–$16,000) stays by decision: those parks race a deadline from
  minute 0. The owner's browser playtest of each strategy is the remaining check.
- **Priority:** HIGH · **Category:** BALANCE · **Size:** M
- **Where:** `src/game/config.ts:4` (`startingCash: 15_000`) against the unlocked subset of
  `src/game/content/catalog.ts` — everything not gated by `src/game/progression/content.ts`
  totals roughly **$6,400** (rides $3,650, stalls $1,900, Comfort Cabin $650, comforts/scenery
  ~$190), plus $12/tile paths.
- **Player experience:** For the whole first session the player can build one of everything and
  still hold more than half their money. No build is a trade-off, prices never need tuning, and
  the finance dashboard shows a number that never constrains anything. The design promise that
  "finances make every layout choice matter" is not true of the opening hour. Combined with
  PA-014 (research is over-supplied with RP) the first 30 minutes have no scarcity of any kind.
- **Fix:** Phase 16. Lower sandbox starting cash toward the cost of a path run plus one ride and
  one stall, and/or raise early ride costs so the opening choice is genuinely "one good ride or two
  cheap ones". Requires a balance pass with `BALANCE_NOTES.md`, not a single constant change.

---

#### PA-028 — A park can reach a permanent no-win state, and nothing says so
- **Priority:** HIGH · **Category:** GAMEPLAY · **Size:** M
- **Found:** investigating whether PA-010's lower starting cash left a floor under the player.
- **Where:** `src/game/World.ts:336-340` — `recordTransaction` does `this.cash += amount` with no
  clamp and no insolvency path. `src/game/operations/OperationsSimulation.ts:192-212` — `hireStaff`
  checks only the crew cap, never cash, and immediately charges a first-shift wage.
  `src/game/operations/OperationsSimulation.ts:101-117, 744-775` — payroll is charged per worker
  every 30 s from `step()`, with no cash check and **no park-open gate**.
  `src/game/guests/GuestSimulation.ts:234-238` — arrivals require an open, reachable, open-state
  ride, so with no ride standing income is exactly zero.
- **Measured, on a fresh sandbox:**

  | Probe | Result |
  | --- | --- |
  | Hire a cleaner with $0 in the bank | Succeeds, and the first-shift wage takes cash to **−$12** |
  | Park **closed**, two staff, 120 s of simulation | $4,970 → **$4,850**; wages bill while nothing earns |
  | Withdraw past zero | Cash reaches **−$40,000**; there is no floor |
  | Negative cash, last ride demolished, 10 minutes of simulation | cash **−$500 → −$500**, guests 0, park potential 0. Nothing recovers, ever |
  | Insolvent park | Still open. The only reaction anywhere is one `cashNegative` notification |

- **Player experience:** The trap is not "negative cash" — it is **cash below the cheapest ride
  ($900) with no reachable open ride standing**. From there income is permanently zero, the
  bulldozer returns only 20% of what was paid, and no amount of waiting changes anything. The game
  never says the park is unrecoverable; it keeps running, keeps billing wages, and keeps showing a
  park rating. The most plausible route in is the one PA-010 made narrower: a player at ~$930 with
  three rides hires staff, wages drain, and they panic-demolish rides for refunds that do not cover
  the wages.
- **Not a hard lock on the application** — the Parks menu can start a fresh sandbox — which is why
  this is HIGH and not CRITICAL. It is a lock on the park the player has been building for an hour,
  with no acknowledgement.
- **Status:** ⚠️ **PARTIALLY FIXED (Phase 11)** — options 1 and 2 shipped; the wage model is
  deliberately unchanged (option 3 declined: billing only while open would make "close the park"
  a dominant move and remove the tension between expanding and running the place), and option 4
  belongs to Phase 16.
  1. **Hiring guard** — `OperationsSimulation.hireBlock()` refuses a hire unless cash covers the
     new worker's first shift, their next payout, and the existing crew's next payout. Refusals are
     typed, so the toast names the shortfall in the same phrasing as a blocked placement:
     "Wages must be covered first · Need $96 · you have $40". Covered by five tests in
     `src/game/operations/OperationsSimulation.test.ts`.
  2. **Stall detection** — `src/game/management/parkStall.ts` asks one question, *could income
     resume?*, and treats a free action as an answer rather than a symptom. It does **not** fire
     when a reachable ride exists (opening it and the park costs nothing), when a stranded ride
     could be connected for the price of a path tile, when a service can still earn from a crowd
     that is still inside, or when cash covers the cheapest buildable ride — the coaster floor
     being station plus minimum legal track, not the station price the catalog advertises. When it
     does fire it names the exits that actually exist in that park (dismissing the crew, with the
     wage bill; demolition proceeds, when they would cover a ride) and otherwise says plainly that
     the park cannot recover and points at the Parks menu. Announced once through
     `evaluateCondition`, so it holds while true and re-arms only after income becomes possible
     again. Ten unit tests on the pure logic, including the minute-four false positive, plus five
     integration tests through the full simulation.
- **Options, cheapest first (1 and 2 implemented):**
  1. **Refuse to hire** without enough cash for at least one payroll interval. One guard, matches
     how every other spend already behaves, closes the "hire at $0" route.
  2. **Detect the dead end and say so:** no reachable open ride *and* cash below the cheapest
     buildable ride ⇒ a critical Park Pulse notification naming the condition, and an offer to
     restart. Feedback only, no new economy, no simulation change.
  3. **Wages only bill while the park is open** (or never push cash below zero). Fixes the closed-park
     drain and matches the intuition that a closed park is not operating. This one changes
     simulation behaviour, so it needs an explicit call.
  4. A loan, an emergency grant, or a bankruptcy reset. Deliberately **not** proposed for Phase 11 —
     that is a new economic mechanic and belongs with the Phase 16 balance pass.

  Deviation from the brief, deliberate: a reachable closed **service** was specified as
  sufficient to rule out a stall, but a service cannot attract anybody on its own — arrivals
  require an open ride (`src/game/guests/GuestSimulation.ts:234-238`) — so a park with a closed
  lemonade stand and no ride at all is exactly the dead end the notice exists for. It therefore
  counts as a way out only while guests are still inside, which is when a service genuinely can
  earn. Both branches are tested.

### MEDIUM

#### PA-011 — Park Tour, Pulse Cards and scenarios are never surfaced
- **Priority:** MEDIUM · **Category:** CONTENT · **Size:** S
- **Where:** The only entry point is the `⚑ Parks` button (`src/ui/Hud.tsx:48-50`). `GameApp`
  starts sandbox directly (`src/app/GameApp.ts:67`) and never opens the picker.
- **Player experience:** An entire mode — the branching map, loadouts, card tradeoffs, objectives,
  reward drafts — can be missed completely. Nothing in the sandbox HUD hints it exists.
- **Fix:** Phase 13. Open the Parks map on a first run with no stored profile, and add a
  Park Pulse prompt once the sandbox park is stable.

#### PA-012 — Developer cheats ship in the player HUD
- **Status:** ✅ **FIXED (Phase 11 pre-task)** — `src/app/devMode.ts` reads an explicit `?dev=1` /
  `parksmith-dev` flag once at load. The cheat buttons, the force-breakdown action and the
  Developer Park are hidden without it, and every developer command is refused at the command
  layer in `GameApp` as well, so hiding a button is not the only defence.
- **Priority:** MEDIUM · **Category:** UX · **Size:** S
- **Where:** `src/ui/Hud.tsx:267-270` (`＋$`, `＋G`, `＋＋G`, `−G`),
  `src/ui/Hud.tsx:409-416` (`DEV · Force breakdown` inside the ride inspector),
  `src/ui/ScenarioHud.tsx:438-443` (dev park in the Parks modal).
- **Player experience:** Four unlabelled glyph buttons sit permanently beside the grid toggle;
  `＋$` grants $5,000. A new player will press them, and any balance judgement they form is then
  meaningless. It also makes honest playtesting impossible.
- **Fix:** Gate the developer group behind a query flag or a settings toggle, visually separate it,
  and keep it out of the default build.

#### PA-013 — Coaster types read as ordinary ride cards
- **Priority:** MEDIUM · **Category:** READABILITY · **Size:** S
- **Where:** `src/ui/Hud.tsx:212` (`{definition.custom ? 'from ' : ''}$…`),
  `src/ui/Hud.tsx:180-181` (`Designer` intensity tag).
- **Player experience:** *Comet Trail* "from $400" is the cheapest card in the Rides list and does
  something entirely different from every other card: it opens a track designer with a 12-piece
  closed-loop, flat-station, must-have-a-drop requirement (`src/game/coaster/design.ts:82-141`).
  The `Designer` tag is small and its meaning is not stated anywhere.
- **Fix:** Give coaster cards a distinct visual treatment and a one-line "Design your own track"
  subtitle, and open the designer panel with its instruction line the moment the card is selected
  rather than on first hover over the grid.

#### PA-014 — Research points are earned far faster than the tree can absorb
- **Priority:** MEDIUM · **Category:** BALANCE · **Size:** S
- **Where:** `src/game/config.ts:46-47` (1 RP per completed rider), awarded per rider in
  `src/game/progression/ProgressionSimulation.ts:143-157`; project costs 25–30 RP for the three
  openers (`src/game/progression/content.ts:9-41`); milestones at 25 and 100 experiences
  (`:120-136`).
- **Player experience:** One 14-seat ride produces ~14 RP per 46-second cycle, so all three
  opening projects and the first two milestones clear within minutes. The "real branch" between
  another ride, a faster food counter and landmark scenery never happens — the player takes all
  three — and the RP counter stops meaning anything for the rest of the session.
- **Fix:** Phase 16. Either raise project RP costs by roughly an order of magnitude relative to
  rider throughput, or scale RP by *distinct* experiences rather than raw rider count, so the
  branch decision survives past the first ride.
- **Status:** ✅ **FIXED (Phase 16, 2026-10-13)** — the first option, as a research cost scale: a
  new park stores `researchCostScale` 10 and every project costs ten times its base RP (cash costs
  and milestone rewards unchanged; old saves keep scale 1). The tree grew to 14 projects (8,150 RP
  at scale 10). Measured with the strategy bots: the first purchase lands at 3.9–5.4 minutes, none
  can hold all four openers (1,250 RP) by minute 12 (776–1,008 RP earned), and at 45 minutes they
  hold 6–8 of 14 projects. Details in `BALANCE_NOTES.md` "Phase 16".

#### PA-015 — No demolish action on the selected building
- **Status:** ✅ **FIXED (Phase 11, 2026-10-14)** — the undo part was already fixed by Phase 12's snapshot ring. The
  ride and stall inspectors end with **Demolish · refund $340**; it opens a "Confirm demolition" group with focus on
  **Keep it**, and **Demolish** there removes the object as one undo entry ("Comet Coaster demolished"; one Ctrl+Z
  restores it), shows the refund toast and closes the inspector. `Delete` and `Backspace` (a fixed row in
  KEYBINDINGS.md) open the same confirmation, only while the inspector has the keyboard. Demolish is refused while a
  coaster layout is open. In the bulldozer, a press on a coaster cell only arms the coaster (the hover and an alert toast
  say "Click again to demolish …"); a second press on the same coaster demolishes it, any other press, Esc, a tool
  change or a session swap disarms it, and a drag never removes a coaster. The 20 % refund is unchanged.
- **Priority:** MEDIUM · **Category:** UX · **Size:** S
- **Where:** The inspector owns open/close, price, and even a dev breakdown button, but no delete
  (`src/ui/Hud.tsx:316-469`). Removal requires the bulldozer (`src/app/GameApp.ts:843`,
  `src/ui/Hud.tsx:165`), and there is no `Delete`/`Backspace` binding.
- **Player experience:** To remove the ride you are looking at, you must close the inspector, arm
  the bulldozer, find the ride again, and click it — with no confirmation, no undo (PA-002), and a
  20 % refund. For a coaster, one track click removes the whole ride with no warning
  (`src/game/World.ts:280-292`).
- **Fix:** A "Demolish · refund $N" button in the inspector with a confirmation, plus `Delete` as
  a binding for the selected object. Confirm before removing a coaster from a single track cell.

#### PA-016 — Rating factors are shown without their weights
- **Status:** ✅ **FIXED (Phase 11, 2026-10-14)** — each factor row adds "17% of the rating · 15 pts to gain" (or
  "full marks"), and the rows are sorted by whole points to gain, then by weight, with "Biggest gains first." under the
  chart (`src/ui/ratingFactorModel.ts`).
- **Priority:** MEDIUM · **Category:** READABILITY · **Size:** S
- **Where:** `src/ui/ManagementDashboard.tsx:76-82` renders label, detail, bar and score. The
  `RatingFactor` already carries `weight` and `contribution`
  (`src/game/management/ManagementSimulation.ts:632-636`); weights range 0.06–0.17
  (`:61-73`).
- **Player experience:** Eleven factors all look equally important. The player cannot see that
  Guest happiness is nearly three times as valuable as Park size, so they fix the wrong zero.
- **Fix:** Show the contribution ("12 / 100 · worth 17 % of your rating") and sort factors by lost
  contribution so the biggest opportunity is at the top.

#### PA-017 — The performance overlay's "VISIBLE" is a total, not a visible count
- **Status:** ✅ **FIXED (Phase 11)** — renamed to `ENTITIES` in the overlay and to `entities`
  through `getPerformance` and the UI store, with the field documented as a total. It becomes a
  real visible count only if Phase 11B adds culling. *(Phase 11B was closed on 2026-10-13 without building: the
  classic renderer is legacy. The classic count stays a total; the voxel renderer reports its own.)*
- **Priority:** MEDIUM · **Category:** READABILITY · **Size:** S
- **Where:** `src/rendering/WorldRenderer.ts:335-345` sums objects + paths + guests + workers +
  litter; rendered as `VISIBLE` at `src/ui/Hud.tsx:286`. There is no viewport culling anywhere
  (`AUDIT_FINDINGS.md` §3).
- **Player experience:** Anyone diagnosing a frame-rate problem — including us — reads a number
  that does not mean what it says and concludes culling is working.
- **Fix:** Rename to `ENTITIES` now; make it a real visible count when Phase 11 adds culling.

#### PA-018 — Guest and staff motion is stepped at 10 Hz with no interpolation
- **Priority:** MEDIUM · **Category:** GAMEPLAY · **Size:** M
- **Where:** The clock advances in 100 ms steps (`src/game/config.ts:7`); `walk()` moves guests
  fractionally per step (`src/game/guests/GuestSimulation.ts:471-480`); the renderer draws them at
  `guest.position` with no interpolation (`src/rendering/WorldRenderer.ts:876, 889`).
- **Player experience:** At 1× guests advance ~0.19 cells per visible jump; at 4× the jump is
  ~0.74 cells — roughly 24 screen pixels at default zoom. The crowd stutters instead of flowing,
  which reads as low frame rate even at a locked 60 fps.
- **Fix:** Interpolate display position between the previous and current simulation positions
  using the clock's step accumulator. `ARCHITECTURE.md` already claims this behaviour; it is not
  implemented.

#### PA-019 — "Blocked or unaffordable" merges two different problems
- **Status:** ✅ **FIXED (Phase 11)** — the readout now prints the exact reason, derived from the
  same `world.checkObjectBuild` call that refuses the build, and worded by the same function the
  toast uses (`src/app/placementFeedback.ts`). Five causes that shared one string now read
  distinctly: "Complete its research project first", "Need $1,600 · you have $940", "Blocked by
  Moonpetal Carousel", "That footprint runs off the plot", "Path cannot be built here". The two
  surfaces never fire together — a refused click records the cell it explained, and the readout
  stays quiet about that cell until the cursor moves — and only the toast appends guidance
  ("— press Esc to inspect it"). Both invariants are covered by
  `src/app/placementFeedback.test.ts`.
- **Priority:** MEDIUM · **Category:** READABILITY · **Size:** S
- **Where:** `src/ui/Hud.tsx:233`; validity is computed as unlocked ∧ placeable ∧ affordable at
  `src/app/GameApp.ts:459-461`, so the reason is known and then thrown away.
- **Player experience:** The ghost turns coral and the player cannot tell whether to move the
  building or to earn money. The click-time toast does distinguish the two
  (`src/app/GameApp.ts:549-554`), so the information exists one interaction too late.
- **Fix:** Carry the reason into `setHover` and print it: "Blocked", "Need $1,600", "Needs Spin
  Studies".

#### PA-020 — Escape leaves the loadout screen by closing the whole Parks modal
- **Status:** ✅ **FIXED (Phase 11)** — `Escape` now pops exactly one layer of the input context
  stack: reward draft (blocked, with a "Draft a card to continue" hint) → scenario result →
  loadout → park map → management → inspector → build tool → world.
- **Priority:** MEDIUM · **Category:** UX · **Size:** S
- **Where:** `src/app/GameApp.ts:838` calls `closeScenarioPicker`, which also clears the loadout
  (`src/ui/store.ts:185`). The on-screen "Back to parks" button instead calls `closeLoadout`
  (`src/ui/ScenarioHud.tsx:187`).
- **Player experience:** Escape from card selection throws the player back to the park instead of
  the map, losing their node selection. Escape also does nothing at all on the reward draft and the
  scenario result overlay (`src/ui/ScenarioHud.tsx:501-543`).
- **Fix:** Make Escape pop one modal layer at a time: reward draft → result → loadout → map →
  park.

#### PA-021 — The camera has no bounds and no easing
- **Status:** ✅ **FIXED (Phase 11, 2026-10-14), voxel renderer only** — the classic renderer is legacy and keeps an
  unclamped, snapping camera. The voxel camera keeps the ground point under the viewport centre within a margin of the
  plot, so a plot cell always stays on screen (at 1100x690 panning up can still leave it just behind the build dock).
  Estate-row clicks, the brand button and recentre glide over 250 ms (instant with reduced motion). Recentre has a ⌂
  button ("Recentre view · V") in the bottom-right map-view pill and the rebindable key `V`.
- **Priority:** MEDIUM · **Category:** UX · **Size:** S
- **Where:** `src/rendering/WorldRenderer.ts:1159-1169` (WASD pan, unclamped),
  `:1143-1151` (wheel zoom, scale clamped 0.42–1.65 but position unclamped),
  `:224-241` (`focusCell` / `focusEntrance` snap; the `animate` parameter does nothing).
- **Player experience:** Holding `D` walks the park off the screen into empty green with no way to
  tell which direction home is. Recovery is the brand logo in the top-left, whose purpose is only
  in a tooltip. Estate-overview row clicks teleport the camera with no motion cue, so it is not
  obvious the view moved.
- **Fix:** Clamp the camera so at least part of the plot stays on screen, ease `focusCell` over
  ~250 ms, and give the recentre action a visible affordance.

#### PA-022 — Build rotation persists silently across catalog selections
- **Status:** ✅ **FIXED (Phase 11, 2026-10-14)** — kept sticky and made visible (a default open for the owner to
  overturn): while turned, the Rotate button shows `90°` / `180°` / `270°` (named "Rotate, now turned 90°") and the
  cursor readout `⟳ 90° · 3×2 · R to rotate`.
- **Priority:** MEDIUM · **Category:** UX · **Size:** S
- **Where:** `src/ui/store.ts:65-66, 166-167` — `selectBuild` does not reset `buildRotation`.
- **Player experience:** After rotating a bench, the next 3×2 shop arrives rotated to 2×3 for no
  visible reason. The cursor readout does state `⟳ 2×3` (`src/ui/Hud.tsx:234-238`), so the
  information is there, but the cause is not.
- **Fix:** Either reset rotation on selection change, or show the persistent rotation state on the
  Rotate button itself so it is visibly sticky.

---

### LOW

#### PA-023 — Dead evidence payloads are deep-copied four times a second
- **Status:** ✅ **FIXED (Phase 11, 2026-10-14)** — only `health` was still dead and is deleted. `parkScenery` and
  `UiState.scenery` are read since Phase 16 (the Overview scenery factor and the inspector theme line); see
  `AUDIT_FINDINGS.md` §8 for every row.
- **Priority:** LOW · **Category:** TECHNICAL · **Size:** S
- **Where:** `ManagementSnapshot.health` (`src/game/management/ManagementSimulation.ts:381, 503`),
  `ManagementSnapshot.parkScenery` (`:375-380`, copies every scenery cell, source and destination),
  and `UiState.scenery` (`src/ui/store.ts:81`, written at `src/app/GameApp.ts:414, 760`). None is
  read by any component. Snapshots run at 4 Hz from `src/app/GameApp.ts:396-425`.
- **Player experience:** None directly — it is allocation churn in the same 4 Hz path that already
  copies litter, bins and workers, on the lowest-end machines we care about.
- **Fix:** Delete the three payloads and the unused accessors listed in `AUDIT_FINDINGS.md` §8, or
  wire `parkScenery`/`health` into something the player can see.

#### PA-024 — An unreachable ride looks identical to a reachable one
- **Status:** ✅ **FIXED (Phase 11, 2026-10-14)** — a ride or stall with no path from the gate gets a static slate
  "no entry" badge in the voxel renderer (after broken and maintenance alerts), its estate row ends "· no path access",
  and its inspector says "No path access: no path from the gate reaches it, so guests cannot use it." No classic badge
  (legacy).
- **Priority:** LOW · **Category:** READABILITY · **Size:** S
- **Where:** The plot fence opens only where a path already touches
  (`src/rendering/WorldRenderer.ts:802-820`); reachability itself is computed in
  `src/game/guests/GuestSimulation.ts:270-300` and never rendered.
- **Player experience:** A ride one tile away from the path is fully fenced and simply never used.
  The Park Pulse fallback covers the zero-guest case, but not "one of my six rides is orphaned".
- **Fix:** A "no path access" badge on the plot and a `status` value in the estate overview row.

#### PA-025 — Undiscovered Pulse Cards give no hint how they are earned
- **Priority:** LOW · **Category:** CONTENT · **Size:** S
- **Where:** `src/ui/ScenarioHud.tsx:396-403` renders `❔ — — —` with the tooltip
  "Undiscovered card".
- **Player experience:** The collection strip shows how many cards exist but not that clearing a
  tour park is what reveals them.
- **Fix:** One line under the strip: "Clear a park to draft one of three new cards."

#### PA-027 — The Park Pulse and the inspector share the right rail and can overlap
- **Priority:** LOW · **Category:** UX · **Size:** S
- **Found:** while writing the screen-region map for PA-004.
- **Where:** `src/ui/styles.css` — `.pulse-card` is anchored `right: 18px; top: 94px` and grows
  downward; `.ride-inspector` is anchored `right: 18px; top: 365px` with `z-index: 4`. The
  inspector also runs into the right end of the build dock on viewports narrower than ~1250px.
- **Player experience:** In a Park Tour park the Pulse card carries the scenario panel as well as
  the research button and grows past 365px, so opening an inspector covers the objective clock.
  In Sandbox the card is short enough that it never happens, which is why it was not caught in the
  playtest walkthrough.
- **Fix:** Flow the right rail as one column (pulse, then inspector) instead of two absolute
  anchors, and give the dock a right margin the inspector respects. Deferred: it is a layout
  refactor of a region PA-004 only had to document.

#### PA-026 — No loading state, no version, no recovery from a fatal renderer error
- **Priority:** LOW · **Category:** TECHNICAL · **Size:** S
- **Where:** `index.html` renders an empty `#root`; `src/ui/App.tsx:13-25` shows a bare
  "Park closed unexpectedly" panel with no reload action and no way back to a park.
- **Player experience:** A blank green screen during Pixi init, and a dead end if init fails.
- **Fix:** Phase 19. A branded loading state, a version string, and a reload/recover action on the
  fatal panel (which becomes meaningful once PA-001 lands).

#### PA-029 — New rides open themselves, so the onboarding step "open the ride" is already done
- **Priority:** MEDIUM · **Category:** UX · **Size:** S
- **Where:** `src/game/rides/RideSimulation.ts` creates every runtime with `open: true` when it
  syncs a newly placed ride, and `src/game/shops/ShopSimulation.ts` does the same for services.
  Phase 13's onboarding progression in `IMPLEMENTATION_PLAN.md` lists "build your first ride" and
  "open the ride" as separate steps.
- **Player experience:** The onboarding sequence would tick off "open the ride" in the same instant
  it appears, teaching the player that the checklist is decoration rather than instruction. The
  underlying rule is also invisible: nothing tells a new player that what they just paid for is
  already running, or that the open/closed control exists at all. Found while implementing PA-002,
  where default-open also forced the undo invalidation rule to distinguish a deliberate opening
  from the default one.
- **Fix:** A Phase 13 decision between two options, not a bug fix:
  - **(a) New rides start closed.** Gives the onboarding step something real to do and makes the
    open/closed control discoverable at the moment it matters. Costs every experienced player one
    extra action per ride, forever, and turns "built and forgot to open it" into a new failure mode
    that needs its own nudge.
  - **(b) Keep default-open and replace the onboarding step** with one that has a real action
    behind it — connect the ride to the entrance path, or set a ticket price. Keeps building
    frictionless; leaves the per-ride control as something the player meets later, in the
    inspector. Note that the park itself also starts open (`GAME_CONFIG.startingOpen: true`), so
    under (b) there is no "opening" act left anywhere in the opening minutes.
- **Decided (Phase 13, step 1): option (b).** Rides, services and the park keep starting open. The
  onboarding steps are "build a ride by the path" (connected to the gate path) and "set a ticket
  price" (a deliberate change from the default); nothing reads whether a ride is open, so closing
  and reopening rides stays a free choice that can never undo or block a step.

---

## Status

Closed in Phase 11 so far: PA-002 (scoped to construction; demolition undo is a Phase 12 item),
PA-003, PA-004, PA-005, PA-006, PA-007, PA-008, PA-012, PA-017, PA-019, PA-020, PA-010
provisionally, and PA-028 partially. Open CRITICAL/HIGH then: PA-001 (Phase 12), PA-009 (both closed since, below).
Filed while implementing Phase 11, deferred by decision: PA-027 (right-rail layout, Phase 19),
PA-029 (default-open rides vs the onboarding sequence, Phase 13).

Phase 16 (2026-10-13) closed PA-010 (the $5,000 start confirmed, no longer provisional) and PA-014
(research cost scale).

Phase 11 closed its remaining findings on 2026-10-14: PA-009, PA-015, PA-016, PA-021 (voxel renderer only), PA-022,
PA-023 and PA-024. PA-009 is no longer open, and with PA-001 fixed by Phase 12 there is **no open CRITICAL/HIGH
finding** (PA-028 stays partially fixed by decision: the wage model is unchanged). The Phase 11 browser playtest (a
sandbox hour with developer tools off, re-running Part 1) is the owner's and still open.

Phase 11B (classic viewport culling) was closed on 2026-10-13 without building: the classic renderer is legacy and the
voxel renderer is the default, so its entry criterion (Developer Park, 1,000 guests, 6x throttling, below 55 fps in the
classic renderer) is moot. The headless PA-006 numbers in IMPLEMENTATION_PLAN.md stand as the record. PA-018 closed the
same day: interpolation exists in the voxel renderer and the classic one keeps stepping.

## Top 10 fixes for Phase 11

In the order I would implement them. Items 1–7 are the Phase 11 UX pass proper; 8–10 are the
persistence and readability work that makes a long session survivable and is shared with Phase 12.

| # | Finding | Why first | Size |
| --- | --- | --- | --- |
| 1 | **PA-007** Clicking a building disarms the build tool | Highest friction per minute of play, and a few lines in `handleStart` | S |
| 2 | **PA-003** Unaffordable cards explain nothing | The first blocker a new player meets; makes money legible everywhere | S |
| 3 | **PA-004** Coaster panel covers the utility bar | A pure CSS/stacking bug that blocks the grid during track design | S |
| 4 | **PA-005** Shortcuts fire behind modals | Silently changes speed and tools; one guard clause | S |
| 5 | **PA-006** Bulldozer skips tiles and rebuilds the scene per tile | Fixes an imprecise gesture and the stutter that makes it worse | S |
| 6 | **PA-019** + **PA-017** Ambiguous "Blocked or unaffordable"; mislabelled `VISIBLE` | Two small readability corrections that ride along with 2 and 5 | S |
| 7 | **PA-008** Coaster draft discarded silently | The largest single loss of player work outside a page reload | M |
| 8 | **PA-002** Construction undo | Retires the design's oldest broken promise; changes how every build gesture feels | M |
| 9 | **PA-009** Surface the park capacity ceiling | Turns "the game is broken" into "I need more ride capacity" | M |
| 10 | **PA-016** + **PA-015** Rating factor weights; demolish from the inspector | Makes the dashboard actionable and completes the delete story | S |

Deliberately **not** in Phase 11: PA-001 (save/load) is Phase 12 on its own; PA-010 and PA-014
(economy and research pacing) belong in the Phase 16 balance pass with `BALANCE_NOTES.md`;
PA-011 (mode discovery) is Phase 13; PA-018 (motion interpolation) is Phase 15; PA-012
(developer tools) is Phase 18/19.
