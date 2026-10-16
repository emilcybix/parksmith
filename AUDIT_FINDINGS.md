# Audit Findings

Verified against the code in `src/` on 2026-08-30, not against the documentation.
Where documentation and a working implementation disagree, the implementation is treated
as the source of truth and the documentation is corrected (see *Documentation corrections*
at the end).

Baseline at audit time: `yarn lint`, `yarn typecheck`, `yarn test` (20 files, 154 tests) and
`yarn build` all pass. No gameplay code was changed during this audit.

---

## 1. Undo of the last construction gesture — **MISSING**

There is no undo anywhere in the construction pipeline.

| Evidence | Where |
| --- | --- |
| The only `undo` in the whole source tree is the coaster **draft** undo | `src/app/gameBridge.ts:32`, `src/app/GameApp.ts:598-602`, `src/ui/Hud.tsx:533` |
| `coasterUndo()` pops one *unbuilt* draft piece; it cannot touch a built coaster | `src/app/GameApp.ts:598-602` |
| `GameWorld` has no history, no command log, and no inverse operations | `src/game/World.ts:47-346` |
| `buildPaths` mutates `paths` and posts a transaction with no record of what was added | `src/game/World.ts:233-245` |
| `buildObject` / `placeCoaster` likewise | `src/game/World.ts:247-257`, `src/game/World.ts:188-222` |
| `bulldoze` deletes occupancy, object and coaster records outright | `src/game/World.ts:264-295` |
| `GameCommands` exposes no undo command | `src/app/gameBridge.ts:4-36` |

Consequence: the only way to reverse a construction mistake is the bulldozer, which refunds
`GAME_CONFIG.bulldozeRefundRate` = **20 %** (`src/game/config.ts:6`). A misplaced Cloud Hopper
costs the player $2,280 with no recourse.

`GAME_DESIGN.md` explicitly promises "one undoable gesture" for sketch-to-build. That promise
is not implemented.

## 2. Full park-state save/load to IndexedDB — **MISSING**

IndexedDB is not referenced anywhere in the repository. The only persistence that exists is the
Park Tour profile, and it uses **localStorage**, not IndexedDB.

| Evidence | Where |
| --- | --- |
| `grep -rn "indexedDB\|IndexedDB" src` → no matches | — |
| The one persistence path: `TourManager` with an injected `TourStorage` | `src/game/tour/TourManager.ts:42-149` |
| Storage key and JSON shape (route + card collection only) | `src/game/tour/TourManager.ts:13-23` |
| The app injects `window.localStorage` | `src/app/GameApp.ts:37-43`, `src/app/GameApp.ts:101` |
| No `serialize`/`deserialize`/`toJSON` exists on `GameWorld`, any simulation, or `ParkSession` | `src/game/World.ts`, `src/game/session/ParkSession.ts` |

What is persisted today: `discoveredCardIds`, `tour.ownedCardIds`, `tour.unlockedNodeIds`,
`tour.completedNodeIds` (`src/game/tour/types.ts` → `TourProfileV1`).

What is **not** persisted (lost on refresh): the entire park. Concretely, the state that a real
save would need to cover, and where it lives today:

- `GameWorld`: `paths`, `objects`, `coasters`, `coasterHeights`, `occupancy`, `transactions`,
  `cash`, `tick`, `parkOpen`, `nextObjectId`, `nextTransactionId` — `src/game/World.ts:50-67`
- `GuestSimulation`: the `guests` map, `nextGuestId`, `totalArrivalsCount`, `spawnTimerSeconds`,
  and the **private `SeededRandom` state** (`src/game/guests/GuestSimulation.ts:30-36, 68-82`).
  Without the RNG state, a reloaded park is not deterministic.
- `RideSimulation` runtime instances (open state, price, queues, cycle clocks, revenue, wear,
  breakdown/maintenance state) — `src/game/rides/RideSimulation.ts`
- `ShopSimulation` service instances — `src/game/shops/ShopSimulation.ts`
- `OperationsSimulation`: `bins`, `litter`, `staff`, `trainingLevel`, `elapsedSeconds`,
  `nextStaffId`, payroll accumulators — `src/game/operations/OperationsSimulation.ts:77-87`
- `ProgressionSimulation`: RP, completed projects/milestones, per-object completion counters —
  `src/game/progression/ProgressionSimulation.ts:34-42`
- `ManagementSimulation`: finance ledger, trend buffer, notifications, elapsed time —
  `src/game/management/ManagementSimulation.ts:290-305`
- `ScenarioSimulation` elapsed time and latched result — `src/game/scenarios/ScenarioSimulation.ts`
- `ParkSession`: `rules`, `activeCards`, `seed`, scenario id — `src/game/session/ParkSession.ts:33-44`
- Camera position and zoom — `src/rendering/WorldRenderer.ts:105` (`camera` container)

There is also no park name, no playtime counter, no schema version for park data, and no
save slots. Phase 12 is entirely greenfield.

## 3. Viewport culling for guests, staff, scenery, effects — **MISSING**

No culling of any kind exists. Every simulated entity gets a display and every display is
updated every frame regardless of whether it is on screen.

| Entity | Sync loop | Culling? |
| --- | --- | --- |
| Guests | `src/rendering/WorldRenderer.ts:864-899` | none — iterates the whole `guests` map |
| Staff | `src/rendering/WorldRenderer.ts:914-932` | none |
| Litter | `src/rendering/WorldRenderer.ts:934-950` | none |
| Bin indicators | `src/rendering/WorldRenderer.ts:952-975` | none |
| Ride alerts | `src/rendering/WorldRenderer.ts:977-1007` | none |
| Coaster trains | `src/rendering/WorldRenderer.ts:555-650` | none |
| Ride machinery | `src/rendering/WorldRenderer.ts:685-704` | none — animates every ride |
| Scenery bob | `src/rendering/WorldRenderer.ts:323-325` | none |

The only visibility logic is semantic, not spatial: a guest is hidden while riding/shopping
(`src/rendering/WorldRenderer.ts:872-875`) and a bin indicator is hidden at zero fill
(`src/rendering/WorldRenderer.ts:973`).

Related defect: the performance overlay's **VISIBLE** counter is mislabelled. It reports
`objects + paths + guests + workers + litter` — a *total*, never a visible count
(`src/rendering/WorldRenderer.ts:335-345`, displayed at `src/ui/Hud.tsx:286`).

`ARCHITECTURE.md:54` is accurate here: it says culling "remains available if the browser frame
rate ever demands it", i.e. it correctly documents culling as *not* implemented.
`IMPLEMENTATION_PLAN.md:210` also correctly lists it as the next lever.

## 4. Zero Graphics-rebuild in steady state — **PARTIAL: the test exists, but it does not cover all renderers**

The test exists and is real: `src/rendering/frameCost.test.ts` patches twelve `Graphics`
drawing methods and asserts **zero** calls.

Two cases are covered:
1. `createRideArt` for every non-custom catalog ride, animated across a full cycle
   (`src/rendering/frameCost.test.ts:49-69`).
2. A full dev-park `renderer.update()` frame with 300 guests, after 100 simulation steps
   (`src/rendering/frameCost.test.ts:71-88`).

Case 2 exercises the camera, guests, staff, litter, bins, ride alerts, ride machinery, coaster
trains and the scenery bob — so the *steady-state world frame* really is rebuild-free.

**Not covered — these renderers rebuild geometry, and all of them run during construction:**

| Renderer | Where | Rebuild trigger |
| --- | --- | --- |
| `syncWorld()` destroys and re-creates **every** static display in the park | `src/rendering/WorldRenderer.ts:243-260` | any `world.changed()` — via `GameApp.onWorldChanged` (`src/app/GameApp.ts:737-746`) |
| `drawPreview()` + `drawPreviewArt()` re-builds the full ghost building | `src/rendering/WorldRenderer.ts:267-313` | every `pointermove` while a build tool is armed |
| `drawSceneryPreview()` re-fills the whole influence radius | `src/rendering/WorldRenderer.ts:394-428` | every `pointermove` over scenery |
| `drawCoasterDraft()` re-draws the whole track | `src/rendering/WorldRenderer.ts:507-530` | every `pointermove` while designing |
| `drawTerrain()` re-draws 1,024 diamonds | `src/rendering/WorldRenderer.ts:353-365` | grid toggle |
| `refreshSelection()` | `src/rendering/WorldRenderer.ts:1083-1100` | selection change |
| `drawSceneryInfluence()` | `src/rendering/WorldRenderer.ts:367-392` | version-guarded, so cheap |

The worst of these is `syncWorld()`: bulldozing while dragging calls `world.bulldoze()` per cell
(`src/app/GameApp.ts:570-577`), each of which fires `changed()` and therefore a **complete
teardown and rebuild of every path, ride, coaster and decoration in the park** — once per tile
dragged over. See PA-006 in `PLAYABILITY_AUDIT.md`.

## 5. Insufficient-funds feedback in every build flow — **PARTIAL / INCONSISTENT**

Six flows can be blocked by cash. They behave five different ways.

| Flow | Feedback | Verdict |
| --- | --- | --- |
| Path drag | Coral preview + running cost, readout "Blocked or unaffordable" (`src/ui/Hud.tsx:233`), toast "Not enough cash" on release (`src/app/GameApp.ts:538`) | ✅ but the readout merges *blocked* and *unaffordable* into one message |
| Object placement, card already selected | Coral preview (`src/app/GameApp.ts:459-463`), same ambiguous readout, toast "Not enough cash" (`src/app/GameApp.ts:551-553`) | ✅ same ambiguity |
| **Object placement, from the catalog** | Card is `disabled` and greyed with **no reason text and no tooltip** (`src/ui/Hud.tsx:174, 189-195`); `title` is `undefined` for the unaffordable case (`src/ui/Hud.tsx:193-195`) | ❌ the only build blocker with no explanation — compare the locked case, which gets a `LOCKED` badge *and* a reason line (`src/ui/Hud.tsx:197, 209`) |
| **Coaster type, from the catalog** | Same as above — the card is disabled when `cash < definition.buildCost` (the "from" station price) | ❌ the designer cannot even be opened, with no reason given |
| Coaster build | Panel prints "Not enough cash." (`src/app/GameApp.ts:720`), build button disabled (`src/ui/Hud.tsx:535`), toast on click (`src/app/GameApp.ts:626-628`) | ✅ best-in-class |
| Research purchase | Button disabled + card body "Still needed: 30 RP and $250." (`src/ui/ManagementDashboard.tsx:179-182, 216`), toast on failure (`src/app/GameApp.ts:298-302`) | ✅ best-in-class |
| Staff training | Button disabled when unaffordable (`src/ui/ManagementDashboard.tsx:406`), but the tooltip only states the price, never "you cannot afford this" (`src/ui/ManagementDashboard.tsx:407-409`); toast on click is correct (`src/app/GameApp.ts:264-268`) | ⚠️ partial |
| Staff hire | **No cash check at all** — hiring is refused only by crew capacity (`src/app/GameApp.ts:251-259`) | ⚠️ intentional (payroll-only cost) but undocumented in the UI |

Summary: the coaster designer and the research tab explain funding perfectly; the build catalog —
the flow a new player uses first and most — explains nothing.

## 6. Rotate / delete / cancel — **INCONSISTENT**

### Rotate
- `R` (`src/app/GameApp.ts:857-859`) and the dock **Rotate** button (`src/ui/Hud.tsx:164`).
- In the coaster designer `R`/`F` are re-bound to track height (`src/app/GameApp.ts:854-856`),
  and the Rotate button then toasts "This piece has nothing to rotate" (`src/app/GameApp.ts:176-178`).
  The cursor readout correctly hides its "R to rotate" hint for custom pieces (`src/ui/Hud.tsx:227`).
- Rotation is a **placement** property only. There is no way to rotate an already-placed building;
  `PlacedObject.rotation` is written once at build time (`src/game/World.ts:251`).
- No counter-clockwise binding (no `Shift+R`); `rotateBuild` only ever adds a quarter turn
  (`src/ui/store.ts:167`).
- Rotation **persists across catalog selections** (`src/ui/store.ts:65-66, 166-167`). Picking a new
  2×3 shop silently places it rotated. Documented as deliberate; still surprising.

### Delete
- `B` (`src/app/GameApp.ts:843`) and the dock **Clear** button (`src/ui/Hud.tsx:165`). No
  `Delete` / `Backspace` binding.
- **No demolish action exists in the ride or service inspector** (`src/ui/Hud.tsx:316-469`) even
  though those panels own every other per-object control.
- Bulldozing is immediate, with no confirmation and no undo, at a 20 % refund
  (`src/game/World.ts:264-295`, `src/game/config.ts:6`).
- Bulldozing any coaster track cell removes the whole ride (`src/game/World.ts:280-292`) — correct
  and documented, but there is no warning before it happens.
- Behaviour differs from path painting: the bulldozer drag does **not** interpolate between
  pointer samples (`src/app/GameApp.ts:496-500` vs. the path branch at `src/app/GameApp.ts:508-513`),
  so a fast drag skips tiles.

### Cancel
- `Escape` (`src/app/GameApp.ts:837-842`) walks a priority chain: scenario picker → management
  dashboard → inspector → tool.
- Right-click (`src/rendering/WorldRenderer.ts:1104`) **skips the chain** and goes straight to
  `cancelTool()`, which also destroys any coaster draft (`src/app/GameApp.ts:729-735`).
- `Escape` does **not** close: the loadout view (it closes the entire Parks modal instead of
  returning to the map — `src/ui/store.ts:185`), the reward draft, or the scenario result overlay
  (`src/ui/ScenarioHud.tsx:501-543`).
- All of `B`, `P`, `G`, `R`, `0`, `1`, `2`, `4` remain live **while a modal overlay is open**, because
  `handleShortcuts` only guards against `INPUT` targets (`src/app/GameApp.ts:835-836`). The
  backdrops block the mouse (`src/ui/styles.css:812-823`) but not the keyboard.
- `handleShortcuts` also ignores modifier keys, so `Ctrl+B`, `Cmd+P` etc. trigger tools.

## 7. Locked catalog content — **MOSTLY YES, one gap**

Locked content is surfaced in four places, and three of them explain the requirement fully.

| Surface | Explanation shown | Verdict |
| --- | --- | --- |
| Build dock card, research lock | `LOCKED` badge, "⌑ Requires {project name}", tooltip "Research X to build Y", click jumps to the focused research card | ⚠️ names the project but **never the RP or cash cost, prerequisite chain, or milestone** — `src/ui/Hud.tsx:171, 195-197, 209` |
| Build dock card, scenario lock | `UNAVAILABLE` badge, "⚑ {constraint name}", tooltip with the constraint detail | ✅ `src/ui/Hud.tsx:172, 193-194, 198, 210` |
| Research tab project card | RP cost, cash cost, prerequisites, required milestone, unlocks, and "Still needed: N RP and $M" | ✅ `src/ui/ManagementDashboard.tsx:191-227` |
| Tour map, locked node | "Clear the previous park on the route to reveal its objective, conditions, and reward." | ✅ `src/ui/ScenarioHud.tsx:355-361` |
| Pulse Card collection, undiscovered card | Renders `❔ — — —` with tooltip "Undiscovered card" — no hint about how cards are earned | ⚠️ `src/ui/ScenarioHud.tsx:396-403` |

Enforcement is genuinely authoritative: `ProgressionSimulation` installs itself as the world's
`BuildAccessPolicy` in its constructor (`src/game/progression/ProgressionSimulation.ts:45-47`),
and `ParkSession` composes the scenario lock list on top of it when one exists
(`src/game/session/ParkSession.ts:77-82`). `World.checkObjectBuild` and `World.placeCoaster` both
consult it (`src/game/World.ts:143`, `src/game/World.ts:196`). The UI cannot bypass a lock.

## 8. Park Pulse — evidence sources actually in use, and dead code

### Live evidence sources

| Source | Produced at | Consumed at |
| --- | --- | --- |
| Aggregated guest thoughts (`thoughtInsights`, count ≥ 2, top 3) | `src/game/guests/GuestSimulation.ts:216-232` | Pulse card top 2 (`src/ui/Hud.tsx:112-115`), Overview top 3 (`src/ui/ManagementDashboard.tsx:143`), Activity all (`src/ui/ManagementDashboard.tsx:556`) |
| Average happiness, park rating, notification count | `src/game/management/ManagementSimulation.ts:311-341` | Pulse header (`src/ui/Hud.tsx:77-79, 107-111`) |
| Threshold notifications (cash, unmet needs, cleanliness, queues, falling rating, breakdowns, research) | `src/game/management/ManagementSimulation.ts:820-1005` | Floating notifications (`src/ui/ManagementDashboard.tsx:755-786`), Activity tab (`src/ui/ManagementDashboard.tsx:545-551`) |
| Research points, next milestone, ready projects | `src/game/progression/ProgressionSimulation.ts:107-122` | Pulse research button (`src/ui/Hud.tsx:119-134`) |
| Scenario objective, pace, deadline, constraint, active cards | `src/game/scenarios/ScenarioSimulation.ts`, `src/game/session/ParkSession.ts:237-249` | `ScenarioPanel` (`src/ui/ScenarioHud.tsx:83-123`) |
| Rating factors with detail strings | `src/game/management/ManagementSimulation.ts:553-636` | Overview rating section (`src/ui/ManagementDashboard.tsx:119-123`) |

### Not simulation evidence, but presented as a Pulse line

The Pulse card's fallback insight is a **hard-coded UI heuristic**, not simulation evidence
(`src/ui/Hud.tsx:85-93`): it branches on `objectCount`, `pathCount`, `guestCount` and `cash` to
produce "Sketch a path from the gate…", "Cash is getting tight…", etc. It is the only thing a new
player sees for the first several minutes, and it is the one Pulse line that has no evidence
behind it.

### Dead code / dead payloads

| Item | Where | Status |
| --- | --- | --- |
| `ManagementSimulation.consumeNotifications()` | `src/game/management/ManagementSimulation.ts:391-395` | never called outside tests |
| `ManagementSnapshot.health` / `healthSnapshot()` | `src/game/management/ManagementSimulation.ts:381, 503` | computed on every snapshot, rendered nowhere |
| `ManagementSnapshot.parkScenery` | `src/game/management/ManagementSimulation.ts:375-380` | deep-copies every scenery cell, source and destination on every snapshot; rendered nowhere |
| `UiState.scenery` (`ScenerySnapshot`) | `src/ui/store.ts:81`, written at `src/app/GameApp.ts:414, 760` | never read by any component |
| `ProgressionSimulation.grantResearchPoints()` | `src/game/progression/ProgressionSimulation.ts:132-137` | never called outside tests |
| `TourManager.tourCompleted` | `src/game/tour/TourManager.ts:57-61` | never called; `ScenarioHud` recomputes it inline (`src/ui/ScenarioHud.tsx:414`) |
| `GuestSimulation.organicGuestPotential()` | `src/game/guests/GuestSimulation.ts:208-212` | never called outside tests — **and this is the number that silently caps the crowd** (see PA-009) |
| `GuestSimulation.arrivalIntervalMultiplier` getter | `src/game/guests/GuestSimulation.ts:186-188` | never called outside tests |
| `WorldRenderer.focusEntrance(animate)` parameter | `src/rendering/WorldRenderer.ts:232-241` | both branches do the same thing |

The three snapshot payloads (`health`, `parkScenery`, `store.scenery`) are rebuilt and deep-copied
four times per second from `src/app/GameApp.ts:396-425`, for nothing.

**Verdicts, Phase 11 PA-023 (2026-10-14).** Each row re-checked against the code; the line numbers above predate
Phases 12 to 28.

| Item | Verdict |
| --- | --- |
| `consumeNotifications()` | **Kept** as a documented test seam: it is the drain of the serialize-equivalence test and about a dozen assertions. |
| `ManagementSnapshot.health` / `healthSnapshot()` | **Deleted**, with the `ManagementHealthSnapshot` type. The determinism observables hash `management.snapshot()`, so `withRetiredHealthKey` (`src/game/save/determinismHarness.ts`) re-inserts the key computed exactly as the deleted code did; no pin moved (`src/game/save/retiredHealth.test.ts`). It was never saved. |
| `ManagementSnapshot.parkScenery` | **Used** since Phase 16: the Overview scenery factor detail and the balance bot (`strategyBot.ts`). |
| `UiState.scenery` | **Used** since Phase 16: the inspector's theme line (`Hud.tsx`). |
| `ProgressionSimulation.grantResearchPoints()` | **Used**: card effects (`src/game/cards/effects.ts`) and the balance bot. |
| `TourManager.tourCompleted` | **Gone** with `TourManager` (retired; `src/app/tourRetired.static.test.ts`). |
| `GuestSimulation.organicGuestPotential()` | **Wired** by PA-009: a one-line wrapper over `capacityView()`, which the UI reads. |
| `GuestSimulation.arrivalIntervalMultiplier` getter | **Kept**: a two-line read accessor the ParkSession card-rule tests use. |
| `focusEntrance(animate)` parameter | **Gone**; since Phase 11 the voxel renderer's `focusEntrance(motion?)` does ease (PA-021). |

So the 4 Hz copy is now payloads that are read, except the deleted `health`.

---

## Documentation corrections applied

Statements in the docs that the code contradicts. These have been corrected in
`GAME_DESIGN.md` / `ARCHITECTURE.md` as part of this session; the original claims are recorded here.

| Doc | Claim | Reality |
| --- | --- | --- |
| `GAME_DESIGN.md` "Original identity" | "Sketch-to-build: paths paint continuously while dragging, with one cost preview and **one undoable gesture**." | Paths paint and preview cost correctly. There is **no undo**. |
| `GAME_DESIGN.md` "Rules for clarity" | "Costs appear before committing and **money changes animate visibly**." | Costs appear before committing. Money never animates — the cash pill is a plain re-render (`src/ui/Hud.tsx:52-60`) and there is no keyframe for it in `src/ui/styles.css`. |
| `GAME_DESIGN.md` "Research and park appeal" | "Locked **catalog cards** … explain the project, prerequisites, milestone, RP, and cash needed to use them." | The *research tab* card explains all of that. The *catalog* card names only the project. |
| `ARCHITECTURE.md` "Data flow" | "Pixi renders on animation frames and **interpolates future moving entities**." | No interpolation exists. Guests and staff are drawn directly at their simulation position, which advances at the 100 ms fixed step (`src/rendering/WorldRenderer.ts:876`, `src/game/guests/GuestSimulation.ts:450-480`). |
| `ARCHITECTURE.md` "Performance posture" | "Static geometry is rebuilt only after construction changes." | True but misleading: **all** static geometry is rebuilt on **any** world change, including a single bulldozed tile (`src/rendering/WorldRenderer.ts:243-260`). |
| `IMPLEMENTATION_PLAN.md` Phase 1 | "Money transactions and insufficient-funds feedback" marked done. | Partial — see section 5. Now annotated in the plan. |

Statements that were checked and found **accurate** (no change made): the rotation model
(`ARCHITECTURE.md` "World model"), simulation-authoritative build locks, the zero-rebuild frame
test, the coaster/`objectFootprint`/`rideProfile` contract, `ParkSession` isolation, the ruleset
compile order, the tour profile using localStorage, and the statement that pooling and viewport
culling remain unimplemented.
