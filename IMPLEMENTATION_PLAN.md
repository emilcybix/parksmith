# Implementation Plan

## Phase 0 — Foundation

- [x] Vite + TypeScript + React + PixiJS shell
- [x] Separated simulation, rendering, and UI modules
- [x] Isometric grid and original programmatic visual language
- [x] Mouse/middle-drag, WASD/arrow pan, cursor-centered wheel zoom
- [x] Deterministic fixed-step clock with pause, 1×, 2×, 4×
- [x] Developer performance overlay

## Phase 1 — Construction

- [x] Data-driven build catalog
- [x] Ghost preview with footprint, cost, and validity
- [x] Click/drag path painting with joins
- [x] Ride, shop, facility, amenity, and scenery placement
- [x] Money transactions and insufficient-funds feedback — *completed in Phase 11: every blocker
  now states its reason in one shared wording (PA-003, PA-019)*
- [x] Bulldozer with clear hover feedback — *drag interpolation and single-rebuild gestures added
  in Phase 11 (PA-006)*
- [x] Escape/right-click cancellation and keyboard shortcuts — *replaced in Phase 11 by the input
  context stack (PA-005, PA-020)*
- [x] Undo of the last construction gesture — *shipped in Phase 11 (PA-002), scoped to build
  gestures at 100% refund; superseded in Phase 12 step 3 by the snapshot undo, which also covers demolition*
- [ ] Browser playtest and balancing pass

## Phase 2 — Guests

- [x] Versioned cardinal path network
- [x] Shared destination route maps with path-change invalidation
- [x] Deterministic guest arrivals at the entrance
- [x] Compact individual needs, preferences, thoughts, and visit timers
- [x] Utility-based selection of reachable rides
- [x] Fixed-step path movement and visible guest animation
- [x] Park-closing and need-driven departure behavior
- [x] Recovery when paths or destinations are bulldozed
- [x] Guest count and pathfinding-rate developer metrics
- [x] Developer spawn/remove guest controls
- [ ] Browser playtest and arrival-rate balancing

## Phase 3 — Ride Operations

- [x] Separate data-driven ride definitions from runtime instances
- [x] Automatic logical queues at reachable ride access cells
- [x] Dispatch timing, capacity-limited boarding, and fixed ride cycles
- [x] Ticket payments and per-cycle operating expenses
- [x] Queue-wait estimation, guest patience, and abandonment
- [x] Preference/value/wait-based post-ride satisfaction
- [x] Visible queue formation and active/idle ride animation
- [x] Click selection and persistent footprint highlight
- [x] Contextual ride inspector with live operating metrics
- [x] Manual open/closed state and ticket-price controls
- [x] Throughput, riders, revenue, cost, and satisfaction tracking
- [ ] Browser playtest and queue/economy balancing

## Phase 4 — Guest Services

- [x] Catalog-driven food, drink, and toilet service definitions
- [x] Deterministic FIFO service queues and fixed service durations
- [x] Need-aware destination choice across rides and services
- [x] Purchases, guest budgets, park revenue, and affordability rechecks
- [x] Hunger, thirst, and toilet relief with post-purchase satisfaction
- [x] Queue patience, closure, removal, and path-change recovery
- [x] Visible service queues and hidden guests while actively served
- [x] Contextual service inspector with live price and open/closed controls
- [x] Aggregated actionable guest thoughts in Park Pulse
- [x] Full walk → queue → purchase → relief integration coverage
- [ ] Browser playtest and service-demand/value balancing

## Phase 5 — Park Management

- [x] Typed finance ledger with distinct ride, food, drink, facility, operating, construction, refund, and grant categories
- [x] Separate operating profit from total cash flow and capital spending
- [x] Live guest, happiness, queue, throughput, service, and need KPIs with bounded trends
- [x] Evidence-based park rating from implemented guest and park conditions
- [x] Park rating coupled to organic guest arrivals and park potential
- [x] Overview, finances, and activity dashboard tabs with recent transactions
- [x] Actionable threshold notifications and evidence-backed Park Pulse insights
- [x] Deterministic finance, rating, trend, notification, and integration coverage
- [ ] Browser playtest and economy/reputation balancing

## Phase 6 — Park Operations

- [x] Food and drink purchases produce deterministic waste that becomes path litter when no usable bin is nearby
- [x] Data-driven bins with capacity, fill state, reachable-use range, overflow pressure, and cleaner emptying
- [x] Hireable cleaners and mechanics that share the versioned path network, reserve distinct jobs, and recover from path or target removal
- [x] Local litter pressure lowers nearby guest happiness and produces readable cleanliness thoughts
- [x] Ride condition wear, catalog reliability, deterministic breakdown checks, and safe end-of-cycle failures
- [x] Broken rides stop accepting guests and earning revenue, release waiting queues, and preserve the player's intended open state
- [x] Preventive mechanic inspections and required breakdown repairs with visible progress
- [x] Staff payroll and ride maintenance costs included as typed operating expenses
- [x] Cleanliness and reliability integrated into park rating, trends, operational KPIs, and actionable notifications
- [x] Visible litter, moving staff, bin-fill indicators, broken-ride alerts, condition evidence, staff controls, and developer force-breakdown control
- [x] Deterministic unit and integration coverage for waste, bins, routing, cleaning, payroll, condition, breakdowns, and maintenance
- [ ] Browser playtest and operations pacing/balance pass

## Phase 7 — Research and Park Appeal

- [x] Earn deterministic research points from completed ride and service experiences without duplicate awards
- [x] Data-driven ride, service, and decoration research projects with exact RP, cash, prerequisite, and milestone requirements
- [x] Authoritative simulation-layer build locks with visible locked catalog cards and actionable requirement text
- [x] One-time experience and park-rating milestones that award research points
- [x] New fast-food and high-throughput facility alternatives unlocked through service research
- [x] Local scenery influence with catalog-driven appeal, radius, Manhattan falloff, overlap, clamping, and cache invalidation
- [x] Scenery influence integrated into guest destination choice, ride/service satisfaction, happiness, and park rating
- [x] Research finance category, Park Pulse research view, milestone evidence, and unlock feedback
- [x] Scenery heatmap/placement feedback plus exact local appeal evidence in ride and service inspectors
- [x] Deterministic unit and integration coverage for RP, purchases, locks, milestones, scenery falloff, removal, and rating
- [ ] Browser playtest and research/scenery balance pass

## Phase 8A — Scenario Sessions and Objectives

- [x] Add a resettable `ParkSession`/campaign boundary so each scenario starts from a clean deterministic world
- [x] Compile injected park rules from base rules and scenario conditions instead of mutating global configuration
- [x] Define data-driven scenarios with map setup, starting cash, simulation-time deadline, primary objective, optional constraint, card slots, and rewards
- [x] Evaluate typed objectives from simulation and management metrics such as cumulative visitors, operating profit, rating, happiness, and queue time
- [x] Support reach, earn, sustain, and deadline objectives without parsing labels or UI text
- [x] Show live objective progress, projected pace, and exact success/failure evidence in Park Pulse
- [x] Restart a failed park with the same seed and no leaked cash, guests, queues, timers, or transactions
- [x] Keep Sandbox available as a separate objective- and card-free mode
- [x] Add deterministic objective, deadline, reset, and full-session integration coverage
- [ ] Browser playtest and scenario pacing/difficulty balance pass

## Phase 8B — Pulse Cards

- [x] Add a typed run-scoped `ParkRuleset`: base rules → scenario rules → selected cards → safety clamps
- [x] Define every card as data with at least one visible upside and one meaningful downside
- [x] Choose a configurable number of cards after seeing the park objective; target two active cards for the first balance pass
- [x] Lock the loadout for the park and show its combined effective modifiers before starting
- [x] Show active cards and both consequences in the management dashboard throughout the park
- [x] Start with six distinct cards that alter real decisions around demand, guest budgets, construction, pricing, throughput, needs, or operations
- [x] Draft one of three deterministic, duplicate-protected reward cards after clearing a park
- [x] Never require a specific card to clear a scenario and avoid permanent raw-stat upgrades *(the second half is amended by Phase 22: small, bounded, listed, switchable permanent bonuses are now allowed; the first half still holds and is tested)*
- [x] Test modifier order, composition, clamps, isolation, and seeded reward choices
- [x] Rename the game to Parksmith across the app shell, HUD brand, and docs
- [ ] Browser playtest and card tradeoff/balance pass

## Phase 8C — Park Tour

- [x] Build a handcrafted branching map whose reachable parks show objectives, conditions, and rewards before selection
- [x] Start each park fresh while the current route and tour card collection persist between parks
- [x] Unlock the next map nodes and add the drafted card immediately after a successful park
- [x] Return a failed park to loadout selection with the same seed and no reward; consider limited retries only as a later challenge mode
- [x] Persist versioned profile and tour state between parks using stable scenario and card IDs
- [x] Permanently discover card alternatives and scenarios without permanent statistical power escalation
- [x] First vertical slice: opener → one of two branches → finale, six cards, two objective families, and two active card slots
- [x] Add a full map → loadout → park → result → reward → next-park integration test
- [x] Browser playtest card tradeoffs, objective clarity, reward quality, and route replayability — *superseded (noted
  2026-10-15): the Park Tour was retired in Phase 23; its cards and routes were converted into The Map (Phase 22), which
  has its own playtest items*

## Phase 10 — Coaster Prototype

- [x] Cell-based coaster designer: drag a closed track loop on the grid with per-piece heights 0–3
- [x] Deterministic layout validation: adjacency, no self-crossing, straight flat 3-piece station, ±1 height steps, and a required hill-and-drop
- [x] Excitement, intensity, duration, capacity, running cost, and default ticket price derived purely from track shape, with exact evidence (pieces, turns, drops, descent, highest point)
- [x] Construction cost from pieces plus elevation, scaled by the session's construction multiplier, with proportional bulldoze refund of the whole track
- [x] Built coasters are real rides: queues, dispatch, cycles, tickets, wear, breakdowns, scenery, rating, and guest choice all work through per-object ride profiles
- [x] Live designer panel with height controls (R/F), running stats, cost, validation guidance, and undo/clear/build
- [x] Elevated track rendering with supports, station platform, closing-hint guide, blocked-cell warnings, and an animated train on running coasters
- [x] Coaster evidence surfaced in the ride inspector
- [x] Deterministic design, placement, economy, and full ride-loop coverage
- [x] Three coaster types with distinct height limits, train sizes, economy, and reliability (Skyline Serpent behind Vertical Motion research)
- [x] Special pieces as data: vertical loops and launch boosts on straight non-station track, priced and reflected in stats and rendering
- [x] Deterministic per-piece speed profile (chain lift up, acceleration down, drag on flats, loop scrub, launch boosts) driving ride duration and train motion
- [x] Track-oriented linked train cars with a lead-car windshield instead of dots
- [x] Walkways can pass under track at height 2+, high track can cross existing paths, and bulldozing removes the walkway before the coaster
- [ ] Browser playtest and coaster stat/cost balance pass

## Phase 9 — Performance at 1,000+ Guests

- [x] Headless per-subsystem profiling harness for a full park at 1,100 guests (guests dominated at 1.44 ms of a 1.93 ms tick)
- [x] PathNetwork: distance fields computed in the same BFS as next-pointers, pre-parsed cell references instead of per-step string parsing, and cached per-component membership
- [x] Guest destination choice scores candidates by O(1) cached route distance and materializes the route array only for the destination the guest commits to
- [x] Wander/strand recovery reads the cached connected-component array instead of rebuilding it per decision
- [x] ManagementSimulation aggregates the whole guest population in a single pass per step (was ~12 separate scans across operations, rating, value, and notifications)
- [x] Entrance connectivity (path flood + per-object access) cached per world/path version instead of four BFS floods per tick
- [x] Measured result: 1.93 → 0.55 ms per 100 ms tick at 1,100 guests (3.5×); guest cap raised 220 → 1,000
- [x] Permanent scale regression test: 1,000 guests, wall-clock budget with ~15× headroom, and twin-session determinism preserved
- [x] Browser playtest: locked 60 fps with 1,000 guests and a densely built park (high-end hardware; render frame time leaves wide headroom for weaker machines)

## Balance & Content Pass 1 (post-playtest)

- [x] Guest ceiling fix: churn-limited ~105-guest plateau removed — spawn floor 1.35s → 0.55s, base visits 140–300s (was 80–180s), and satisfying rides/purchases extend the stay (+20s/+10s, capped at 15 min)
- [x] Guests arrive in three taste clusters (gentle ~35%, family ~40%, thrill ~25%) so ride intensity spread matters
- [x] Six new rides across the intensity spectrum: Moonpetal Carousel, Bumble Coach (gentle), Harbor Swings, Splash Rings (family), Gale Spinner, Thunder Drum (thrill)
- [x] Three new shops: Glacier Scoop, Lemon Light (base), Waffle Windmill (research)
- [x] Research tree grown: Family Favorites, Water Works, and Thrill Engineering projects
- [x] Ride catalog cards show a Gentle/Family/Thrill/Designer tag; variety rating factor now rewards up to five ride types
- [ ] Browser playtest: guest population growth past the old ~105 plateau and cluster-driven ride demand

## Ride Visual Pass

- [x] Every catalog ride gets bespoke machinery in `src/rendering/rideArt.ts` instead of one shared spinner silhouette
- [x] Moving parts driven by real ride state: orbiting gondolas, counter-spinning cups, hanging ferris cabins, bobbing carousel ponies, a touring coach train, chairs that fly out with speed, boats winched up a flume and dropped, an end-over-end spinner, and a tilting rotor drum
- [x] Drop tower cars follow the actual ride cycle (winch, hang, drop, rebound) from `cycleRemainingSeconds`
- [x] Motion eases in and out with ride status and the spin accumulator only advances while the machine turns, so closures coast to a stop and reopen from the same angle
- [x] Ride plots read as installations: tinted footprint, perimeter fence, and a gap wherever a path touches the plot for the guest entrance
- [x] Headless geometry coverage: bespoke art for every ride id, finite transforms across a full cycle, and no movement while closed
- [ ] Browser playtest: readability at default zoom, silhouette overlap in dense parks, and frame cost with many rides on screen

## Build, Rotation & Staffing Pass

- [x] Blueprint matches the built footprint: plot-aligned art geometry in `src/rendering/isoPlot.ts` (cell-space ovals and ground plates) fixes Bumble Coach and Splash Rings lying diagonally across their plots
- [x] Construction preview draws the real building, ghosted and at rest, instead of a generic marker
- [x] Rotate buildings with R (or the Rotate button): quarter turns swap footprint width and depth through `footprintSize`, and placement, occupancy, guest access, scenery, rendering, and overview all read the rotated rectangle
- [x] Rotation reaches the ride art that has a long axis, so a rotated coach runs its circuit along the plot it occupies
- [x] Crew cap scales with the crowd (6 per role plus one per 100 guests, up to 20) instead of a fixed 8
- [x] Whole-crew training, 3 levels per role: +25% work speed and +10% walking per level, paid up front, with wages up 20% per level
- [x] Estate overview tab: every placed building in one sortable list with price, queue, served, revenue, satisfaction, and condition; a row centres the camera and opens its inspector
- [x] Developer park in the Parks menu: street grid, twelve rides, a coaster, every service, bins, staff, and $250,000 — plus a dev action that fills the park to the 1,000-guest cap
- [x] Coverage: rotated placement and occupancy, plot-containment of ride vehicles in all four rotations, staff cap and training economics, overview rows against their owning simulations, dev-park reachability at 1,000 guests, and a staffing scale test showing a trained crew holds a crowded park cleaner
- [x] Browser playtest (dev park, 1,000-guest scale): 60+ fps at 4x and 6x CPU throttling, 15 fps on low-tier mobile (12.2x) — simulation was 0.00 ms, so the cost was rendering
- [x] Per-frame geometry rebuilds removed: every moving part (chains, arms, poles, couplings, cylinder bands, smoke, foam, wake, trails, beacons, coaster trains, bin bars) is pre-built and animated by transform/alpha, with a test that requires zero drawing calls in a steady-state frame
- [x] Estate list is only recomputed while the dashboard is open
- [x] Browser re-test at 12.2x throttling; if a weak CPU still struggles, viewport culling is the next lever — *superseded
  (noted 2026-10-15): this measured the classic renderer, which is the legacy fallback since the voxel renderer became the
  main renderer; the voxel renderer carries its own performance items*
- [ ] Browser playtest: rotation feel, blueprint readability, and overview ergonomics

## Phase 11 — Playability & UX Pass

Clears the playtest debt carried since Phase 1. Driven entirely by `PLAYABILITY_AUDIT.md`; every
item below names the finding it closes. No new simulation systems. One finding at a time, each
finishing green on lint, TypeScript, tests and build before the next begins.

Rendering scale (viewport culling) is deliberately **not** in this phase — see Phase 11B (closed 2026-10-13: the
classic renderer is legacy).

### Pre-tasks

- [x] PA-012: developer tools move behind an explicit switch (the Settings "Developer tools" toggle; `?dev=1` forces it for one page load only and is never persisted; the old `parksmith-dev` flag is imported once). The cheat
  buttons, the force-breakdown action and the Developer Park are unreachable in an ordinary
  Sandbox session and fully available behind the flag, where they remain the regression fixture.
- [x] PA-010: provisional sandbox starting cash, set from the actual catalog costs so it buys
  paths plus two or three rides plus one shop and no more — the first real trade-off. Verified to
  cover the whole Phase 13 onboarding sequence with margin. Recorded in `BALANCE_NOTES.md` as
  PROVISIONAL and re-opened by the Phase 16 balance pass.

### Findings

- [x] **Input context stack** — PA-005, PA-020 and the coaster `R`/`F` versus rotate `R`
  collision are one bug: there is no notion of which layer owns the keyboard. Solved once with an
  ordered context stack (text input → reward draft → scenario result → loadout → park map →
  management → inspector → build/coaster designer → world). Only the top context receives
  shortcuts, `Escape` pops exactly one layer, camera keys stop behind modals, and modifier-key
  combinations are never swallowed.
- [x] PA-007: object selection belongs to an explicit pointer tool. A click in the world never
  disarms the build tool; the armed tool is only released by choosing another tool or by `Escape`,
  which steps build tool → pointer tool and no further. The armed tool has a visible indicator.
- [x] PA-003: unaffordable catalog cards stay interactive and state the shortfall ("Need $1,600 —
  you have $940"), matching how locked and scenario-locked cards already explain themselves;
  coaster type cards can open the designer regardless of cash
- [x] PA-004: the coaster designer no longer covers the utility column; every floating panel gets
  an explicit `z-index` and a documented screen region
- [x] PA-006: bulldozer drags interpolate with `lineCells`, and a construction gesture triggers at
  most one world change so the scene is rebuilt once per gesture instead of once per tile
- [x] PA-006: a **construction frame budget test** — a bulldoze and a placement assert a ceiling on
  `Graphics` drawing calls (a ceiling, not zero), covering the renderers the steady-state
  zero-rebuild test deliberately does not: `syncWorld`, the ghost preview, the scenery influence
  preview and the coaster draft. The ceiling is set from post-fix behaviour.
- [x] PA-019: the cursor readout prints the actual reason — blocked, unaffordable, or locked —
  instead of one merged string
- [x] PA-017: the performance overlay reports `ENTITIES`, not a fictional `VISIBLE` count
- [x] PA-008: an in-progress coaster layout survives a tool change and is restored when the type is
  re-selected; right-click and `Escape` step back one piece; only the explicit Clear button (with a
  confirmation above a few pieces) discards the layout. Browser playtest also found that the layout
  was rendered into the hover preview layer and so disappeared on every pointer move; it now owns
  its own layer and dims while parked.
- [x] PA-028: a park can no longer hire a crew it has no way to pay, and a park that has genuinely
  stopped being able to earn says so once, naming the ways out that exist in it. The wage model is
  unchanged by decision: wages bill whether or not the park is open, so shutting the gates is never
  a free way to build. The notice also fires on the commonest route into the trap — a slow drain,
  where the last guests leaving a rideless park make the condition true with nothing else changing —
  which is covered by its own integration test.
- [x] PA-002: **one level** of construction undo — the last build gesture only, at 100% refund with
  no time limit, on `Ctrl+Z` and an **Undo build** control in the dock. Withdrawn for exactly three
  reasons, each named by the control: a guest or staff member has interacted with *that* object; the
  player has changed *that* object's opening or price; or another construction gesture has happened.
  Nothing else touches it — not guest movement, payroll or any other economy tick, condition decay,
  revenue, breakdowns, or elapsed simulation time. Scoped to construction by decision: demolition
  undo waits for Phase 12's snapshot-restore, the affordance names that scope in both its label and
  its refusal, and demolition gained its own receipt naming what went and what came back. No
  bespoke inverse-operation system was built. A demolition ends the pending undo through the world's
  own counter, so a partly bulldozed path drag can never be refunded twice, and the undo path is
  covered by the incremental-rendering equivalence test alongside every other world mutation.
  *Superseded in Phase 12 step 3: the single-gesture undo, its three withdrawal rules and the "demolition can't be undone yet" refusal were removed; undo is now a ring of whole-park snapshots.*
- [x] PA-018: display interpolation for guests and staff *(closed 2026-10-13: done in the voxel renderer; the classic renderer
  keeps stepping and is legacy, see "Classic renderer: legacy" under Voxel Renderer)* — a visual lerp between the previous and
  current simulation positions, so a 10 Hz simulation reads as continuous motion at 60 fps. The
  simulation stays authoritative, the interpolated position never feeds back into any simulation
  input, and no per-frame geometry is rebuilt — transform only.
- [x] PA-009: park capacity is visible — the organic guest ceiling and its two inputs (ride
  capacity, park rating) appear in the Park Pulse header and the Overview tab, with a notification
  when the park sits at capacity *(done 2026-10-14: `GuestSimulation.capacityView()` is a pure read and the ceiling
  arithmetic exists once, so `organicGuestPotential()` is now a wrapper over it; the Pulse guests stat reads `41` over
  `of 52 guests`, the Overview has a GUESTS `of 52` KPI and a "Park capacity" section after the rating naming ride seats,
  rating, the card multiplier, the hard maximum and the blocked reasons. Above the ceiling (a ride closed, the rating
  fell) the copy reads `max 491 guests`, found by the browser audit. The "at capacity" notice is app-layer
  (`src/app/capacityNotice.ts`, 10 simulated s to turn on, one `important` toast after 60 s) and never saved: a new
  Management notification would have changed saved state)*. *Revised in Phase 30 (2026-10-15): the Pulse line budget
  is three, not two, with one line kept for a guest thought while any exists, and the climate line moved to the clock
  popover only, because weather and climate lines alone could fill the card.*
- [x] PA-016: rating factors show their contribution and weight and sort by lost contribution *(done 2026-10-14:
  `src/ui/ratingFactorModel.ts`; each row adds "17% of the rating · 15 pts to gain" or "full marks", sorted by whole
  points to gain, then weight; "Biggest gains first." under the chart)*
- [x] PA-015: a "Demolish · refund $N" action in the ride and service inspector, `Delete` bound to
  the selected object, and a confirmation before a single track click removes a whole coaster *(done 2026-10-14: undo
  has covered demolition since Phase 12 (snapshot ring), so the inspector's Demolish is one undo entry ("Comet Coaster
  demolished") and one Ctrl+Z restores it. The confirmation focuses Keep it. Delete and Backspace are a `FIXED_KEYS` row
  (both reserved for text fields, so not rebindable) and only open the confirmation, in the inspector context. Refused
  while a coaster layout is open. In the bulldozer a coaster is a two-click: the first press arms it and removes nothing,
  a second press on the same coaster demolishes it, any other press, Esc, a tool change or a session swap disarms it,
  and a drag never removes a coaster. `World.demolishObject` is a refactor of the bulldoze object branch, pinned
  byte-identical)*
- [x] PA-021: the camera is clamped so part of the plot always stays on screen, `focusCell` eases
  instead of snapping, and recentring has a visible affordance *(done 2026-10-14, voxel renderer only: the classic
  renderer is legacy and gets no clamp and no ease, it ignores the new optional `CameraMotion` argument. The clamp keeps
  the ground point under the viewport centre within a margin of the plot (the design's margin, capped so the last cell
  stays on a 1100x690 window at the largest zoom); the turn chain is untouched. Player moves glide 250 ms (ease-out,
  at most 50 ms per frame, snaps under reduced motion). Recentre is a ⌂ button in the map-view pill and the rebindable
  key V, which yields to a player binding already on V)*
- [x] PA-022: build rotation either resets on selection change or is visibly sticky on the Rotate
  button *(done 2026-10-14: sticky and visible, an orchestrator default open for the owner to overturn. The Rotate
  button shows `90°` (named "Rotate, now turned 90°") and the readout `⟳ 90° · 3×2 · R to rotate`; resetting
  instead is one line in `selectBuild`)*
- [x] PA-024: a "no path access" badge on an orphaned ride or service plot, and the same status in
  the estate overview row *(done 2026-10-14: `ManagementSimulation.hasPathAccess` over the existing connectivity cache;
  a static slate "no entry" badge in the voxel badge layer for rides and services (broken > maintenance > no access);
  the estate row ends "· no path access" and the inspector carries the same sentence as a note. No classic badge
  (legacy))*
- [x] PA-023: delete the dead snapshot payloads (`health`, `parkScenery`, `UiState.scenery`) and the
  unused accessors listed in `AUDIT_FINDINGS.md` §8, or wire them into something visible *(closed 2026-10-14: only
  `health` was still dead and is deleted (`ManagementSnapshot.health`, `healthSnapshot()`, `ManagementHealthSnapshot`).
  The rest is used since later phases: `parkScenery` by the Overview scenery factor and the balance bot, `UiState.scenery`
  by the inspector theme line (both Phase 16), `grantResearchPoints` by card effects, `organicGuestPotential` as the
  PA-009 wrapper; `tourCompleted` left with TourManager and the `focusEntrance(animate)` parameter no longer exists.
  `consumeNotifications()` and the `arrivalIntervalMultiplier` getter stay as documented test seams. The observables
  pins kept by a retired-key shim (`withRetiredHealthKey` in `determinismHarness.ts`); no pin moved)*
- [ ] Browser playtest: a full sandbox hour with developer tools disabled, re-running the four
  time windows in `PLAYABILITY_AUDIT.md` Part 1 *(the owner's; still open after the 2026-10-14 work)*

**Closed 2026-10-14 (the seven findings above).** No saved or hashed state moved: the v1 to v12 save fixtures, the
`defaultIdentity.review` and `liftPersistence.review` pins (final, events, fingerprints and observables) and every
determinism test are unchanged, and the pin files are byte-identical to the Wave 0 baseline. Full suite at each gate:
Wave 0 7,082 passed (181 s), Wave 1 7,186 (189 s), Wave 2 7,204 and Wave 3 7,205 (about 182 to 187 s); always 20
expected fails and 74 skipped. The browser audit (Phase 11 functional walk 45/45 at 1280x800 and at 1100x690, the
layout matrix 300/300, accessibility 68/68 per scale) used scratch scripts in `phase11ui/`, archived in
`.voxel-handoff/phase11-ui-tools.tar.gz`.

Defaults taken by the orchestrator on 2026-10-14, open for the owner to overturn: PA-022 sticky and visible; PA-021
recentre on V and the ⌂ button, clamp in the voxel renderer only; PA-015 Delete and Backspace both open the
confirmation and the bulldozer coaster rule is a two-click (no modal); PA-023 delete `health` rather than wire it into
the cash pill.

Known and left open: every toast shows a ✓ glyph, alerts included (pre-existing, `Hud.tsx`) *(fixed in Phase 30,
2026-10-15: an alert shows "!")*; clicking an estate row keeps the dashboard open, so the inspector stays hidden until
it closes (existing behaviour) *(fixed in Phase 30: `focusBuilding` closes the dashboard)*; the armed coaster's
footprint previews as a white outline in the voxel renderer, not a red fill *(fixed in Phase 36: the overlay's 4/8
dither of the demolition red averaged out to the brick path's own pink at 1:1; a clear that will happen now fills at
6/8)*; at 1100x690 panning up can leave the plot just behind the build dock (inside the clamp; ⌂ or V brings it back)
*(fixed in Phase 36: the voxel clamp keeps a plot cell in the area the HUD leaves uncovered)*.

**Definition of done, per finding:** implementation complete; lint, TypeScript, tests and the
production build pass; no regression in the core loop; `PLAYABILITY_AUDIT.md` updated with the
finding's status; this plan updated; documentation matches the implementation.

**Definition of done, phase:** every CRITICAL/HIGH finding in `PLAYABILITY_AUDIT.md` is closed or
explicitly deferred with a reason recorded here; the input context stack, tool retention and undo
have deterministic tests; `src/game` still imports neither React nor PixiJS; fixed-step determinism
is intact and nothing depends on frame rate or rAF; the player's manual open/closed intent still
survives every system.

## Phase 11B — Rendering Scale (closed 2026-10-13)

> **Closed without building (2026-10-13).** Every item below is classic-renderer culling (`WorldRenderer`,
> `Graphics` calls). The classic renderer is legacy as of this date (see "Classic renderer: legacy" under Voxel Renderer): no new
> features, no new measurements. The voxel renderer has its own culling and level-of-detail items in its section, and
> the Phase 19 performance floor is measured there. The entry criterion was never measured in a browser; the headless
> numbers recorded under the first item stand as the PA-006 result. Items stay unchecked as a record, not as work.

Viewport culling and display pooling, broken out of Phase 11 as a separate, measurement-driven
phase. The hypothesis behind the split: rebuilding all static geometry on every world change is
probably a larger cost during active construction than culling saves during steady state, so
PA-006 must land and be re-measured before any culling work begins.

**Entry criterion — 11B does not start until this is measured and true:**

> Developer Park, 1,000 guests, Chrome DevTools CPU throttling 6×, sustained **below 55 fps**
> after the PA-006 fix has shipped.

If the measurement is at or above 55 fps, this phase is closed as unnecessary and the finding is
recorded in `PLAYABILITY_AUDIT.md` rather than implemented.

- [ ] Re-measure on throttled CPU after PA-006 and record the number in this plan.
  Headless measurement so far, against the dev park (full rebuild = 5,081 `Graphics` drawing
  calls): a world change with nothing to do went 5,081 → 0, placing a decoration 5,081 → 11,
  placing a ride 5,081 → 501, clearing one path tile 5,081 → 550, and a twelve-tile bulldozer
  drag 60,972 → 879. Construction is no longer rebuilding the park; the browser measurement
  decides whether steady-state rendering still needs culling.
- [ ] Only if the entry criterion is met: viewport culling for guests, staff, litter, bin
  indicators, ride alerts and coaster trains, driven by the camera's visible cell rectangle
- [ ] Culling must not change simulation behaviour, allocate per frame, or rebuild geometry — a
  culled display is hidden, not destroyed
- [ ] Display pooling for guests if creation churn shows up in the measurement
- [ ] `WorldRenderer.getPerformance()` reports a real visible count once culling exists (completes
  PA-017)
- [ ] The 1,000-guest scale regression test still passes with headroom
- [ ] Browser re-test at the same throttling level, with the before/after numbers recorded here

## Phase 12 — Save, Load & Session Recovery

Full park-state persistence in IndexedDB. Today the only persisted data is the Park Tour profile
in localStorage (`TourManager`); nothing about a park survives a reload (PA-001).

- [x] Explicit typed serialization boundary per owner (step 1, done): `GameWorld`, `GuestSimulation`,
  `RideSimulation`, `ShopSimulation`, `OperationsSimulation`, `ProgressionSimulation`,
  `ManagementSimulation`, `ScenerySimulation`, `ScenarioSimulation`, `ParkSession`. Each exposes
  `serialize()` / `restore()` over a declared plain-data type — never a class instance
- [x] Renderer and React objects can never enter a save (step 1, done); enforced by types and by a test that walks
  a serialized save and fails on any function, `Container`, `Graphics` or DOM reference
- [x] Save covers (step 1, done; field-coverage guard in `coverage.test.ts`): world grid, paths, occupancy, placed objects, coaster layouts and paid costs,
  cash, transactions, tick and park-open state; simulation time; guests including the seeded RNG
  state; ride runtimes (open state, price, queues, cycle clocks, revenue, condition, breakdown and
  maintenance state); service runtimes; queues; litter, bins and staff including training levels;
  research points, completed projects and milestones; finance ledger, trends and notifications;
  scenario state and latched result; the compiled ruleset and the Pulse Card loadout
- [x] **Hard acceptance criterion — determinism hash** (step 1: `src/game/save/determinism.test.ts`, six fixture parks, 24 save points, thousands of ticks each; same-engine proof). Save mid-park, load into a fresh session,
  run N deterministic ticks, and assert an identical state hash against a reference run that was
  never saved. One test that catches the guest RNG state, every id generator, dispatch clocks,
  cycle clocks, service clocks, payroll and wear accumulators at once. The phase is not done until
  this passes.
- [x] IndexedDB store built from the start as a **list of saves keyed by stable slot ids**, with
  park name, playtime, last played and schema version as metadata readable without loading the full
  save. The alpha UI exposes one autosave and one manual slot; multi-slot later is then a pure UI
  addition with no schema migration.
  *Step 2, done: `src/app/saves` (two object stores in one transaction, revisions, memory fallback with retry; tested against a hand-written IDBFactory fake and against real IndexedDB in headless Chromium).*
- [x] **Snapshot-based undo stack** (step 3, done: `src/app/undo`, ring of 20 entries / 20 MB, whole-park rewind with a rewind label and a confirmation past 60 s), replacing the single-level gesture undo shipped in Phase 11:
  once typed serialization exists, undo is a bounded ring of park snapshots restored through the
  same boundary as load. Depth is a tuning decision; the Phase 11 invalidation rules disappear
  because a snapshot restore is always correct.
- [x] **Undo of demolition via snapshot-restore** (step 3, done: a demolished ride returns with its ticket price, open/closed intent and runtime; verified in a browser by serialize and hash equality; the control is now just "Undo"). Phase 11's undo deliberately covers build
  gestures only, because removing a building destroys per-object state (ticket price, the player's
  open/closed intent, condition, revenue history, breakdown state) that a one-level undo cannot
  restore honestly. A snapshot can, so this is where a mis-demolished ride comes back intact —
  including its runtime state, not just its footprint. When it lands, the Phase 11 affordance
  ("Undo build", and the "demolition can't be undone yet" refusal in
  `src/game/build/undo.ts`) must be renamed to match the new scope.
- [x] Autosave on an interval and at safe points (park start, scenario result), plus manual save;
  autosave never blocks a frame
  *Step 2, done: every 120 s while changed, 15 s after park start, at scenario results, on hide; hashing and writing in a Web Worker. Measured at 1,000 guests: no long task attributable to a save at 1x; capture 3-13 ms (median 5.4) at 1x and 14-25 ms at 6x, so the 8 ms budget holds only at 1x. Closing the tab is best effort.*
- [x] Schema `version` on every save, a migration chain, and a documented policy for unreadable
  saves (surfaced, never silently discarded). *Step 1 delivered the primitives: `ParkSave` envelope,
  `SAVE_SCHEMA_VERSION = 1`, `migrateSave`, typed `SaveError` codes. Closed 2026-10-14 (bookkeeping): frozen fixtures of
  schemas 1 to 13 run through the chain (now 13 migrations, schema 14), and a refused load is shown by the Save / Load
  dialog and the start screen's notice with the SaveError's message.*
- [x] Interrupted-session recovery: an unclean shutdown is detected on load and offers to resume
  the last autosave
  *Step 3, done: Web Lock plus localStorage marker per tab, offer only for the interrupted tab's own autosave, autosave held until resolved, "Not now" keeps it as 'Recovered autosave'. Verified with CDP `Page.crash`.*
- [x] Save/load UI: slot list, load, rename, delete, and an overwrite confirmation
  *Step 2, done: a Save / Load dialog on the input context stack, overwrite/delete/load confirmations, Ctrl+S.*
- [x] Storage failure is handled the way `TourManager` already handles it — the session keeps
  running in memory and the player is told persistence is unavailable

**Step status.** Steps 1 (serialize/restore per owner, determinism proof, versioning primitives, plain-data
guarantees), 2 (IndexedDB slot store, autosave, save/load UI, storage failure) and 3 (snapshot undo,
demolition undo, crash recovery) are done. The schema-2 fixtures (`save/fixtures/park-v2-sandbox.json`,
`park-v2-scenario.json`, exercised by `migration.test.ts`) and the UI for unreadable saves (`ui/saveLoadModel.ts`:
"Damaged" / "Newer version" chips, the store's reason on the row, Delete as the only action) exist, so they are no
longer open (noted 2026-10-15). Still open in this phase: the follow-ups below.

**Definition of done:** a park built for 30 minutes reloads byte-identically and continues
deterministically; migrations are tested against at least one older fixture save; no renderer or
React object appears in any serialized payload; lint, TypeScript, tests and build pass.

### Carried into steps 2 and 3 from step 1

Step 1 (typed `serialize()`/`restore()`, the determinism proof, `ParkSave` envelope with `stateHash`, range and consistency validation; details under Persistence in ARCHITECTURE.md) finished with 1,781 tests passing. Measured at 1,000 guests: about 1 MB of JSON, `serialize()` about 3 ms, `createParkSave` about 30 ms, restore about 2.5 ms (Node, unthrottled; 6x throttle is an extrapolation, not a measurement). What the later steps must do:

  *Step 2, done: banner with Retry, memory fallback, quota and blocked cases tested in a real browser.*
- Autosave (step 2): save only after `syncWithWorld()` for every edit (a stale save throws `SaveError('unsynced')`); hash and write off the frame, handing the plain object to IndexedDB's structured clone instead of stringifying on the main thread; measure in a browser.
- Loading (step 2): `fromSave` returns `{ session, save, contentDrift }`; decide the policy for a catalog change between save and load (scenery currently throws `content-mismatch`). The loader must refresh management and the UI snapshot before first paint (a bare restored session shows empty operations sections until the next step).
- Bundle (step 2): the main chunk grew from 749 kB to 823 kB (about +20 kB gzip), mostly save validation and migration code that only a load needs; lazy-load the load path or budget it. *Both done in Phase 34: the load path is a real lazy chunk and the entry has a gzip budget.*
- Snapshot undo (step 3): done. `restoreState` is not atomic, so undo swaps in a fresh session built by `fromState` through the same `swapSession` as loading (see ARCHITECTURE.md).
- Known limits: the determinism proof is same-engine (`Math.hypot`); persisted notification text depends on the locale; a save can be edited on purpose, and nothing outside the park may trust it; `PathNetwork.connectedCells` order changed once, so re-check `BALANCE_NOTES.md` and scenario tuning.
- Test hardening noted by review (minor): a few single-field losses are not caught end to end, and a long soak (6,000 ticks) was not added to CI.

### Left over from step 2 (carried into step 3 and later)

Step 2 finished with 1,988 tests passing; the main chunk is 842 kB (749 kB before Phase 12), the load path is a 0.96 kB lazy chunk and the save worker 14.8 kB.

- [x] Lazy loading is nominal: `ParkSession` imports `fromSave`, `migrateSave` and the validators statically, so migration and validation stay in the main chunk. A real split means moving `fromSave`/`fromState` out of `ParkSession` and making them async; do it if the budget matters. *Done in Phase 34 (2026-10-15) without the async change: the chain moved to `save/migrate.ts` and `fromSave` to `session/fromSave.ts` (`sessionFromSave`), reached only from the lazy `loadSave` chunk (10.2 kB). The per-owner restore validation stays in the main chunk because snapshot undo uses `fromState`. The bundle has a budget now; see Phase 34.*
- Closing the tab loses the last unsaved changes in most cases (best-effort flush). Options: a shorter interval, an incremental hash so the main thread can finish a save in one task, or writing without the worker on `pagehide`.
- The capture exceeds 8 ms at 6x throttle; the mitigation named in the design is to split the clone over several frames.
- [x] One autosave generation only; two rolling generations would protect against a bad autosave replacing a good one. Done in Phase 31 (2026-10-15): `autosave-previous`, rotated in the autosave's own write transaction; see Phase 31.
- [x] The first-autosave integrity check covered current-schema saves only, so an older-schema autosave with a content mismatch could still be replaced. Fixed in Phase 30 (2026-10-15): `storedSaveProblem` checks every checksummed schema at the schema it was written at; an intact older autosave still passes.
- Two-tab behaviour is covered by logic tests and a review harness, not by a committed browser test.
- The classic renderer leaked about 24 MB and 2,200 WebGL buffers per `setSession`: fixed in step 3 (every Graphics-owning destroy site uses `context: true`, guarded by `WorldRenderer.swap.test.ts`). A small residual heap growth (about 8 KB per undo) remains on the classic renderer.
- `?dev=1` forces developer mode for that page load only and is never persisted (the Settings toggle is the persistent switch); `window.__parksmithDev` is still exposed whenever developer mode is on, including in production builds.

### Left over from step 3 (carried into later work)

Step 3 finished with the main chunk at 866.7 kB (842 kB after step 2, 749 kB before Phase 12; gzip 251.7 kB).

- A parked coaster draft is discarded when Ctrl+Z reaches the ring while another tool is armed (the rewind resets drafts). Product decision: keep the draft across a rewind, or route Ctrl+Z to the draft first whenever one exists.
- Restore is synchronous: median 7 ms (max 31 ms) at 1x with 1,000 guests, 40 ms median at 6x, plus one rebuild frame. The worst case at 1x can exceed the 30 ms budget by a few milliseconds. The classic renderer pays about 100 ms per rewind (full rebuild).
- Capture at 6x CPU throttle is 12 ms median, above the 8 ms budget; it holds at 1x (2.5 ms median).
- Resume offers are made from autosave metadata only: an autosave that turns out unreadable is flagged at Resume, not before. A browser-discarded tab (Memory Saver) is offered as a crash.
- Without Web Locks the heartbeat fallback waits 30 minutes before offering a crash that happened while the tab was hidden; it was tested with a fake clock, not in a browser.
- The two-tab browser run covers "second tab does not prompt while the first lives" and "prompts after it crashed"; "a third tab with a live second tab that owns the autosave" is covered by unit tests only.
- The step-2 items (lazy load path that is only nominal, one autosave generation, best-effort flush on close) are unchanged, except the autosave generations, done in Phase 31.

## Phase 13 — First Session & Onboarding ("First Day at Parksmith")

A new player currently lands in an objective-free sandbox with no goal, and an entire mode
(Park Tour, Pulse Cards, scenarios) sits undiscovered behind one top-bar button (PA-011).

- [x] A named progression through the real game, each step completed by playing, not by reading
  (engine done, UI is step 2): lay a path → build a ride by the path → set a ticket price →
  welcome the first rider → food stall → drink stall → guest target → operating profit → fix a
  problem (litter or a breakdown) → reach a park-rating target
- [x] **Decide PA-029 first, because two steps above depend on it.** DECIDED: option (b). Rides,
  services and the park keep starting open, and "open the ride" / "open the park" are replaced by
  steps that need a real action (set a ticket price; connect the ride to the gate path). Closing
  and reopening a ride stays as it is, and no step reads `open`. See PA-029 in
  `PLAYABILITY_AUDIT.md`.
- [x] **Step 1, progression engine (`src/game/onboarding`).** Ten steps as data, each decided by a
  pure function of a read-only simulation snapshot; sticky completion, skip and permanent dismiss,
  current-step selection; part of the save (schema 2 with a 1->2 migration), the undo ring and the
  determinism proof; typed `UiState.onboarding` snapshot with no UI yet. Sandbox only. Pacing and
  targets in `BALANCE_NOTES.md`.
- [x] **Step 2, First Day UI.** Delivered through the Park Pulse card, world pointers and a
  one-time tour offer: no modal dialogs, no walls of text, no tutorial-only mechanics. The card
  names the current step, one short hint (at most 90 characters, built from the engine targets),
  "n of 10 done", `Skip step` and `Hide hints`, a small non-modal "done" row and a finished state.
  Pointers (a pulsing ring) go through `RendererPort.setHintMarkers` in both renderers.
- [x] The Park Pulse fallback insight is replaced by this progression while it is live (it returns
  in scenario parks and once the hints are dismissed)
- [x] Each step names the exact evidence that completed it, using existing simulation metrics
  (engine, step 1)
- [x] Steps can be skipped and dismissed permanently; the progression never blocks a build
- [x] The Parks map opens on a first run with no stored profile, and Park Pulse offers the tour once
  the sandbox park is stable (the profile gained optional `ui` flags; `?dev=1` never auto-opens it)
  *(Phase 23 changed this: a brand-new profile lands in the Sandbox First Day park and nothing opens by itself; the
  one-time offer is "Ready for The Map?", with the same stable-park rule and the same stored flag)*
- [ ] Recorded target: a first-time player understands paths, rides, guests, needs, money and the
  Park Pulse loop within 10–15 minutes
- [ ] Browser playtest with a genuinely new player, developer tools disabled

**Definition of done:** the whole progression can be completed in a fresh sandbox with no
developer tools; every step is driven by simulation evidence rather than UI bookkeeping; lint,
TypeScript, tests and build pass.

## Phase 14 — Neighborhoods & Crowd Flow

The most important planned new gameplay feature, and the payoff for "readable neighborhoods" in
`GAME_DESIGN.md`. Built on the existing path network and guest records — no collision physics, no
new entity types.

**Built (2026-10-14).** A rolling crowd flow per path tile, four display bands, a small congestion feedback that only a
NEW park has (ruleset key `crowdFeedback` 1), derived neighborhoods with metrics, Park Pulse lines, a seventh dashboard
tab and a voxel heatmap. Below the lane capacity the feedback is exactly neutral, and after the calibration no bot proof
reaches it: every run margin, sweep, card-matrix row, strategy, scenario and First Day latch is identical to the Wave 0
baseline. The architecture is in ARCHITECTURE.md "Crowd flow and neighborhoods (Phase 14)", every number with its
evidence in BALANCE_NOTES.md "Phase 14". Save schema **13**, `SAVE_CONTENT_VERSION` **4**, `RUN_PLAN_VERSION` 4
(unchanged).

- [x] Rolling traffic pressure per path tile: destination-driven traffic generation, decayed over
  simulation time, computed from guests already walking the network
  *(done: `src/game/crowd/CrowdSimulation.ts`, one `Uint32Array` over the map. `GuestSimulation.walk` counts an entry
  (+1,024) at the moment a walking guest steps onto the next route tile; `ParkSession.step` decays the whole field once
  per tick (`p -= ceil(p / 320)`, a 32 s time constant) right after the weather and before the guests. Integers only, no
  RNG draw, simulation time only (paused = frozen). Guests that queue, ride, shop or stand add nothing; staff add
  nothing. Shown as guests a minute: `p x 600 / (1024 x 320)`)*
- [x] Guest density, congestion and bottleneck classification derived from that pressure plus path
  width and connectivity — deterministic, cached per path version like the existing distance fields
  *(done: `crowd/pathShape.ts` derives lane width (path tiles in the 3x3 block / 3, clamped 1..3), degree, components and
  articulation points (iterative Tarjan) per `pathVersion`; `crowd/bands.ts` classifies flow per lane into quiet < 80,
  normal < 270, busy < 450 and severe, with a display-only 85 % hysteresis on the way down. A bottleneck is a severe
  tile with a structural cause: a single-lane tile or an articulation point. Per lane, 111 guests a minute is one walker
  per tile on average (guests walk 1.85 tiles a second), so the bands sit at about 0.7, 2.4 and 4.1 walkers per tile)*
- [x] Congestion feeds back into guest experience (walking time, happiness) without any collision or
  steering simulation
  *(done: above 400 guests a minute per lane (load 1) the step onto a tile is slowed by
  `1 - s x min(0.4, 0.4 x (load - 1))` (floor 0.6x at load 2), and a moving guest on a severe tile loses 0.2 x s
  happiness a second and, when wandering, thinks "It's so crowded here." (Park Pulse: "guests find the paths too
  crowded"). `s` is the ruleset's `crowdFeedback`: 1 for every new park, absent (0) in every park saved before Phase 14.
  At or below load 1 the factor is the literal 1 and the happiness branch never runs, so such a park is bit-identical to
  one without feedback (`save/crowdDeterminism.test.ts`). No rerouting: guests still take the shortest route)*
- [x] Heatmap overlay with four readable bands: quiet / normal / busy / severe bottleneck, sharing
  the toggle pattern already used by the scenery influence layer *(voxel renderer only; classic is legacy)*
  *(done: utility-rail toggle "Crowd flow" (≋, `aria-pressed`, the legend as its description), store
  `showCrowdHeatmap`, exclusive with the scenery heatmap both ways. `RendererPort.setCrowdHeatmap?` is optional; the
  voxel `VoxelOverlays` draws a crowd layer under the scenery heatmap (slate blue, teal, amber, coral at 2/8 to 6/8 dither
  plus a white rim round severe tiles) only when its revision moves, so a steady park draws nothing. With the pointer
  tool the cursor readout names the hovered path: "Quiet path · 68 guests a minute · Willow Green". Classic: the button
  is `aria-disabled` and a press says "The crowd heatmap is drawn by the voxel renderer.". Checked on all six biomes by
  day and on three at night)*
- [x] Neighborhoods derived deterministically from spatial sectors, attraction clusters, path
  connectivity and grid buckets — never hand-painted districts, never player-authored
  *(done: `crowd/neighborhoods.ts`. Rides with path access are clustered in id order around a leader ride (nearest
  leader within 6 cells, looked up in 8x8 grid buckets, sharing a path component); a multi-source BFS over the path
  network gives each cluster its territory, and the gate is its own neighborhood (four steps deep). Services, bins and
  benches join by their access tile, scenery by the nearest territory tile. Names hash the leader's anchor and the biome
  ("Willow Green", gate "Meadow Gate"); the sector ("north-west", "centre", ...) is the subtitle. Never saved; cached per
  world version)*
- [x] Neighborhoods are stable across small world edits: adding one bench must not rename or
  renumber a district
  *(done: the key is the leader ride's id and the name comes from its anchor, so a newer ride never renames an older
  neighborhood and a ride rebuilt on the same spot keeps its name. `neighborhoods.test.ts` places 40 benches, 10 bins, 10
  trees, 6 stalls and 4 toilets in each of six real parks (the dev park, three strategy parks, two generated maps): 0 list
  changes and 0 territory changes; a path tile changes the list only when it joins or splits components. Removing a
  leader ride re-clusters its followers: the one documented rename)*
- [x] Per-neighborhood metrics: happiness, hunger, thirst, toilet pressure, spending, litter,
  scenery appeal, queue pressure, attraction demand, and food/drink/toilet coverage
  *(done: `crowd/metrics.ts`, one pass over guests and one over buildings: guests, the four need means, spending (member
  revenue read from the owning simulations), litter, scenery, queueing and longest wait, demand (heading to or queueing
  for a member), coverage (`crowd/coverage.ts`: the share of its tiles within 16 path steps of an open service of each
  kind, cached per path version and open-service signature) and tiles per band)*
- [x] Park Pulse can describe a neighborhood — "Meadow Quarter is becoming crowded", "Meadow Quarter
  has no toilet within reach" — describing the problem, never prescribing the fix
  *(done: `app/crowdNotice.ts`, a tracker in simulation time beside the capacity notice, never saved and reset on every
  session swap: "{Name} has a bottleneck", "is becoming crowded" (25 % of its tiles busy or worse), "has no toilet / no
  food within reach", "has nothing to drink within reach", "Guests in {Name} are unhappy", "Litter is piling up in
  {Name}", each after a 10 s or 20 s hold and off after 20 s without. Park Pulse shows at most one, by priority; no
  Management notification (saved state). `neighborhoodModel.test.ts` bans advice words (build, add, place, widen, move,
  hire, should, try, consider, need to) from every line)*
- [x] A neighborhoods view in the management dashboard, with a row that centres the camera the way
  the estate overview already does
  *(done: the third tab, "Neighborhoods" (`ui/NeighborhoodsTab.tsx`): KPIs NEIGHBORHOODS, BUSIEST, BOTTLENECKS, GUESTS
  WALKING; "What Park Pulse noticed" (every active line, grouped by kind: "Meadow Gate, Hawthorn Row, Willow Green and 2
  other neighborhoods have a bottleneck"); one `<button>` row per neighborhood with its metrics, band word and coverage
  chips. A row click is `gameBridge.focusNeighborhood` -> `focusCell(cell, 'ease')` on the worst tile when it is busy or
  worse, else the territory focus, and a row with a bottleneck turns the crowd heatmap on (voxel). Rows are built only
  while the tab is open. The Overview gets the top line as a button that opens the tab)*
- [x] Performance: the whole pass stays inside the existing tick budget at 1,000 guests, guarded by
  an extension of the scale regression test
  *(done: `performance.test.ts` gains a case with feedback on, `crowdView()`, the heatmap and a hover every 10th tick,
  best of 5 x 40 ticks < 8 ms/tick, with at least one severe tile and three neighborhoods, and a viewed park identical to
  its unviewed twin. Measured against the Wave 0 code: +0.03 to +0.07 ms/tick at 1,000 guests on seven parks, inside the
  ±0.05 ms noise, under 1 % of the 8 ms budget (BALANCE_NOTES "Phase 14"))*
- [x] Deterministic coverage for pressure decay, bottleneck classification, neighborhood derivation
  stability, and per-neighborhood metric aggregation
  *(done: `crowd/{CrowdSimulation,bands,pathShape,neighborhoods,names,coverage,metrics}.test.ts`,
  `guests/GuestSimulation.crowd.test.ts`, `session/crowdSession.test.ts`, `save/{phase14Rules,crowdDeterminism,v13Fixtures}.test.ts`,
  `app/{crowdNotice,GameApp.crowd}.test.ts`, `ui/{neighborhoodModel.test.ts,phase14Markup.test.tsx}` and overlay cases.
  `crowdDeterminism` proves a crowded park saves, restores and continues identically, that a park below the capacity
  hashes the same with feedback on and off apart from the two keys, and that the display field never feeds back)*
- [ ] Browser playtest of a dense park: the heatmap, the Neighborhoods tab and the Pulse lines in real play *(the
  owner's; the Wave 4 audit and the bot re-measure are the automated proof so far)*

**Decisions (defaulted by the orchestrator on 2026-10-14; open for the owner to overturn)**

- **Feedback strength 1 for new parks**: walking down to 0.6x above 400 guests a minute per lane, and -0.2 happiness a
  second on severe tiles only.
- **Old parks get display only.** A park saved before Phase 14 has the heatmap, neighborhoods and Pulse lines but never
  the feedback; no "modernise this park" option (the Phase 16 precedent).
- **A separate rail toggle**, exclusive with the scenery heatmap (both are ground layers).
- **Tab label "Neighborhoods"** (US spelling, as this plan): it fits the 5 + 2 tab strip at every audited size, so the
  fallback "Areas" was not needed.
- **The gate is its own neighborhood** ("Meadow Gate"); it exists only while at least one ride cluster does.
- **"Within reach" = 16 path steps** (about 9 s of walking).
- **A bottleneck row turns the crowd heatmap on** (voxel only; classic moves the camera only).
- **The biome word lists** of the design (`crowd/names.ts` `BIOME_WORDS`, eight words per biome and eight suffixes).
- **No heatmap keyboard shortcut this phase** (KEYBINDINGS.md is unchanged). *(Added in Phase 35: T, rebindable,
  `toggleCrowdHeatmap`.)*
- **Recalibration (orchestrator, Wave 2):** lane capacity 400 and bands 80 / 270 / 450 instead of the design's 30 and
  8 / 24 / 45, because the design's flow figures were 10x too low (BALANCE_NOTES "Phase 14").

**Test suite and gates.** Re-pinned once, with proof: `save/determinism.test.ts` fixture 2c (only the two new keys; the
test now also asserts the stripped hash) and three `liftPersistence.review` parks that genuinely run above the capacity
(BALANCE_NOTES "Phase 14"). Fixed by the orchestrator along the way: `RideSimulation.serialize.test.ts` and
`ShopSimulation.serialize.test.ts`, whose hand-driven continuations step the owners without `ParkSession.step`, now call
`crowd.beginTick()` each tick and restore the crowd field into the continuation; `run/plan.test.ts` "maps (50 runs)" has
a 30 s timeout (about 4 s alone, past vitest's 5 s default under full-suite load); and `SaveManager.load` now waits for an
in-flight backdrop preview (`loadPreview`) instead of failing with busy, the root cause of the long-running
`GameApp.run.test.ts` start-screen flake (see Phase 16, Known limits). `yarn test`: vitest 205.4 s at the Wave 3 gate,
177.0 s at the audit gate and 180.3 s at the documentation gate, against 190.8 s at Wave 0 (7,206 -> 7,393 tests passed; always 20 expected fails and 74
skipped).

**Known limits**

- The Park Pulse line and the rows lag each other by the tracker's 10 s hold and 20 s release (by design; the tab's
  section says "What Park Pulse noticed"). In the audit 18 of 45 samples disagreed in one direction or the other.
- The quiet band is faint on autumn's lavender and the desert's sand paving by day (accepted: quiet is meant to look
  nearly unmarked); busy amber on desert reads against the paving, less against the sand around it. Overlay layers draw
  over ride sprites, as the scenery heatmap always has.
- Two pre-existing messages read as advice against the describe-not-prescribe principle: the Phase 11 capacity line
  "At capacity: more ride seats or a higher rating let more guests in." and the full-bins notification "... Hire or
  redirect cleaners." (saved notification text, so a change moves hashes). Not crowd lines; left for the owner.
- Removing a leader ride renames its neighborhood (its followers re-cluster). Every other edit keeps names.
- Very small corridors can read busy: the First Day's 12-tile route peaks at 297.5 a minute per lane (busy, no feedback),
  and the lean 8-tile variant (in no test) touches 417 for about 4 s with factor >= 0.984.
- At 1,000 guests the dev park reads "Severe bottleneck" on every row and Park Pulse names one bottleneck after another:
  intended at that density; the dashboard groups the lines.
- The browser audit (layout 260/260, a11y 30/30 voxel and 26/26 classic at 100 and 130 %, axe 0 violations) ran from
  scratch scripts (`phase14ui/`), archived in `.voxel-handoff/phase14-ui-tools.tar.gz`.

**Definition of done:** a densely built dev park produces stable, named neighborhoods and a
readable congestion heatmap; Park Pulse names a real bottleneck the player can go and look at; the
1,000-guest scale test still passes with headroom; lint, TypeScript, tests and build pass.
*(Met: the dev park has Meadow Gate, Hawthorn Row, Willow Green, Buttercup Corner and Willow Court; held at 600 guests
its bottlenecks are cells of the single-lane spine at x = 15 (the whole spine, 21 cells, at 1,000), and Park Pulse names
them ("Hawthorn Row has a bottleneck" at 600, "Meadow Gate has a bottleneck" at 1,000); the scale test passes at the
same 8 ms budget. The owner's browser playtest is still open.)*

## Phase 15 — Game Feel, Audio & Feedback

World-anchored effects in this phase (popups, bubbles, ride and construction feedback) are built in the voxel
renderer only; the classic renderer is legacy (2026-10-13) and gets none of them. Effects that live in the React UI
layer (the cash pill, toasts) are renderer-independent as before.

**Built (2026-10-14).** Presentation only: nothing reaches the simulation (a park observed every tick hashes like one
never observed, `feedbackTracker.test.ts`), no save field, no content version. The architecture is in ARCHITECTURE.md
"Feedback and audio (Phase 15)".

- [x] Floating money popups on every cash movement the player caused, and an animated cash pill *(done: paths, a build,
  a coaster, a demolition refund, clearing a prop and a land purchase pop "-$1,150" / "+$40" in a 3 x 5 pixel font where it
  happened (`overlay/effects.ts`); the pill tweens its number (ease-out, 450 ms) and shows a rising delta chip for a change
  of $25 or more (`ui/cashPillModel.ts`; reduced motion: no tween, the chip only fades). Hiring, research and recolours
  move the pill only (no world point))*
- [x] Guest reactions, sampled *(done: once a simulated second a rotating window of 120 guests is read and at most two
  whose thought is a delight or a real complaint (and not the one they last showed) get a heart or a storm cloud;
  `app/feedback/feedbackTracker.ts`)*
- [x] Ride completion, purchase, research completion, milestone, construction, breakdown and repair feedback, plus result
  and reward moments *(done: a star over a ride that finished a cycle, a coin over a stall that sold (one per stall every
  3 s), a red '!' on a breakdown, a spanner on a repair, a puff on a build, all within 6 cues a simulated second (the
  player's own money and build cues are never dropped); research, milestone, scenario success and failure play their
  sounds over the existing toasts. The Park Tour is retired (Phase 23), so the scenario result is its moment)*
- [x] PA-018 moved to Phase 11
- [x] Audio buses: master, music, ambience, rides, guests, UI, each independently mixable *(done: `src/audio/`, six
  settings in steps of 10 (Settings, Sound group, sliders); square-law gains)*
- [x] Zoom-aware ambience *(done: a crowd murmur that follows the guests in view and a machinery bed that follows the
  running rides in view, both louder closer in; the renderer's optional `readViewInfo` gives the zoom fraction and the
  visible world rectangle at 4 Hz; ride, sale and guest cues are only heard on screen; paused: no machinery)*
- [x] Rendering discipline *(done: the effect shapes are GraphicsContexts built once, a fixed pool of 24 slots; a frame
  sets visibility, whole-texel positions, context references, tint and alpha only. `VoxelRenderer.test.ts` runs 120
  frames with effects and the crowd heatmap on: zero Graphics drawing calls, and no overlay render once they end)*
- [x] Audio never allocates or decodes on a frame; no sound before the first user gesture *(done: every sound and loop is
  synthesised once at the first pointer or key press (no asset, nothing decoded); loops are started once and only their
  gains move (`setTargetAtTime`); a one-shot source node per cue is the Web Audio API's design and comes from events,
  rate-limited per sound; the page hidden suspends the context)*

**Checked in headless Chromium (2026-10-14):** path, ride, stall, refund and land popups, the pill tween and chip, sale
coins, ride stars, hearts and storm clouds at 4x in the dev park, the Sound sliders, and exactly one AudioContext, created
by the first click. Fixed from it: a building placed this gesture had no scene top yet, so its popup was dropped (now it
starts at a default height and moves above the building on the next frame; the puff sits on the ground).

**Open:** the owner's listening test (the sounds are synthesised placeholders in a consistent palette, not final audio);
a mute key *(done in Phase 35: M, rebindable, `toggleMute`)*; world effects in the classic renderer (legacy, not planned).

## Phase 16 — Content & Balance Pass 2

Widening the existing data-driven catalogs, not adding simulator systems.

**Built (2026-10-13).** Phase 16 *adds* content and moves no number a saved park reads live. 12 catalog entries and 5
research projects are appended; the two balance levers that change are two optional ruleset keys that only a NEW park
stores (`themeAffinity` 0.2, `researchCostScale` 10), so an old save plays exactly as before. The architecture is in
ARCHITECTURE.md "Content, themes and research scale (Phase 16)", every number with its evidence in BALANCE_NOTES.md
"Phase 16". Save schema 12 (unchanged), `SAVE_CONTENT_VERSION` 3, `RUN_PLAN_VERSION` 4 (unchanged).

- [x] PA-010: confirm or replace the **PROVISIONAL** sandbox starting cash set in the Phase 11
  pre-task and recorded in `BALANCE_NOTES.md`. That value was derived arithmetically from catalog
  costs to force a first trade-off; it has never been validated by play. This pass owns the real
  number, together with ride prices, ticket prices and running costs.
  *(done: $5,000 confirmed with bot evidence, BN-001 is no longer PROVISIONAL. Every opening of the three strategy bots
  spends $3,424 to $3,819 and bottoms out at $396 to $417, which is PA-010's own "one good ride or two cheap ones";
  $4,000 would cost cheap-and-wide a stall, $6,000 buys every strategy a second premium item at minute 0. Build costs,
  default ticket and item prices and running costs are confirmed unchanged: they are read live by saved parks, sit at
  or below willingness to pay, and running costs are about 5 % of revenue. Scenario and run cash ($9,000 to $16,000)
  stay on purpose: those parks race a deadline from minute 0. The Wave 3 browser audit placed each opening by hand from
  $5,000 with at least $1,150 left)*
- [x] PA-014: rebalance research point income against project costs so the opening branch between
  another ride, a faster food counter and landmark scenery is an actual decision
  *(done: a research cost scale, not new base costs. A new park stores `researchCostScale` 10 and every project costs
  round(base x 10) RP; cash costs and milestone rewards are unscaled, the Research Grant card (200) and the profile
  bonus (150) are scaled at application. The four openers cost 1,250 RP; the bots earn 776 to 1,008 RP by minute 12, so
  none holds all four; the first purchase lands at 3.9 to 5.4 minutes; by 45 minutes they hold 6 to 8 of 14 projects.
  Old saves keep scale 1. Milestone rewards read "Finding: +N RP")*
- [x] Rides cover a genuine spread of footprint, cost, capacity, throughput, intensity, excitement,
  reliability, running cost and appeal — including at least one thrill-tier option reachable in the
  first session without the coaster designer
  *(done: Puddle Jumpers (2x2, $650, the cheapest and most reliable ride, free), Rocket Pendulum (3x3, $2,400,
  intensity 70, excitement 64, free from minute 0: the first-session thrill ride without the designer) and Temple Trek
  (4x3, $2,600, 20 seats, covered, research Temple Expeditions))*
- [x] Every ride occupies a distinct point in that space; no strictly dominated catalog entry
  *(done: `src/game/content/dominance.test.ts` compares every same-kind pair (rides within 15 intensity, services with
  the same need and `serves`, all scenery) and refuses identical vectors. One pre-existing pair is allow-listed: Sunburst
  Flowers dominates Lollipop Lamp (10/3/$28 against 8/3/$35); scenery numbers are frozen by saved parks (a changed appeal
  or radius refuses the load), so it stays and is listed for the owner)*
- [x] Scenery themes: garden, seaside, adventure, futuristic, carnival, each with a coherent set of
  appeal values and radii
  - Scenery bonus rules, clarified on the user's question (2026-10-11): a decoration's appeal is a
    radius field over cells, and a ride's or stall's bonus is the average over its OWN footprint, so
    decorations placed beside a ride already count without any path nearby; the park-rating scenery
    component is the average of those destination scores (the connected-path average is only the
    fallback for a park with no destinations), and only the guests' walking happiness needs the
    decoration to touch a path. Two things to fix here: the Park Pulse line ("N of M connected path
    tiles decorated") and GAME_DESIGN.md described the rule as path-bound, which misleads; and the
    path-tile fallback should either stay a fallback only or go, so nobody decorates paths for the
    rating's sake. Add a **theme affinity**: a decoration whose theme matches the ride it stands
    beside gives a small extra bonus (bounded, in `GAME_CONFIG`, explained in the inspector and
    the placement preview), with a test that no objective and no card ever requires it
  *(done: seven new pieces (Bunting Mast, Shell Planter, Harbor Lighthouse, Tiki Torch, Jungle Idol, Neon Pylon, Orbit
  Globe) and a `theme` on every ride, stall and scenery piece except coasters, toilets, comforts and paths; each theme
  has a profile in numbers (BALANCE_NOTES "Phase 16"). The affinity adds min(10, matching x 0.2) to a themed
  destination's score, derived and never saved; `GAME_CONFIG.scenery.themeAffinity`. It is shown on the build card (a
  theme chip; a compact "Garden ★" where the map's biome lists the theme, the full words in the title and screen-reader
  text), in the placement readout ("Carnival match: ＋0.2 for Moonpetal Carousel") and in the inspector ("Theme ·
  Carnival: ＋0.2 from 1 carnival piece (max ＋10)"). `scenarios/themeNoRequirement.test.ts` proves no card, scenario
  rule or objective names a theme and every scenario plan and pinned run seed clears with affinity 0. The dashboard's
  scenery factor now reads "Average scenery appeal around your N rides and services; M scenery pieces." and the path
  average is kept as the fallback only, labelled as such; GAME_DESIGN.md already stated the rule)*
- [x] Service catalog widened along speed / relief / price so stall choice is a real decision
  *(done: Pretzel Pram (warm food, 2.4 s, relief 48, $3.5, $360, free: the cheapest food and the only cheap warm one)
  and Coconut Cove (cold drink, 3.0 s, relief 85, $6, $640, research Refreshment Lab: the slow premium drink against
  the fast cheap ones))*
- [x] Research tree regrown to match the widened catalog, with meaningful branch points beyond the
  first tier
  *(done: 14 projects (5 new: Refreshment Lab, Temple Expeditions, Seaside Styling, Adventure Styling, Future Styling),
  a `tier` on every project, 8,150 RP and $8,950 at scale 10. Every opener but Spin Studies forks at tier 2 (Garden
  Appeal three ways, into the three decoration themes the first park lacks), Vertical Motion at tier 3. No building
  moved project. The research tab groups the projects by branch with a tier label and the effective RP)*
- [x] `BALANCE_NOTES.md` grown from the single PROVISIONAL entry created in Phase 11 into the full
  record: the intended shape of the economy, the numbers behind it, and what each pass changed and
  why. Every PROVISIONAL entry is either confirmed with play evidence or replaced.
  *(done, by the owner decision below: BN-001 is confirmed and the Phase 16 section records the economy shape, the
  catalog, themes, tree, strategies, versioning and the re-measure. The Phase 20 to 27 sections were re-measured under
  content v3 and keep their PROVISIONAL marker until the playtests they name)*
- [x] Target: several viable early-game strategies — cheap-and-wide, one-premium-ride, and
  service-and-scenery — all reach a healthy park
  *(done: three sandbox bots (`src/game/balance/strategies.ts`, `strategyBot.ts`, `strategies.test.ts` in the default
  run). All three are healthy over minutes 35 to 45 of a 45-minute Meadow park (lowest cash ≥ 0, rating, happiness ≥ 60,
  guests ≥ 50, positive operating profit, nothing skipped), and also with affinity 0. They are distinct: wide draws the
  biggest crowd (108.9), premium earns the most per rider ($5.24), scenery has the highest scenery score (14.0) and the
  steadiest rating. The opt-in `STRATEGY_SWEEP=1` (seeds 101-110 and all 7 maps) is 51 of 51 healthy)*
- [ ] Browser playtest of each strategy from a fresh sandbox *(the owner's; the bots above and the Wave 3 audit's
  hand-placed openings are the automated proof so far)*

**Decisions (defaulted by the orchestrator on 2026-10-13; open for the owner to overturn)**

- **A comfortable mid-game is accepted.** Money piles up after about 20 minutes (the bots end 45 minutes on $8,638 to
  $11,650). Running costs are not raised: they are read live, so a rise would change every saved park and every Phase
  22, 23 and 25 measurement. The sinks are research cash ($8,950), premium rides and the landmarks ($520, $600).
- **PROVISIONAL entries.** Phase 16 closes BN-001 and its own numbers; the other PROVISIONAL sections get a "re-measured
  under content v3" line and stay PROVISIONAL pending the owner's playtests.
- **No "modernise this park" option.** Old saves keep their old research speed (scale 1) and gain no theme affinity, so
  a park in progress never changes.
- **Deviation: the affinity share ships at 0.2, not the design's 0.3.** At 0.3 two Phase 25 default-run margins went
  over the 0.90 bot margin (Standard seed 4 L5 90.4 %, the Tough seed 1 L5 deck 90.5 %); 0.2 passes narrowly (the
  tightest row is the Tough seed 4 L5 deck at 89.9 %). The research scale has no effect on those stages.

**Known limits**

- The opt-in Standard `RUN_SWEEP=1` now misses two stages of 100: seed 102 L5 went 92 % -> 93 % and seed 106 L5 (Seaside,
  visitors 420) 89 % -> 91 %. A finding for the owner; the Phase 25 tables are not retuned here.
- The classic renderer is legacy: the new rides use its generic ride art and the new stalls the generic booth, and the
  seven themed pieces draw as the flower-bed fallback there. Recolouring of the new entries is voxel only.
- At night the Jungle Idol's eyes and the Neon Pylon do not visibly glow at overview zoom (cosmetic; the lighthouse and
  the tiki flame do).
- Pre-existing, not Phase 16: the dashboard's Activity tab wraps to a second row at 1366 px and narrower.
- Two timing-sensitive tests failed now and then under full-suite load and passed alone. `GameApp.run.test.ts`
  ("on the start screen a new run, park or Scenario asks...", also seen in Phase 25) now waits for the save slot list
  before Continue; the likely cause was that list arriving later than the test's fixed settle under load (a fix by
  reasoning, not reproduced alone; the full suite was green after it). **Both fixed in Phase 14 (2026-10-14).** The
  GameApp.run flake's real cause: the start screen's backdrop preview (`SaveManager.loadPreview`) held the load lock, and
  a Continue that arrived while it was still reading failed with busy. `SaveManager.load` now waits for an in-flight
  preview, and the test waits for `menuPreview.phase === 'ready'`. `run/plan.test.ts` "maps (50 runs)" (5.1 s against
  vitest's 5 s default once at the documentation gate) now has a 30 s timeout.
- `session/parkScale.test.ts` and `rendering/voxel/scene/viewTurn.test.ts` run with affinity share 0 through a config
  mock: they are not about themes and were calibrated without it.
- The browser audit (2026-10-13: all 12 entries in the voxel renderer at noon and night in two views, 0 errors; the
  classic renderer boots and plays with all 12; layout 504 of 504 state-cells clean across the supported matrix; a11y
  10 of 10 states with 0 findings at 100 % and 130 %; an old v12 save loads with theme matching off and base research
  costs) ran from scratch scripts in the session scratchpad (`phase16ui/`), not in the repository; they may be lost on
  a container rebuild.

**Definition of done:** `BALANCE_NOTES.md` exists and matches the shipped numbers; the strategies
above are each played to a stable park; no new simulation system was added; lint, TypeScript, tests
and build pass. *(Met by the bots; the owner's browser playtest of each strategy is still open.)*

## Phase 17 — Park Tour Expansion

> **Superseded in part (2026-10-09):** the roguelite direction is now Phase 22 (game modes, scenario
> unlocks), Phase 23 (The Map, with consumable cards and procedural levels), Phase 24 (biomes and maps) and
> Phase 25 (card pool expansion). Items below that are still wanted — more objective families, more
> constraints, the no-power-creep and card-direction tests, reward variety — move into those phases when
> they are planned; this phase is not scheduled on its own.

- [ ] More nodes and a genuinely branching route with meaningful decisions, not a single fork
- [ ] Distinct environments and starting layouts per node, seeded and deterministic
- [ ] More objective families, all evaluated from existing simulation evidence and simulation time —
  never from UI text
- [ ] More constraints, each stated in one clear sentence and enforced through the compiled ruleset
- [x] More Pulse Cards, every one with at least one real advantage **and** at least one real
  disadvantage, verified by a test against `MULTIPLIER_DIRECTION`
  *(done in Phase 25: 48 cards; `cards.test.ts` gives every stage card an up and a down rule read through
  `MULTIPLIER_DIRECTION` (up iff the value is not 1 and `higherIsBetter === value > 1`) and every one-shot vector a
  positive and a negative axis)*
- [x] No power creep: newly discovered cards are alternatives, never stronger tiers; a test asserts
  no card is strictly better than another
  *(done in Phase 25: `dominance.test.ts` asserts no ordered pair of the 48 effect vectors dominates; rarity, kind,
  slot cost and tags are not axes, and a rare that dominated a common would fail)*
- [x] Reward variety beyond card drafts where it does not add raw power
  *(done in Phase 25 inside the Scenario draft: the three choices come from three different card families while three
  remain, on the rarity-weighted keyed draw over stage cards; no number on any card changes. Rewards other than cards
  stay Phase 22's unlocks and bounded bonuses)*
- [ ] Route decisions that matter — node choice changes what the next park demands, not just its
  numbers
- [ ] Full map → loadout → park → result → reward → next-park coverage extended to the new content
- [ ] Browser playtest of a complete tour on each branch

**Definition of done:** every card and objective is data; no scenario requires a specific card; the
tour is completable on every branch; lint, TypeScript, tests and build pass.

## Phase 18 — Settings, Accessibility & Responsive UI

- [x] Settings panel with persisted preferences (step 1, done): UI scale (capped to what fits the
  window, so 115/130 % become about 104 % at 1280×720 and the panel says so), reduced motion
  (System/On/Off), weather effects (Full/Reduced/Off) and lightning flashes, camera key-pan and
  wheel-zoom sensitivity, autosave interval (Off/1/2/5/10 min), notification intensity
  (All/Important/Minimal; alerts and refusals are never suppressed) and developer tools. Stored
  under `parksmith-settings`, separate from park saves. Phase 15 added the six volume sliders
  (master, music, ambience, rides, guests, UI; `ui/settingsModel.ts`, `settings/schema.ts`), so
  the earlier "waiting for Phase 15" note is closed (2026-10-15). **Not built:** screen shake (no
  shake exists; deliberately not a schema field, so there is no dead control). Opened from the gear in the top bar or
  `openSettings()` (the Phase 18 menus call it).
- [x] PA-012 shipped in the Phase 11 pre-task: developer tools live behind an explicit flag. The
  settings-panel toggle in front of that flag is done (step 1); `?dev=1` / `?dev=0` apply to one
  page load only and are never persisted.
- [x] Reduced motion (step 1, done): one module (`src/settings/motion.ts`) resolves System/On/Off
  and every consumer reads it (weather, see-through fade, hint pulse, CSS via `data-motion`). There
  is no camera easing or screen shake in the game to disable.
- [x] Keyboard accessibility (step 3, done): every control reachable and operable by keyboard, including the build
  dock (tablist with roving focus), inspectors, dashboard tabs and the tour map. A keyboard-only journey (start menu → arm → inspect and close a ride → Ctrl+S → Save/Load → rebind → pause menu) is e2e-tested; **not yet walked by keyboard in e2e:** the recovery prompt, tour offer, reward draft and scenario result. Construction gestures stay pointer-based by design
- [x] Visible focus states throughout, and accessible labels on every icon-only control (step 3, done: one focus-ring token, every icon button named, audited with Chromium's accessibility tree and axe-core)
- [x] (step 3, done: `src/settings/keybindings.ts` registry, a Keyboard section in Settings, generated `KEYBINDINGS.md` guarded by a staleness test; Esc, Ctrl+Z and Ctrl+S stay fixed) The keybinding scheme is documented in one place and made rebindable. Consistency itself was
  fixed in Phase 11 by the input context stack — the coaster designer's `R`/`F` no longer collides
  with rotate `R` because the contexts are separate — so this phase only owns documentation and
  customisation, not the conflict.
- [x] (step 3, done: pure `layoutModel.ts` plus a browser audit over about 50 combined states, clean at 1100×690 to 1920×1080 and UI scales 85–130 %; 1024×640 only for base states; see ARCHITECTURE.md 'Layout guard') Resize behaviour: the HUD stays usable from roughly 1280×720 upward, and floating panels never
  overlap (the class of bug PA-004 came from)
- [x] Screen-reader pass on the Park Pulse, notifications and the management dashboard (step 3, done through the accessibility tree and axe-core: names, roles, live regions with one announcer per notification. **Not done:** a real NVDA / VoiceOver session, touch support and localisation)
- [x] A clean-view toggle (done: `cleanView` in the UI store, `H` key under the `view` capability, always-visible "Hide/Show menus · H" handle bottom right; hidden panels stay mounted so nothing resets; not persisted across reloads): one button (and a key) that hides the build dock and every floating panel
  so the whole park can be looked at unobstructed, and brings them back exactly as they were (open
  inspectors, armed tool and draft included). Hiding must disarm nothing and must not change the
  input context in a way that lets a stray click build; the camera keys and zoom keep working. The
  state is remembered per session, and a thin always-visible handle brings the menu back so it can
  never be lost
- [x] A main menu and an in-game pause menu (step 2 done; decisions and limits in ARCHITECTURE.md, "Menus"). *Original spec follows; deviations: the `menu` layer sits below Settings, the Parks map and its loadout as well as Save / Load and the recovery prompt, because all of them open FROM the menu; the first run (no profile, no saves) skips the start screen and keeps the Phase 13 flow; Continue starts the park paused like Load does; the Menu entry is a button in the left utility rail (and Esc) rather than in the top bar; Phase 19's version/changelog entry is a small static About panel for now; the fatal-error screen does not exist yet, so its precedence over the menu is untested.* Today the game starts straight in a sandbox park and
  Parks, Save / Load and (soon) Settings are loose buttons in the top bar; this item ties them
  together and is built with the settings panel because the two need each other:
  - **Start screen** with Continue (the latest autosave or manual slot, with its age and key
    numbers), New park, Parks and scenarios (the existing Parks map), Load (the existing Save /
    Load dialog), Settings (the panel above) and About / changelog (the Phase 19 version and
    changelog entry). Continue is the default focus; with no save the menu leads with New park
    and the First Day onboarding (Phase 13) still starts on the first run.
  - **Camera sweep over the latest park behind the menu**: the saved park is loaded paused and
    read-only and the camera drifts slowly across it (a slow pan with the integer zoom fixed, in
    the park's own time of day and weather), so the menu looks like the game. It stands still
    under reduced motion, runs no simulation ticks, builds nothing and takes no input except the
    menu's; a menu with no save shows the empty starter map. Loading uses the same atomic session
    swap as Save / Load, so choosing Continue starts exactly the parked state (hash-equal) and an
    unreadable save falls back to the plain menu with a message instead of an empty screen. The
    sweep must stay cheap on a low-tier machine (a frame-time budget test with the sweep running,
    and no sweep at all when the voxel renderer fell back to classic on a software GPU).
  - **Pause menu**: Esc with nothing else to close opens it (Resume, Save, Load, Settings, Parks,
    Quit to menu) and pauses the clock while it is open; Esc order in the input context stack
    gains a `menu` layer that sits above the world and below the Save / Load dialog and the
    recovery prompt, and every existing Esc behaviour (armed tool first, then inspectors) stays as
    it is. Quit to menu asks to save when there are unsaved changes.
  - **Later (Phase 22):** *New park* becomes the three game modes — Sandbox, Scenario and The Map —
    with The Map as the default entry.
  - The crash-recovery offer (Phase 12 step 3) and the fatal-error screen (Phase 19) take
    precedence over the menu, and the clean-view handle and keyboard-only operation cover it.

**Definition of done:** every setting persists and takes effect immediately; the whole game is
operable without a mouse except for construction gestures; no two floating panels overlap at any
supported viewport size; lint, TypeScript, tests and build pass.

## Phase 19 — Public Alpha Readiness

**Built as far as this machine can take it (2026-10-14).** What needs the owner is marked: hosting the build (an
account and a repository), real browsers on real hardware, and the telemetry decision. Game version **0.2.0**.

- [ ] Production deployment pipeline and a hosted build *(pipeline ready, hosting is the owner's: `.github/workflows/
  deploy.yml` checks (lint, types, tests) and builds every push to main and publishes `dist/` to GitHub Pages;
  `PARKSMITH_BASE` sets the public path (checked: a `/parksmith/` build references `/parksmith/assets/...`) and the
  repository variable `PARKSMITH_FEEDBACK_URL` the feedback page. Needs the code in a GitHub repository with Pages set to
  GitHub Actions; not run from here (no repository, no account))*
- [x] PA-026: a branded loading state during Pixi initialisation, and a fatal-error screen with a reload and a "recover
  last save" action *(done: `index.html` shows the brand before scripts run and `App` keeps a matching boot screen until
  the renderer has mounted (headless Chromium: up at 20 ms, gone at about 1.6 s with the canvas). `FatalScreen` replaces
  the game when no renderer starts or the frame loop throws: Reload, Reload and recover last save (a one-shot
  sessionStorage flag; the next boot continues the newest save as soon as the start screen has read it), Download an error
  report)*
- [x] Save recovery is wired to the fatal path and to an unclean shutdown *(done: a throwing frame stops the park, runs
  the hidden-page flush (an emergency autosave of a changed park) and silences the audio once (`GameApp.enterFatal`,
  `GameApp.alpha.test.ts`); the unclean-shutdown half was Phase 12)*
- [x] A visible game version and a changelog reachable from the HUD *(done: the pause menu's "About and feedback v0.2.0"
  (and the start screen's) opens the changelog, now with a 0.2.0 entry)*
- [x] A feedback entry point that carries the version and, with consent, the current save *(done: the form under About
  builds a report (version, save schema and content version, renderer, browser, screen, a few settings, the message, the
  fatal error if any) and attaches the park as a save file only when the box is ticked; Copy report or Download report
  (`parksmith-feedback-<version>-<time>.json`), plus "Open the feedback page" when `VITE_FEEDBACK_URL` is set. The game
  sends nothing itself. Checked in Chromium: 641 bytes without the park, 13.7 kB with it)*
- [ ] Browser compatibility pass *(headless, software GL, 2026-10-14: **Chromium 156** voxel and classic, saves through
  IndexedDB, no console error; **Firefox 157** (llvmpipe) voxel with `voxelAllowSoftware`, and without it the classic
  fallback boots, builds, runs and saves, reload and load keep the slot; **WebKit 27.2** boots the voxel renderer (it
  reports "Apple GPU", so the software guard cannot fire) and saves and loads once, but the headless WPE page closed
  itself mid-run in four of five runs, unexplained and not reproduced elsewhere. Open for the owner: real Safari and Edge,
  real GPUs (the voxel checklist below))*
- [ ] Performance floor on a low-tier machine *(headless Chromium, dev park, 1,000 guests, 1280 x 800: frame rate is
  bound by the software GPU (about 12-14 fps at 1x, 4x and 6x CPU throttle alike), while the main thread's simulation plus
  renderer work is about 1.8 ms at 1x, 7.6 ms at 4x and 11.5 ms at 6x, inside a 16.7 ms frame. The one real-GPU
  measurement (Windows, Direct3D 11, voxel section) held 60+ fps to 12.2x. Open: a real low-tier device. Figure culling
  (voxel leftovers) now skips off-screen guests)*
- [ ] Optional: opt-in telemetry *(not built: the alpha ships without it, as the plan allows)*

**Definition of done:** a stranger can open the hosted URL, play a full session, survive a reload, and send feedback;
lint, TypeScript, tests and build pass. *Everything but "the hosted URL" is in place; hosting is the owner's step.*

## Phase 20 — Days, Day/Night & Weather

New simulation systems, deliberately after the alpha: they change what the park feels like and add
decisions, but nothing in them fixes friction. Depends on Phase 12 (the day count and the weather
state must be saved) and on Phase 15 (feedback and audio for rain and storms).

- [x] A calendar on the fixed-step clock: a day is a configurable number of simulation seconds
  (`GAME_CONFIG`), days count up from day 1, and the HUD shows the day and the time of day.
  Pausing stops the day; speeds 2× and 4× advance it faster. Scenario deadlines may be expressed in
  days as well as seconds *(step 1: calendar, schema 3 + migration, top-bar clock chip; step 2: a
  scenario may write `timeLimitDays` through `defineScenario`, compiled to seconds at the fixed
  720 s scenario day, shown as "1.4 days left" and "2 days (24:00)"; the four shipped scenarios
  stay in seconds)*
- [x] Time of day drives the look: dawn, day, dusk, night. The voxel renderer already has day, dusk
  and night light presets (`&light=`); this phase interpolates between them from the clock instead of
  taking a URL flag, and the classic renderer gets a simple tint. Lamps, windows and ride lights
  come on at dusk. Presentation reads the clock and never feeds back into the simulation, like the
  rest of the render layer *(step 1 done; the existing night, dusk and day values are unchanged, a
  dawn is derived by mixing; `&light=` stays an explicit override and `&time=` pins the look)*
- [x] Optional opening hours and guest arrival over the day: arrivals follow a deterministic curve
  (quiet morning, busy afternoon, thin evening), guests leave at night unless the park stays open.
  Every constant lives in `GAME_CONFIG` *(step 2 done: `calendar.arrivalCurve` scales the arrival
  countdown, opening hours are a Sandbox switch (off by default so the First Day pacing is unchanged;
  with hours on, guests are sent home at closing time and the gate shuts), Always / 08-21 / 06-23
  presets in the clock popover)*
- [x] A seeded weather model: sunny, hot, cloudy, rain, storm (and fog if cheap), chosen by a seeded
  Markov chain per day so the same seed gives the same weather, with a short forecast the player can
  read. Weather state is plain data in the world session, never wall-clock based *(step 2 done;
  fog skipped: it needs a sixth transition row and a presentation-only effect, `WeatherKind` is a
  closed union so it can be added in one place later; schema 4 + migration; the forecast IS the
  saved future)*
- [x] Gameplay effects, each small and explained in Park Pulse rather than hidden: heat raises drink
  demand and lowers walking speed; rain lowers arrivals, makes guests seek shelter and covered
  rides, and raises umbrella and hot-food demand; storms close open-air rides for their duration
  (the existing closed/broken state, with a distinct reason) and can be a reason to build shelter.
  Pulse Cards and scenarios can modify the weather mix through the compiled ruleset *(step 2 done:
  the catalog has no umbrellas, so warm food stands in for them; there is no shelter building, so
  covered rides draw guests in the rain; `wetWeatherMultiplier` is plumbing and tests, no card or
  scenario uses it yet)*
- [x] Weather presentation: clouds and cloud shadows, rain streaks, puddle sheen, lightning flashes,
  heat shimmer. In the voxel renderer this is pixel overlays and composite tweaks (no per-frame
  geometry rebuilds, no alpha blending, world-anchored dither); in the classic renderer it stays
  deliberately simple. Reduced motion (Phase 18) turns the effects off
  *(step 3 done: shared core `weatherLook.ts`, classic renderer, voxel composite pass with a lite subset and a
  no-weather fallback rung, live reduced motion, pause freeze, flash cap of 3 per second and the `&weather=` testing
  flags. Leftovers: visible cloud bodies or haze, lamps coming on in daytime storms, classic puddles and shimmer,
  flash on a transparent page backdrop, a presentation-only off switch (Phase 18), a captured pop-free transition
  sequence (argued by the slew design and its unit tests, not seen) and a long-session day-cycle capture; audio belongs
  to Phase 15 and is not built here)*
- [x] Sandbox switches: weather on/off and its intensity, a fixed time of day, and the day length
  *(step 1 done: fixed time of day and day length, in a popover from the clock chip; step 2 done:
  weather off / low / normal / high and opening hours in the same popover; step 3 audit: all of them exist and the
  presentation respects weather off and the severity scale, tested in `weatherLook.test.ts`; leftover: a
  presentation-only off switch waits for Phase 18's settings screen, reduced motion is the only one now)*
- [x] Deterministic coverage: calendar arithmetic across speeds and pauses, the seeded weather chain
  and forecast, effect formulas, save/restore of the day and the weather state, and that two runs
  with the same seed agree *(step 2 done for the simulation: chain, forecast, effects, storm closure,
  save, undo, migration and a determinism fixture; presentation coverage is step 3: pure mapping, flash cap, reduced motion, slew, classic pooling and tint, the voxel
  uniform-dirty, zero-rebuild and fallback tests and the fxc static test are green)*

**Definition of done:** a long session shows a full day cycle and varied weather with readable
causes and effects, the zero-rebuild frame test still passes with all effects active, the weather
is identical for the same seed, and lint, TypeScript, tests and build pass.

## Phase 21 — Land Expansion

Buying land turns the size of the park into a decision. Depends on Phase 12 (the owned area and the map size are in the
save) and Phase 11B (rendering scale).

**Built (2026-10-14).** One big map divided into 8 x 8 parcels (the voxel chunk); maps are 32 to 64 cells a side in whole
parcels; land is never sold back (the user's decisions, 2026-10-14). Every 32 x 32 map stays wholly owned, so every old
park, save, scenario, run and bot proof is bit-identical (the identity, lift and determinism pins pass unchanged, with
one strip shim for the unused `land` finance row and `landCostMultiplier: 1` added to the compiled-rules pins). The first
estate, **Meadow Estate** (64 x 64), starts with 12 of its 64 parcels; the scenario **Room to Grow** asks for 20. The
architecture is in ARCHITECTURE.md "Land (Phase 21)", the numbers in BALANCE_NOTES.md "Phase 21". Save schema **14**,
`SAVE_CONTENT_VERSION` 4 (unchanged: no old park continues differently), `RUN_PLAN_VERSION` 4 (unchanged).

- [x] Land ownership: parcels, only owned parcels can be built on, a new park starts with a small owned area around
  the entrance *(done: `src/game/land/` (`parcels.ts` geometry and price, `LandOwnership.ts`), `GameWorld.land`. A map's
  `ownedArea` (null = wholly owned, else a parcel-aligned rectangle holding the gate) seeds it; a scenario may override it.
  Paths, objects, coaster pieces and clearing a prop all need owned cells)*
- [x] Buying: a parcel sharing an edge with owned land, priced before committing, paid as a ledger transaction with its
  own finance category *(done: `world.checkParcelPurchase` / `buyParcel`, category `land-purchase` -> management `land`
  ("Land" in the Finances tab). Price = round10((600 + 75 x parcels owned) x distance factor x `landCostMultiplier`), the
  distance factor 1.15 at the gate's parcel falling 0.05 a parcel to 0.8. The Land tool (▦, key L, shown only on an
  estate) previews the whole parcel, says the price or why not, and a purchase is one undo entry ("Land bought"))*
- [x] Unowned land is readable at a glance and never silently unbuildable *(done: voxel overlay layer under the others:
  unowned parcels dimmed (3/8 for sale now, 5/8 beyond), a 2-texel fence round the owned land, a sign at the centre of
  every parcel for sale; the pointer reads "For sale · $1,230" / "Not your land"; every placement, path and clearing
  refusal names it ("Not your land · buy this parcel for $X with the Land tool"), typed reason `unowned`. The map
  previews dim the land for sale and fence the start. Classic renderer: refusals and readouts only, no overlay (legacy))*
- [x] The simulation respects ownership *(done: guests can only reach owned paths (nothing else can be built); the
  scenery heatmap lists owned cells only; the gate is always owned (the owned set is one connected area around it))*
- [x] A larger world *(done: `GAME_CONFIG.land` holds the parcel size and the size bounds; the validators, the save's map
  check, the area-bound map caps (`areaScaledCap`) and the voxel budgets per 32 x 32 of area follow the map size; the
  camera framing's "heart" is the middle of the owned land. Measured on Meadow Estate fully bought (1,470 path tiles, 10
  rides, 1,000 guests): 0.2 ms a tick in Node, inside the 8 ms budget (`performance.maps.test.ts`))*
- [x] Camera: pan limits follow the owned area plus a parcel *(done: `VoxelCamera.setPlotBounds` takes an origin and a
  margin cap; on an estate the plot is the owned land and the margin at most one parcel, so the screen centre stays within
  a parcel of the park (the first cut padded the plot by a parcel AND kept the viewport-sized margin, and the browser check
  showed a view of only dimmed land); re-read when the land changes. Classic: no new behaviour)*
- [x] Scenarios declare a starting owned area and map size; objectives may include "own N parcels"; Pulse Cards may change
  land prices *(done: `ScenarioDefinition.ownedArea`, the map sets the size; the `ownedParcels` metric; the
  card-modifiable `landCostMultiplier` and the permanent bonus Land surveyor (-5 %, Room to Grow's reward). No Pulse Card
  uses it yet: a card would change run plans and runs play 32 x 32 maps)*
- [x] Deterministic coverage *(done: `land/land.test.ts`: parcel rules, price, buildability, purchases, the owned set's
  save, restore refusals, an estate park saved and continued like a never-saved twin, migration 13 -> 14, guests and the
  heatmap on owned land; the 1,000-guest scale test on the estate; the winnability proof of Room to Grow)*

**Settled:** one big map with parcels (not a growing map); maximum 64 x 64; land is never sold back; terrain features are
not tied to parcels (there is no terrain elevation yet).

**Checked in headless Chromium (2026-10-14, SwiftShader):** dimming (two levels), fence, signs at parcel centres, the
Land tool's preview and readouts, a purchase, the pointer readouts, Meadow Garden unchanged, no console errors. Fixed from
it: the pan limit (above) and the Undo label clipped to "U" by a fifth dock tool (the Land button is icon-only).

**Generated estates (2026-10-14, follow-up):** the Sandbox's Generate has an "Estate (64 x 64, buy land)" switch for every
biome. A recipe may carry `size: 64` (only then: a classic recipe keeps its exact shape, id and map, and the golden corpus
is unchanged, so `GENERATOR_VERSION` stays 2); the generator's size is a live binding set for one synchronous run, the
area-bound caps (props, box weight, water) scale with the area, and the starting land is four parcels along the gate's
edge and three deep. 144 estates (6 biomes x 8 seeds x 3 densities) are valid in `generator.estate.test.ts`; a 450-map
probe found no failure, at 30-50 ms a map. The biome features keep their 32-cell sizes near the gate; the land beyond is
filled by the biome's rules.

**Open:** the owner's playtest of the estate; The Map still plays 32 x 32 levels; a Pulse Card on land prices (with a
`RUN_PLAN_VERSION` bump) once runs can play an estate.

## Phases 22–28 — Game modes, roguelite map, biomes, cards, view rotation, coasters, colours

Added on the user's request (2026-10-09; Phase 28 and the lift-hill item on 2026-10-10). They are written as
seven phases so each can be planned, built in steps and reported on its own. **Suggested order:** 27
(in progress, visible) → 26 → 28 → 24 → 22 → 23 → 25, with Phase 21 (land) fitting in wherever map size
matters (Phase 21 is built, 2026-10-14). Dependencies are stated in each phase. Phase 27 (all four steps) is built; Phase 26 is built in both renderers (step 1: orientation module, input, app state and the classic renderer; step 2: the voxel renderer); the voxel art matrix of catalog entries outside the dev park is open. Phase 25 (the card pool, with steps 1-5 of
Phase 23's difficulty retune) is built (2026-10-13); the retune's playtest (step 6) is open.

## Phase 22 — Game Modes & Scenario Unlocks

Today the game has a Sandbox, four hand-written scenarios and the Park Tour (a hand-made branching
map, Phase 8C). The main menu (Phase 18 step 2) said "New park" and "Parks and scenarios". This phase
makes the **three modes** first-class and startable from the main menu, and gives scenarios a lasting
reward. Designer decisions and answers to the open questions are in the section after the checklist;
the architecture is in ARCHITECTURE.md "Game modes and profile".

- [x] A typed **game mode** — `sandbox | scenario | run` — stored in the session and in the save
  envelope (schema 9 to 10 with a real migration: every existing save maps to sandbox or scenario by
  its `scenarioId`), shown in Continue's description and in the Save / Load dialog
  *(done: `ParkSession.mode`, `ParkSaveV10.mode` plus the park grant, frozen v9 fixtures captured before
  `state.ts` was touched, hostile values refused, mode in the slot metadata, the autosave row, Continue and the
  recovery offer; undo and two-tab revisions carry the mode unchanged)*
- [x] **Main menu** (extends the Phase 18 start screen): *New park* becomes three entries —
  **Sandbox** (optionally pick a biome/map and a seed, Phase 24), **Scenario** (a list of specific
  scenarios, locked ones visible with their unlock condition) and **The Map** (Phase 23, the default
  and focused entry for a new profile). The pause menu's Parks button opens the same chooser. First-run
  flow (Phase 13) keeps working and decides which mode a brand-new player lands in
  *(done with the interim below: **The Map is the Park Tour for now** — the entry opens the existing Park Tour map,
  parks started there have mode `run`, and the first-run flow lands on that same map by itself, so a new player is never
  blocked. The full Map arrived with Phase 23, which also ended this interim. The pause menu's Parks opens the same three-way chooser; real-UI e2e
  `phase22/e2e-modes.mjs` and the Phase 13 First Day e2e pass)*
- [x] **Scenario mode**: a browsable list (name, biome, objective, difficulty, best result, reward),
  start, retry with the same seed, result screen with what was unlocked. Scenarios are data (the
  existing `ScenarioDefinition`) and may declare a map/biome (Phase 24), starting layout, rules and
  rewards. No scenario may require a specific card or an unlock it cannot itself grant
  *(done: nine scenarios — the four shipped ones unchanged in rules and map, plus Boardwalk Breeze, Canyon Caravan,
  Frost Fair, Ruins Rush and Harvest Festival on the Phase 24 maps — each with difficulty, an unlock condition and
  rewards; map previews from Phase 24 in the list; each scenario is proven winnable by a scripted bot with no card,
  unlock or bonus, on four seeds and when the whole plan starts 30, 90 or 240 s late, always within 85% of the deadline
  (after review Harvest Festival became a profit objective and Frost Fair's happiness bar dropped, because their rating
  and happiness sustains were decided by timing luck); balance stays PROVISIONAL in BALANCE_NOTES)*
- [x] **Scenario rewards that last**: a scenario can unlock **specific buildings** (catalog entries
  gated by a profile unlock, available in the other modes from the start screen of a park or the
  research tree) and **permanent bonuses** (small, bounded, listed — e.g. extra starting cash, a card
  slot, a research head start). Bonuses enter through the compiled ruleset as one more layer (base →
  scenario → profile bonuses → cards → safety clamps) with per-bonus and total clamps and a test per
  bonus; the loadout and the management dashboard show exactly which are active. **This changes a
  Phase 8B rule** ("avoid permanent raw-stat upgrades"): permanent bonuses are now allowed but small,
  visible and clamped, and a profile switch (default on for Scenario and The Map, default off for
  Sandbox) lets the player play without them
  *(done: four gated entries — Tiki Tumbler, Cactus Cooler, Cocoa Chalet, Lantern Maple — with voxel and classic art
  and no new palette material (162 stays), and six bonuses (Nest egg, Research grant, Builder's discount, Spare card
  slot, Word of mouth, Trusted crew), all within the stated clamps; the Phase 8B "no permanent raw-stat upgrades" rule is
  now this bounded, listed, switchable exception)*
- [x] A versioned **profile** (extends the Park Tour profile in `parksmith-profile`): completed
  scenarios and best results, unlocked buildings, discovered cards, permanent bonuses, mode statistics;
  corruption-safe like the settings store and covered by migration fixtures. A **Collection** screen
  (from the menu) lists unlocks and discovered cards
  *(done: profile v2 with v1 migration and five frozen v1 fixtures, garbage/newer-version/blocked-storage handling,
  monotonic merge and the cross-tab `storage` event; the Collection screen has Buildings, Pulse Cards, Bonuses (with the
  three switches) and Stats tabs)*
- [x] (The Map's own run state is Phase 23) Mode-aware autosave and recovery: autosave slots and the crash-recovery offer say which mode
  they belong to; The Map saves its run state (Phase 23) next to the park
  *(done for the modes that exist: the autosave slot's metadata, the recovery marker and offer carry the mode and a kept
  copy is named `Recovered autosave (Scenario)`; the autosave stays one slot. Not built: a run state next to the park,
  which exists only with the real Map)*
- [x] Deterministic coverage: mode round trip through save and load, profile migration and clamping,
  unlock gating in the catalog and research, bonus composition and clamps, menu flows by keyboard
  *(done: see ARCHITECTURE.md "Game modes and profile", Tests)*
- [ ] Browser playtest of the whole loop by a person (the e2e drives it with developer hooks, so how the unlock and
  bonus pacing feels over several real sessions is untested)

**Decisions (designer) and the open questions answered**

- **The Map interim (over since Phase 23):** the entry opened the existing Park Tour map with the label "Park Tour route
  for now; the full Map is coming". Phase 23 replaced it with the real Map (runs) and retired the Tour; a v10 save from
  the interim continues as a Scenario park.
- **Unlocked buildings in The Map's research tree?** In Phase 22 an unlocked building is available from the start of
  every park in every mode, exactly like Scenario. *(Phase 23 decision: kept for The Map. The research-tree variant is
  withdrawn and revisited with Phase 25; the grant is snapshotted at run start, so a run stays deterministic.)*
- **Can permanent bonuses be lost?** No. A bonus is earned once and kept forever, never consumed, no decay, no reset UI;
  the way to play without them is the per-mode switch. Unlocks are not switchable (they are alternatives, never stronger
  tiers).
- **Switch defaults:** on for Scenario and The Map, off for Sandbox (the creative mode whose numbers stay as designed); a
  change applies to parks started afterwards.
- **Park Tour conversion:** converted, not retired: route, cards and flags are kept, every completed tour node counts as a
  clear of its scenario (rewards granted retroactively) and a one-time notice says what carried over.
- **Rewards:** per scenario, once, from a clear in Scenario mode or on The Map. A park snapshots the profile when it
  starts; loading never reads the live profile.
- **Recolour cost:** stays 0 in every mode (the mode only decides which price table the plumbing reads).
- **Known limits:** one autosave slot, pause-menu Parks does not ask about unsaved changes, an old tour save reads as Scenario.

- Known, unfixed (pinned as expected-fail tests in `src/game/profile/profileSafety.review.test.ts`): a stale
  old-build tab writing a v1 profile can revert the bonuses switch and bring back a dismissed notice; unlocks
  and bonuses themselves survive through the v2 shadow copy. Fix when the profile store gets a general
  write-fence (Phase 19).

**Definition of done:** all three modes can be started from the main menu and continued from a save;
a scenario can unlock a building and a bounded permanent bonus that the other modes honour; profile
and saves migrate; lint, TypeScript, tests and build pass. *(Met with The Map as the interim Park Tour; the real
Map arrived with Phase 23.)*

## Phase 23 — The Map (roguelite run mode)

"The Map" is the default roguelite mode and **replaces the hand-made Park Tour** as the main
progression (the tested map → loadout → park → result → reward flow and `TourManager` were the starting
point to evolve, not to throw away). A run is a fixed number of **levels** of procedurally generated
parks in different biomes that must be cleared in order, played with a **deck of cards that are used up**.
Depends on Phase 24 (biomes and maps), Phase 22 (modes and profile) and Phase 12 (save). Designer
decisions and the answers to the open questions are in the section after the checklist; the architecture is in
ARCHITECTURE.md "The Map (runs)" and every number is PROVISIONAL in BALANCE_NOTES.md "Phase 23".

- [x] **Run state** (plain data, seeded, saved and restored): run seed, level index, a configurable
  number of levels (X, in `GAME_CONFIG.run`, tuned in balance), the generated level list (biome, map seed,
  objective, conditions) fixed at run start so a seed always gives the same run, the deck, the cards
  used so far, result history. A run can be continued after a reload or a crash exactly like a park
  *(done: `src/game/run/`, `RunStateV1`, own RNG streams, 5 levels, pinned plan digests; the run lives in the park save
  (schema 11) and the Continue, load and recovery paths settle it)*
- [x] **Starting deck**: the player starts the run with X cards (a configurable count, drawn from a
  seeded starter pool, never a power spike); the deck is visible at any time from the run screen
  *(done: 3 cards, never an opposing pair; the deck and used-pile drawers on the run map)*
- [x] **Between levels**: the player is **offered X cards that are added to the deck** (seeded,
  duplicate-protected, deterministic from run seed and level; decide whether *all* offered cards are
  added or the player picks some — see open questions), then **chooses X cards from the deck as the
  loadout for the next stage** (slot count is configurable and may grow with level). The loadout is
  locked when the stage starts *(done: 2 offered per level, **all join the deck**, `pick N of M` is data with a tested
  branch and no UI; slots 1, 1, 2, 2, 3 plus the Spare card slot bonus; a copy cap of 3; every offer shows upside and
  downside like the loadout)*
- [x] **Cards are consumed**: a card played in a stage is removed from the deck for the rest of the run
  (decide whether a stage-long card is consumed at stage start or only when the stage is cleared, and
  what happens to the loadout on failure); one-shot cards (Phase 25) are consumed when they fire.
  The deck, the discard/used pile and the loadout are saved, undo-safe and shown with counts
  *(done for stage-long cards: consumed at stage start (`consumeAt`, the clear variant is data with a tested branch); on
  failure the run ends either way; one-shot cards are Phase 25. Undo inside a stage never touches the run: the deck changes
  once, before the stage session exists, and the ring is empty at every stage boundary. Phase 25 added one-shots: used up
  when played, an unplayed one goes back to the deck when the level resolves)*
- [x] **Stage**: a generated park (Phase 24) with an objective from the existing objective families
  evaluated from simulation evidence, scaled by level, plus the stage's conditions; the park uses the
  Phase 20 calendar and weather with the biome's mix. Clearing it returns to the run map
  *(done: a `ParkSession` in mode `run` on the level's recipe; visitors, profit, crowd and spirits families scaled by
  level and difficulty; nine conditions through the scenario ruleset layer; the bonuses layer stays per Phase 22)*
- [x] **Run map screen** (reached from the main menu's The Map entry and after each stage): the levels
  as a path with biome icons, the current level highlighted, deck and loadout buttons, run summary;
  keyboard operable, reduced motion and UI-scale safe like the other screens
  *(done: setup panel (Continue run, seed, difficulty, route preview), run map, offer, loadout, stage result, victory and
  Run over screens; real-UI e2e `phase23/e2e-run.mjs` incl. a keyboard-only run; audits in "Audit and e2e results" below)*
- [x] **Failure and victory**: failing a stage ends the run by default (a result screen with what was
  reached and what was learned/unlocked); decide whether limited retries or "continue with a penalty" are
  offered later as a challenge option. Clearing the last level ends the run in victory with a summary and
  profile rewards (Phase 22: discovered cards, unlocks — never raw power that trivialises a run)
  *(done: a loss at the level reached updates the best level; a victory discovers the deck's cards and opens Tough; no
  bonus, cash or building; "Try this seed again" replaces retries)*
- [x] **Difficulty curve** across levels: objective targets, deadlines, starting cash and conditions
  scale by level and by a run difficulty setting, balanced in `BALANCE_NOTES.md`; a scripted bot or
  rule-based playthrough per biome proves each level is clearable with a plausible deck and that no
  single card is required *(done: relaxed, standard, tough; the bot clears every level with no card inside the margin
  (0.85, tough 0.95) and the plausible-deck checks pass; margins in BALANCE_NOTES. Review fix (plan version 2): the curve
  was set by the family drawn (crowd and spirits cleared at the same point on every level and difficulty), so crowd is
  now the opening family of levels 1-2, spirits holds grow with the level and the difficulty, and level 5 draws visitors
  or profit; a 300-stage sweep shows the medians rising level by level at every difficulty, worst Tough L5 at 86%.
  Phase 25 retuned the table (plan version 4; margins now 0.85 / 0.90 / 1.00), see the retune item below)*
- [x] **Migration of the Park Tour**: its profile and saved tour state convert or are retired with a
  clear message; the handcrafted tour content may live on as scenarios (Phase 22)
  *(done: retired. `TourManager`, the tour map UI, `resetTour` and the tour storage option are deleted, a v10 save of the
  interim Map continues as a Scenario park, the Phase 22 conversion notice stays, the profile's tour slice and
  `app.tourNodeId` are kept read-only for migration safety, and the four tour parks are scenarios in the browser; a
  static test gates dead tour UI in `src/ui` and `src/app`)*
- [x] Determinism and save coverage: the same seed gives the same run (levels, offers, starter deck),
  save/restore of every run field with hash proofs, hostile/corrupt run state rejected, crash recovery
  mid-stage, undo ring behaviour inside a stage, the 1,000-guest performance budget on each biome's map
  *(done: 1,000 seeds x 3 difficulties in one process and across two; schema 11 with frozen v10 fixtures, migration and
  hostile-run tests; the run in the autosave, the slot metadata and the recovery offer; the 1,000-guest budget holds on the
  heaviest accepted level map of the corpus, not on every one)*
- [ ] Browser playtest of complete runs *(not done: the automated real-UI e2e plays whole runs with the development hook
  that latches a stage result; a human playtest of real levels, real pacing and the felt difficulty is still open)*

- [ ] **Difficulty retune after the user's first full run (2026-10-13).** The user cleared a whole Standard run
  on the first try with the 6-card pool, with 15–18 minutes to spare on every level (level 1 cleared at 2:45 of a
  1.5-day deadline, level 2 at 6:58, level 3 at 6:07, level 4 at 12:04, level 5 at 15:25; 7 cards played, 2 new
  cards discovered). That matches the bot's numbers (Standard clears at 24–62 % of the deadline) and means the
  current Standard is a Relaxed. To do, as a balance pass with the bot as the floor and the user's run as the
  ceiling: (1) make today's Standard numbers the new **Relaxed**; (2) retune **Standard** so a competent first
  run clears level 5 at about 80 % of the deadline (shorter deadlines first — a level should not have 15 minutes
  to spare — then higher visitor/profit targets, then tighter starting cash on levels 3–5); (3) **Tough** adds a
  condition on every level from level 2 and a cash squeeze, aiming for a real chance of failure on levels 4–5;
  (4) scale the three difficulties through one table in `GAME_CONFIG.run` so the bot sweep, `BALANCE_NOTES` and
  the e2e stay the source of truth; (5) keep the no-card-required rule, but let cards be what makes Tough
  comfortable rather than optional (this is where Phase 25's bigger pool, rarity and one-shots do the real
  work, so finish this item together with Phase 25's balance script); (6) re-run the user's playtest after the
  change and record it in `BALANCE_NOTES.md`. Also noted from the run: results screens read well; the user
  wants the run to feel harder, not longer
  *(steps 1-5 done in Phase 25, 2026-10-13, plan version 4: one table, `GAME_CONFIG.run.difficulties`, holds deadlines
  per difficulty (the `levels[]` rows lost `deadlineDays`), target scale, spirits hold and bar, cash, conditions, density
  and the two margins. Relaxed is the old Standard (its sweep matches the plan-v2 Standard row); Standard has deadlines
  of 1.25 / 1.75 / 1.75 / 2.25 / 2.25 days (9.25 park days instead of 10.5), targets x1.10 and $250-1,000 less cash;
  Tough has Standard's deadlines and targets (x1.10, the design's x1.15 was the first step back down the ladder because a
  plausible deck missed 0.90 at level 5), +1 condition, one density step, $1,000-2,500 less cash and a longer, higher
  spirits hold. Measured, no card (300-stage sweep): Standard L5 median 69.5 % of the deadline (band 68-80), Tough worst
  92 % (margin 1.00); a plausible deck at Tough L4-5 worst 88 % (margin 0.90). Table and curve in BALANCE_NOTES "Phase 25".
  **Step 6 is open:** the user's playtest decides whether Tough feels hard enough. The no-card bot is never short of
  cash, so Tough measures barely harder than Standard for it; if Tough is too soft for a person, the levers are Tough's
  cash and conditions, not its deadlines)*
**Decisions (designer) and the open questions answered**

- **All offered cards are added** (the user's wording); `offerRule` is data and `pick N of M` is implemented and tested for a
  later challenge mode or Phase 25.
- **Consume on stage start** (default). On failure the run ends either way; undo and reload stay simple because the deck
  changes once, at a boundary undo can never cross. `consumeAt: 'stage-clear'` is data with a tested branch.
- **Levels, slots, deck:** 5 levels (6 biomes exist; Meadow first, then four distinct biomes), starter deck 3, offer 2
  before every level, slots 1-1-2-2-3, copy cap 3 per card ever added (the pool has six cards, so copies carry the maths;
  no card is added in this phase: it would reshuffle Scenario reward drafts, and Phase 25 owns the pool).
- **One fixed route** (`levels[]`, not a graph); a branching route is a later extension (a format bump).
- **No run currency or shops;** the only economy between levels is the deck.
- **No retries:** a failed stage ends the run; "Try this seed again" is a fresh run with the same levels. Limited retries
  and "continue with a penalty" are later challenge options.
- **Profile rewards:** victory only; every card that joined the deck is discovered, the first Standard or Tough victory
  opens Tough, run statistics are recorded. Never raw power.
- **Unlocked buildings and bonuses on The Map:** as in Scenario (an unlock is buildable from the start of every stage; the
  Phase 22 research-tree note is withdrawn). The grant is snapshotted once at run start and used by every stage; the
  profile's per-mode switch decides the bonuses (Spare card slot adds one slot to every level).
- **First run (decision):** a brand-new profile keeps landing in the **Sandbox First Day** park, and nothing opens over it.
  First Day's engine and save invariants are Sandbox-only, a deadline and a run-ending failure are the wrong pressure for
  a tutorial, and level 1 of every run (Meadow, friendly families) makes the step to The Map small. The Park Tour map
  that opened by itself is gone; the one-time Park Pulse offer became "Ready for The Map?" (the same stable-park rule, the
  same stored flag).
- **Park Tour: retired,** see the migration item. Its profile progress was already converted by Phase 22.
- **Leaving an unfinished run asks first** (new run, new park, Scenario, Load) because the autosave is the only slot; Save
  first opens Save / Load.
- **Known limits:** manual saves of an older moment allow save-scumming; a tab on an older build drops the profile's `runs`
  slice (pinned expected-fail test); a run made by an older map generator version cannot continue (it ends as abandoned
  with no loss counted); the run's profile key is `seed-difficulty-runHash`, so a replayed seed is its own attempt.

**Audit and e2e results (2026-10-12, classic renderer; scratch tools `phase23/e2e-run.mjs`, `e2e-firstday.mjs`,
`layout-audit.mjs`, `a11y-audit.mjs`).** The run e2e passes 115 checks (first run; setup, offer, loadout, stage, win through
the development hook, next level, quick save mid-stage, reload and Continue, the autosave at the run map, failure, Run over,
same seed, abandon; a whole run to victory with Tough unlocking; the leave-run prompt; the frozen v10 saves; a keyboard-only
run; the Map offer; crash recovery mid-stage), and sections 2 and 3 also pass on the voxel renderer. The Phase 13 First Day
e2e, with its first-run opening rewritten for the new decision, passes 67 of 67. The layout audit (1280x720 and 1440x800 at
UI scale 100 and 130; 150 is not in the supported matrix) is clean for the setup panel, run map, deck drawer, offer, loadout,
stage HUD, the stage's run map, both leave-run prompts, the stage result, Run over, victory, the Map offer and the Scenario HUD.
The a11y audit is clean at 1440x800 (100 and 130 %) after the UI fixes; the layout audit was clean at 1280x720 and 1440x800 but the verifier found Park Pulse running under the help hint on the run stage HUD at 1366x768 (115/130 %) and 1536x864 (130 %), fixed afterwards by hiding the hint when a scenario/run panel is shown on layouts of 720 px or less; the 1100x690 build-dock x rotate-row overlap (Phase 26) is fixed by stacking the rotate buttons under 1360 px.
The one a11y finding was the setup panel's difficulty radiogroup, where arrow keys skipped the locked Tough option (an
aria-disabled radio should stay reachable so its reason can be read). Fixed: `ui/runSetupModel.ts` `nextDifficulty` moves
focus to every difficulty, locked ones included, and selection follows only onto an open one (`runSetupModel.test.ts`,
"arrow keys reach every difficulty and wrap"; ticked 2026-10-15). Every other run screen and the Run map focus-return
flow are clean.

*Note (2026-10-13):* the scratch scripts named above (`phase23/e2e-run.mjs` and the Phase 23 audit copies) were lost with
the container rebuild. Phase 25 rewrote a compact run e2e and the layout and a11y audits as scratch tools (the session
scratchpad's `phase25ui/`: `e2e-run.mjs`, `layout-audit.mjs`, `a11y-audit.mjs`, `probe-760.mjs`; not in the repo). Results:
the run e2e 30 of 30 checks at 1440x800 (100 %) and 30 of 30 at 1366x768 (130 %), keyboard only; the layout audit 518 of
518 state measurements clean (74 states x 7 viewport/scale cells, the Phase 23 states kept); the a11y audit 65 of 65 states
and flows clean at 1440x800, 100 % and 130 %. Reinstalling the browser tooling: `.voxel-handoff/understand/headless-browser.md`
(it names Chromium build 1243; the reinstall now gives the headless shell build 1248).

**Definition of done:** a run of the configured length can be started from the main menu, played level
by level with a consumable deck, saved and continued, won or lost, and replayed from the same seed with
the same levels and offers; lint, TypeScript, tests and build pass.

## Phase 24 — Biomes & Maps

Maps in different biomes are needed by scenarios (Phase 22) and by The Map (Phase 23), so this phase
defines them once as data. Today every park is the same 32×32 green garden with the entrance at a fixed
cell. Depends on Phase 21 for any map size other than 32×32; otherwise independent.

**Step 1 (done): the data, seven hand-authored maps, both renderers, the simulation around obstacles, the
generalised entrance, the weather mix and the Sandbox picker. Step 2 (done): the procedural generator with
its validators and seed fuzzing, pure map previews, the recipe in the save (schema 9) and the picker's Generate
choice with a seed. Of the items once listed as open (noted 2026-10-15): 64 x 64 maps exist since Phase 21 (the
Sandbox estate switch and the Room to Grow estate; The Map still generates 32 x 32, `run/plan.ts` passes no size), the
theme bonus shipped in Phase 16 (`scenery/types.ts` `themeBonus`, `previewThemeBonus`), and the previews are used by the
scenario browser and The Map (`ui/ScenarioBrowser.tsx`, `ui/RunScreen.tsx`). Still open: prop appeal (every prop kind's
`appeal` is 0, `maps/props.ts`).** The default park,
Meadow Garden, is bit-identical to before (game hashes, determinism fixtures, the First Day pacing test, classic
scene graphs and screenshots). See ARCHITECTURE.md "Biomes and maps".

- [x] (step 1) A **biome** is data: id, name, ground palette and tint (voxel materials and the classic fallback
  colours), path and fence variants that keep the candy look, decorative **props** with voxel blueprints
  (trees, rocks, cacti, palms, snow drifts, reeds, fallen logs …), a **weather mix and temperature
  bias** (desert hot and dry, winter cold with the heat effect inverted or a cold variant, tropics wet),
  default day length and a preferred time of day for the look, scenery theme affinity (Phase 16 themes),
  and guest-demand tweaks (a beach park wants drinks, a winter park wants hot food) that are small and
  declared through the ruleset. First set: **Meadow** (today's garden), **Seaside**, **Desert Canyon**,
  **Winter**, **Jungle**, **Autumn Forest**; later candidates: Volcanic, Futuristic, Night Carnival
  *(done: six biomes and 30 prop kinds. The weather mix is a column weight per kind on the existing Markov matrix
  (Meadow all 1, bit-identical), the cold effect is the heat effect generalised and declared in
  `GAME_CONFIG.weather.climate`, thirst and hunger per biome are two small ruleset keys, the look is built from
  ground and prop materials only: no `lightPresets.ts` change and no `dayLook` modifier. The theme affinity is data
  only; Phase 16 wires the bonus.)*
- [x] (step 1, except the owned area) **Map data** (versioned and validated): size, biome, entrance cell and
  facing, starting owned area (Phase 21), props and **obstacles** (blocking cells that the player may clear by
  bulldozing for a price, or never), starting objects (a path stub, a pre-built ride for scenarios), and a seed.
  Loaded through the session like scenario setup, saved in the park save (schema bump with migration)
  *(done: format version 1, ASCII rows, validator; props are a map layer owned by the world, not placed objects;
  clearing is booked as `land-clearing`; save schema 8 with a real 7 to 8 migration, old saves are the Meadow
  Garden. The owned area is a validated placeholder that is neither used nor saved until Phase 21; sizes other than
  32×32 are refused naming Phase 21.)*
- [x] (step 1: the hand-made maps) [x] (step 2: the generator) **Hand-authored maps** for scenarios (at least one per
  biome, each with a readable character and a layout that creates a decision, e.g. a river-less "canyon" corridor
  or an island of open land) and a **procedural generator** for The Map: deterministic from a seed, biome-aware
  (noise-based prop placement and clearings, a guaranteed connected buildable area of a minimum size reachable
  from the entrance, entrance placement rules), with validators and a test that fuzzes seeds per biome and fails
  on unreachable or too-small maps
  *(done: seven maps, one or two per biome, all four gate facings, each with a validator-checked reachable open
  area and cleared area; the map validator is the one the generator has to pass. Step 2: `generateMap(recipe)`, a
  pure integer-only function of (biome, seed, density, water) for 32×32, always inside the validator, the chunk
  prop caps and the voxel box budgets while placing (note: the per-chunk weight cap counts a 2×1/2×2 prop per chunk it touches while the renderer emits it whole into one chunk, so the worst measured chunk is 1,424 against the 1,400 cap, still inside the 1,650 chunk budget; pinned as an expected-fail test), with a bounded repair for the connected buildable area and
  the gate rules (no land stranded behind permanent props and water); a fuzz test over 500 seeds × 6 biomes × 3
  densities, golden hashes (3 seeds per biome plus a digest over 166 recipes where the caps and the repair bind;
  `GENERATOR_VERSION` 2) and a cross-process determinism test. Seaside Cove was refreshed after the feedback "palest and weakest" (more beach, a
  pier, tide rocks, dunes, palms, a saturated candy palette) and replaces the old map; an old save keeps its stored
  land.)*
- [x] (step 1) **Rendering**: both renderers draw biome ground, props and the biome's look; the voxel renderer
  adds the props as static chunk content through the blueprint compiler (so a prop-heavy map stays
  inside the chunk box budget; measure), the classic renderer a simple equivalent; the day/night
  and weather looks compose with every biome and the park stays colourful (check each biome in the
  weather × time grid)
  *(done: voxel ground words and props through the registry with the palette at 162 of 256 and measured box
  budgets, classic terrain per biome with pooled prop art; screenshot grids of every biome in both renderers; the
  bulldozer over a prop keeps it drawn (a voxel ghost of the prop) and a refused clear is slate, not red, in both.)*
- [x] (step 1; the theme bonus is Phase 16) **Simulation**: guests path around obstacles, the heatmaps and
  scenery appeal read the biome, the entrance is generalised (no hard-coded cell), and every hard-coded 32 is
  derived from the map (shared with Phase 21's work)
  *(done: props occupy cells and guests only walk on paths, so they go around; the entrance is a map property
  proven end to end on a north, west and east gate, and the First Day path hint names the gate's screen direction;
  the weather chain and the climate read the biome. Declared:
  props give no scenery appeal in step 1 (`appeal: 0`), and the scenery theme bonus waits for Phase 16.)*
- [x] (step 1: the hand-made maps) [x] (step 2: seed, generated maps; previews exported, used by Phase 22/23) A **map picker** in Sandbox (biome,
  hand-made or generated with a seed) and map previews for the scenario list and the run map
  *(done: New park opens a keyboard-operable picker of six biome cards with a swatch strip and the maps of the
  chosen biome, audited at 1280×720 and 1440×800 and the UI scales; Continue and Save / Load name the map and biome.
  Step 2: each biome's list ends with Generate (seed field with live validation, Reroll, density Low/Normal/High,
  the biome's water switch) and every map has a preview beside the list; Continue and Save / Load read
  `Generated · seed 1234`. The scenario list (Phase 22) now uses `mapPreviewOf` / `ui/MapPreview.tsx`; The Map
  (Phase 23) will too.)*
- [x] (step 1) [x] (step 2: generator hash and seed fuzz) Deterministic coverage: generator output hash per seed,
  validators, save/restore of props and obstacles, bulldozing an obstacle, pathfinding around props at 1,000
  guests, render fixtures per biome
  *(done: step 2 adds the golden generator hashes and corpus digest, the seed fuzz, the repair proof tests, preview hashes (every obstacle visible), the recipe
  save round trip with frozen v8 fixtures and hostile recipes, and the 1,000-guest run on the heaviest generated
  map.)*

**Open questions:** whether water appears as a decorative non-buildable tile before terrain exists
(Future Candidates list water and elevation as larger systems); the maximum prop density against the
voxel box budget; whether biomes change the catalog colours or only the surroundings.
*(Step 1 answers: water is a flush, non-buildable ground kind with no terrain height; prop density is bounded by
the map validator (320 props, 40 prop cells per 8×8 chunk) and measured in the voxel budgets; biomes change only
the surroundings, the catalog colours are untouched.)*

**Definition of done:** at least six biomes with hand-made maps and a generator, all selectable from the
Sandbox, used by scenarios and The Map, saved and restored, readable and colourful in every weather and
time of day, inside the performance budget; lint, TypeScript, tests and build pass.
*(Steps 1 and 2 meet it except the use by scenarios and The Map, which are Phases 22 and 23 (scenarios can already
declare a `mapId`, and the generator and previews are exported for them), map sizes other than 32×32 (Phase 21)
and the theme bonus (Phase 16).)*

## Phase 25 — Card Pool Expansion (consumable, roguelite)

The roguelite needs many more cards than the six shipped ones, and they should be built around the
systems the game has now. Builds on Phase 23's consumable deck; the rules from Phases 8B/17 still hold
(every card has at least one real upside **and** one real downside, tested against `MULTIPLIER_DIRECTION`;
no card is strictly better than another; no scenario or level requires a particular card).

**Built (2026-10-13), together with steps 1-5 of Phase 23's difficulty retune.** The architecture is in ARCHITECTURE.md
"Card pool (Phase 25)" and "The Map (runs)", every number is PROVISIONAL in BALANCE_NOTES.md "Phase 25". Save schema 12,
run format 2, run plan version 4.

- [x] A card model that fits consumption: **stage cards** (a ruleset modifier for the whole stage,
  consumed when the stage starts or ends — see Phase 23's decision), **one-shot cards** (an immediate
  effect when played from the run or stage: a cash injection with a later cost, instant research, a free
  repair crew, a litter sweep, a weather call), rarity tiers that change frequency and slot cost without
  adding raw power, tags for synergy, and a data-driven definition so adding a card is data plus a test
  *(done: `src/game/cards/`. The cards are rows of `PULSE_CARD_TABLE` (`table.ts`) and `PulseCardId` is derived from it.
  Stage cards are multipliers over the card-modifiable rules, used up at stage start as Phase 23 decided. One-shots take a
  loadout slot, are played from Park Pulse during a level (one undo step), act through owner methods, may schedule one
  deferred cost in the run park's `plays` ledger, and are used up when played; an unplayed one goes back to the deck when
  the level resolves (`unplayedOneShots: 'return'`). A cost still unpaid when the level ends comes off the next level's
  starting cash. Rarity (common, uncommon, rare) sets the offer weight (6 / 3 / 2), the first level an offer may hold it
  (1 / 2 / 3) and the slot cost (1 / 1 / 2), nothing else. Ten tags, each with one rule a test checks. Adding a card is a
  table row; every test reads every row. One-shots are The Map only (decision below))*
- [x] **At least 40 cards at launch**, grouped by the features that exist now:
  - *Weather*: rain and storm tolerance, sunshine and heat (drink demand, shade), forecast reading,
    a one-shot that shifts the next forecast slot, umbrella and warm-food pushes
  - *Day and night*: night opening hours, early bird arrivals, an evening glow bonus (lamps, lit
    scenery), longer or shorter days
  - *Arrivals and opening hours*: gate surges, quiet-hours savings, stay-open-late revenue
  - *Cleanliness and staff*: cleaner and mechanic training or wages, litter pressure, breakdown rates
  - *Rides and coasters*: ride cost and capacity trade-offs, coaster excitement versus reliability,
    thrill-only and family-only plays, queue length and patience
  - *Economy and pricing*: ticket and ride price levers, loans with interest, sponsorship with
    conditions, research point income versus cost
  - *Scenery and themes*: theme sets (Phase 16), appeal radius and decay, biome affinities (Phase 24)
  - *Build and tools*: construction discounts with refund penalties, a larger undo ring versus a slower
    save cadence (Phase 12 systems), demolition refunds
  - *Land* (when Phase 21 exists): parcel price levers
  *(done: 48 cards, 37 stage and 11 one-shot, 28 common, 16 uncommon, 4 rare: weather 7, day and night 6, arrivals 6,
  cleanliness and staff 7, rides and coasters 6, economy 8, scenery 4, build 4. Seven new card-modifiable rules carry
  them (weather effect, night arrivals, day length, crowd capacity, litter impact, breakdown rate, scenery appeal),
  written in a save only when not 1, so every older save and fixture is bit-identical. Not built, and why: opening
  hours (closing the gate has no upside in this simulation; night arrivals and day length carry the family), queue
  patience, ride capacity and research income (the families have enough levers; research is a one-shot), coaster
  excitement (the coaster cards price the chain lift), demolition refunds (a new saved world field for a lever nothing
  measures), undo ring versus save cadence (app settings, not park state), theme sets and biome affinities (labels only;
  no card reads them). *Land* stays deferred to Phase 21)*
- [x] Cards that interact with a biome or weather only do so through declared tags and the ruleset, so
  a card never silently does nothing in a biome (a test lists every card × biome interaction)
  *(done: `cards/interaction.ts` derives each card x biome cell from the real weather chain; an axis is dead in a biome
  only when its effect cannot happen there, which today is wet weather in the Desert Canyon (stationary wet share 0.047,
  below `deadWetShare` 0.10). `interaction.test.ts` prints the 48 x 6 table and pins the dead set (Dry Spell and Farmer's
  Almanac in the Desert Canyon, nothing else); every card is live in Meadow and in at least five biomes, tags agree with
  axes, and no card has a downside that is dead anywhere (it would be free there))*
- [x] Offer logic: weighted by rarity and level, duplicate- and dead-card-protected (do not offer
  a rain card to a desert-only run until the weather mix allows it, or explain it), deterministic from the
  run seed; a cap on how many of the same card the deck holds
  *(done: a keyed weighted draw (`run/rng.ts`, integer hashes per card id, no float maths); weight by rarity, 0 at the
  copy cap of 3, before the rarity's first level, or when the card is dead in every biome still ahead; distinct, and never
  both halves of one of the 12 opposing pairs in an offer or a starter deck (commons only). The offer explains itself
  ("Does nothing in the Desert Canyon (level 4)", "Only helps once you build a coaster", "Takes 2 slots"). A new card moves
  an old seed's offers only where its own key wins a place (tested). Plan version 3, then 4 with the retune)*
- [x] Balance: a script plays each card in a few reference parks and reports its effect size, so no
  card is dead or dominant; results go in `BALANCE_NOTES.md`
  *(done, with a caveat: `cardBalance.review.test.ts` (opt-in, `CARD_BALANCE=1`) plays every card alone in four reference
  stages x three seeds against the no-card bot. No card is DOMINANT. Velvet Ropes and Premium Pricing are flagged TRAP on
  one stage only, a Standard level-5 visitors stage that is already at 92 % with no card (both slow arrivals, which their
  copy says). **Caveat:** 14 cards show no effect the bot can measure (it never runs short of cash, never re-prices,
  researches or builds a coaster) and Chain Gang is bot-blind; their rules and effects are proven by unit tests only, not
  by play. Table and flags in BALANCE_NOTES "Phase 25")*
- [x] UI: card art/icon and plain-language upside/downside lines in the deck, offer, loadout and
  dashboard; the card list is keyboard operable and labelled (Phase 18 patterns)
  *(done: an icon per card (no art) and generated upside/downside lines; one shared `CardTile` in the offer, loadout,
  deck and used drawers, dashboard, Collection (grouped by family) and the Scenario loadout and draft; text badges
  ("One-shot", "Uncommon", "Rare · 2 slots"); the loadout counts slots by cost and a card that does not fit is
  `aria-disabled` with its reason; Park Pulse lists "Cards this level" with native "Play <card>" buttons (still focusable,
  with the reason, when not playable), played and due rows, focus moving to the next ready card or Undo; result screens
  name played and returned one-shots and any unpaid cost. Browser audits clean (Phase 23's audit note). The run loadout
  counter adds "except a one-shot you do not play, which comes back" when a one-shot is chosen. Open: the Park Pulse
  card list scrolls with no "more below" cue *(closed in Phase 35: a "more below ▾" cue)*)*
- [x] Deterministic coverage: modifier order and clamps, one-shot effects and their consumption,
  no-strictly-better test across the pool, offer determinism and protection, save/restore of the deck
  *(done: every legal loadout of cost 4 or less on every condition set stays inside the clamps; one-shot effects through a
  fake host and the real owners; the ledger's round trip and hostile laws; settlement and debt in `deck.test.ts`,
  `runSession.test.ts` and `GameApp.cards.test.ts` (play, undo, save and reload with a pending cost, crash recovery,
  abandon, failure); no dominance; offers over 2,000 seeds; schema 12 with six frozen v11 fixtures and bit-identity of
  every older fixture)*

**Decisions (defaulted by the orchestrator on 2026-10-13; open for the owner to overturn)**

- **One-shot cards are The Map only.** Scenario drafts and Scenario loadouts offer stage cards ("One-shot cards are played
  on The Map."). Making them playable in Scenario is a mode check plus `plays` in Scenario saves.
- **Unpaid deferred costs carry over.** A loan repayment or bill still pending when a level ends comes off the next
  level's starting cash (never below 0); debt left after the last level is forgiven, and the result screen says how much.
  Without the rule a fast player would never pay a late loan back: the backdrop between levels never steps.
- **Versions:** `SAVE_SCHEMA_VERSION` 12, `RUN_FORMAT_VERSION` 2, `RUN_PLAN_VERSION` 4 (3 for the pool and the keyed draw,
  4 for the retune). An in-progress run from an older plan version loads and plays but finishes unrewarded; the Continue
  card says so ("Runs started before this update finish without rewards.", from `RunSummary.planVersion`).

**Known limits**

- A finished run saved before Phase 25 and loaded again gets a new run key (the migration adds the run-format-2 keys and
  the plan key gained `unplayedOneShots`), so its result could be recorded in the profile once more.
- A Scenario or run park's fixed calendar now follows the day-length rule (720 s x the multiplier), so it is no longer
  always 720 s; the countdown reads `m:ss left` then.
- Tough is barely harder than Standard for the no-card bot, which is never short of cash: their targets are equal and
  Tough differs by +1 condition, one density step, the cash squeeze and a longer spirits hold. The playtest (Phase 23
  retune, step 6) decides whether that is hard enough for a person.
- One of 300 stages in the opt-in sweep misses its margin (Standard seed 102 level 5, 92 % against 0.90), so
  `RUN_SWEEP=1` is red on that row; the four pinned seeds in the default run pass.
- 14 cards are proven by unit tests only (bot-blind, above); Velvet Ropes and Premium Pricing are TRAP on one stage.
- A tab on an older build drops discovered card ids it does not know (the pinned profile limit of Phase 23).
- The Park Pulse card list scrolls with no "more below" cue. *(Closed in Phase 35: a "more below ▾" cue while rows hide
  below the fold.)*

**Definition of done:** the card pool has the families above (40+ cards), every card passes the
up/down and no-dominance tests, offers are deterministic and sensible per biome, and lint, TypeScript,
tests and build pass. *(Met.)*

## Phase 26 — Rotate the Whole Map (view rotation)

Players can rotate a single building today (`R`), but the camera is fixed at one corner of the isometric
view, so what stands behind a tall building is hidden (see-through helps but does not fix it). This phase
adds **rotating the whole map view in 90° steps**. Depends on nothing, but touches both renderers, input
and saves, so it should be planned as its own phase.

- [x] (step 1, done: Q/E in the registry with `yieldsDefault` so an older player binding wins, buttons + compass above the clean-view handle, `app.viewRotation` in the save's app block, not hashed and not in the undo ring, marked for autosave through `SaveManager.markAppStateChanged`; a turn is refused while a drag is held) A **view rotation** of 0/90/180/270° (a camera orientation, not a change to the world): bound to
  rebindable keys in the keybinding registry (suggested Q and E, plus two on-screen buttons next to the
  clean-view handle), part of the park's app state so it survives save and load, and applied
  immediately without touching the simulation or the determinism hash
- [x] (step 1, done: `viewRotation.ts` + `worldInput` pick through the view frame, differential fuzz over views × zooms × pointer positions, view 0 bit-identical) **Input**: `worldInput` and the shared cell ↔ screen mapping take the rotation into account so
  hover, placement, the ghost, bulldoze, path drag, the coaster designer and selection always hit the
  cell under the pointer; WASD pan follows the screen, not the world; the build rotation (`R`) keeps its
  world meaning and the ghost shows the right orientation in every view; a differential test proves
  picking in all four views against the unrotated truth
- [x] (step 2, done: a vertex-stage view transform over one world data set (`uView`, written only when the view moves), plus a re-sort of each chunk on a turn: no geometry rebuild, no shader compile; Node: 2.7 to 3 ms and 624 KiB for all 16 chunks of the dev park; headless SwiftShader: key handler 1.6 to 3 ms, one frame uploading about 610 KB with 8 extra uniform calls, steady frames identical in all four views (0 bytes, 9 uniform calls, rAF 0.6 to 0.75 ms; 2.1 ms with the guest cap); key light fixed to the screen so every view keeps view 0's contrast, cloud shadows and puddles world-anchored, rain screen space, dither anchored to view texels with an exact round trip; `no-view-rotation` rung at startup and at runtime, both driven in the browser; review fixes: queue slots keep their screen layout in every view, exact camera round trip at every zoom (turn chain), the runtime rung recentres from the view actually shown, a turn before mount is undone on a no-view-rotation GPU, and every program carrying the view code (composites of the full/full build included) is retried without it first while failures that survive that retry keep the rotation; drop tower lattice closed on its fourth face; see ARCHITECTURE.md 'Voxel renderer (Phase 26 step 2)') **Voxel renderer**: The scene mapping (world cell → voxel position and depth key) takes the
  orientation. Decide between rebuilding the static chunks for the new orientation (cost, and the
  box budget), keeping four lazily built orientations, or a vertex-stage transform that keeps one
  data set; measure. Figures, rigid ride parts, coaster trains, litter, shadows, light pools, outlines,
  the ghost and draft, the see-through cutaway, hint markers, weather overlays (cloud shadows keep
  their world anchor), badges and the day/night key light direction (the sun does not move with the view:
  face lighting must be recomputed for the rotated faces so a building lit from the left in one view is
  lit consistently in the others) all follow it; no per-frame rebuilds while the rotation is steady
- [x] **Classic renderer**: the same through its isometric projection and depth sorting. *Step 1 (done,
  classic builder):* `WorldRenderer` projects and depth-sorts through the view frame in all four views
  (terrain, paths, plots, fences, objects, guests, staff, litter, gauges and alerts, hint ring, selection,
  preview and ghost, see-through, coaster rails, supports, stations and trains through
  `classicCoaster.ts`'s view state, cloud shadows keep their world anchor); a turn re-places the kept
  scene synchronously (review fix: no display object is recreated; object containers and the gate move and
  re-sort, plots, fences, track and paths redraw in place, ride machinery is rebuilt only on a parity flip
  and then swapped, terrain is cached per view class; about 3,100 Graphics calls and 4 ms headless on the
  dev park after the first quarter turn, down from 5,655 calls and 0 of 66 containers kept); a turn waits
  for a held drag (refused with a toast while a tool gesture is down); `focusEntrance` frames the gate in
  every view; tests: four turns give the
  identical scene fingerprint, zero draw calls per steady frame in every view, picking agrees with the
  projection, and a coaster differential (view q equals the turned layout in view 0, every number); a
  headless Chromium pixel compare shows four turns give the identical frame outside the animated pixels
- [x] **Transition** (*voxel, done: instant snap: no alpha, everything a turn changes is applied synchronously before the next frame, so no frame mixes orientations and reduced motion is trivially instant; a dithered cross-fade would need two G-buffers and is not built*; *step 1, classic: done* — review fix: the new orientation is built synchronously and a pooled background-coloured veil fades 0.55 -> 0 over it in 180 ms (the earlier old-frame snapshot cross-fade showed two orientations at once and is gone); instant under reduced motion; never a mixed frame): a short rotation animation or an instant snap with a brief hold; instant under
  reduced motion. No alpha blending in the voxel renderer — use the existing dither for any cross-fade or
  a snap; no frame with mixed orientations
- [x] Models and overlays that are not symmetric (ride entrances, queue ends, station platforms, the
  entrance gate) read correctly in all four views; unreadable or mirrored art is a bug per ride and
  listed in a visual matrix of every catalog entry × four views. *Step 1, classic audit (done):* classic
  ride art lives in footprint cell space (`isoPlot.ts`), so it depends on the footprint axis only (a half
  turn changes nothing; pinned for every catalog ride) and the two long-axis builders follow
  `rotationInView`; no classic ride sprite carries handed art (no entrance, queue end or platform), the
  ride entrance is the fence gap beside a path and turns with the map, shops, facilities and scenery are
  screen-facing billboards, the gate is an upright billboard; coaster stations keep their platform on the
  far side in all four views. No mirrored or mis-anchored classic art was found. Screenshots:
  `scratchpad/phase26/shots1/` (four full views and zooms on the gate, a ride, a coaster station and a path).
  *Step 2, voxel (done for the dev park):* `phase26/shots2/` holds every dev-park model in four views
  (lighting rows for noon, dusk, night, rain, cloudy and lite; close-ups of the gate, drop tower, coaster
  station, shop, wheel and carousel; ghost valid and invalid; see-through; draft; selection, gauges and
  alerts; hint ring; running train with riders; walking guests). Data is world-fixed, so a turned view shows
  a model's real back (shop back walls, the gate's blank board); nothing is mirrored and the gate's
  lettering reads left to right in view 3. Fixed: the drop tower left its model -y lattice face bare.
  Hollowing is tested for every catalog model from the four view directions. *Catalog matrix (done 2026-10-14, headless
  Chromium, noon, weather off):* all 40 placeable entries (profile-gated and research-locked ones unlocked for the pass)
  in four views, plus build rotation 1 for the 8 non-square footprints (192 crops, 48 contact sheets in the session's
  `scratchpad/matrix/out/catalog/`): no mirrored, floating, ground-clipping or bare-faced model; shop fronts, awnings and
  doors turn with the view. Not covered: dusk and night, queues with real guests (queues are figures, not models)
- [x] (done: `viewRotation.test.ts`, the picking fuzz, `contracts/view.test.ts`, `scene/viewTurn.test.ts` (zero
  rebuilds per steady frame in all four views, incremental equals from-scratch per view), the GPU guard and
  twin tests, the classic fingerprint tests, and browser pixel round trips in both renderers) Deterministic and visual coverage: pure tests of the orientation maths and the picking
  differential, a rotation round trip (four steps return the identical frame), save/restore of the view,
  frame-cost and zero-rebuild tests in all four views, a screenshot matrix, the fxc-safe shader rules

**Open questions:** snap versus animated turn; whether the compass is shown; whether the rotation is
per park or a player setting; whether the minimap/overview (if any) rotates.

**Definition of done:** the whole map rotates in four steps in both renderers with correct picking,
lighting and art, the rotation is saved, it costs no more than a steady frame when idle, and lint,
TypeScript, tests and build pass.

## Phase 27 — Coaster Visual Realism

Coaster simulation, designer and stats already work; this phase is **visual only**. Today a track turn
is a hard 90° corner at the tile edge and the structure is simple. The goal: corners that **round off
inside their tile**, and coasters that look more like real ones. Steps 1–3 are **visual only**: gameplay
numbers (cycle time, stats, costs, ratings) must not change. The one deliberate gameplay exception is the
**lift hill choice** below, planned as its own step 4 after the visuals.

**Step 1 of 3 is done (2026-10-09): rounded corners, smooth heights, the centre line, train on the line, ghost and draft. Step 2 (2026-10-09): banking, round loops, rails, ties, supports, lift chain, brake, station and colour by type in both renderers.** Step 3 is train realism. Notes are under each item.

- [x] **Rounded corners**: a turn piece follows a quarter-circle (or a spline with a fixed radius that
  fits inside one tile, ~16 of the tile's 32 voxels in the voxel renderer) instead of an L; straight
  pieces stay straight and join the arc without a visible kink; height changes become smooth curves
  (crests and dips) rather than steps; slopes ease in and out. Pieces connect across tiles with
  matching tangents. *Done:* a turn is a quarter circle of radius 16 voxels around its tile corner and every join is
  edge midpoint to edge midpoint with exactly matching tangents (a zig-zag cannot collide); heights are a
  monotone cubic spline through the piece heights (steady slopes, zero slope at crests and dips, flat
  stations, no overshoot)
- [x] **One smooth centre line**: a pure module samples the layout into a position and tangent per
  distance, used by the track mesh, the train, the supports and the camera-independent tests, so the
  train rides exactly on the rendered rail. The train speed along the curve keeps the existing
  timing (path length for gameplay is still derived from the cells; the visual arc is a re-parametrisation
  so cycle times do not change) — a test pins that cycle times and ride stats are unchanged.
  *Done:* `src/game/coaster/centreLine.ts`; the voxel track, both trains, the ghost and the draft use it; the
  cell-progress to arc-length map is linear per segment and monotonic; golden-value test
  `gameplayInvariance.test.ts`. The supports still use the step-0 frame (taller or shorter to meet the curved
  bed), so "the supports" read the line only through the bed heights until step 2
- [x] **Banking** in turns (the cross-section tilts with curvature), loops drawn as round (not
  polygonal) loops, and drops/lifts with believable slopes. *Step 2:* a pure `roll(arc)` on the centre line
  (`centreLineRollAt`: 0 on straights, rings and the station, a raised cosine over a corner's own arc capped
  at 26°, outer rail up; the line's position and the train's timing are unchanged, pinned by a test diffing
  1,000 step-1 samples), a cross-section frame (`sampleCentreLineFrame`) both renderers build from; a loop
  ring is a true circle in the vertical plane along the tangent, rotated by the ramp's pitch so entry and
  exit tangents are continuous (the step-1 review's 27° kink is gone); believable slopes were step 1. Two
  same-sign corners in a row dip to zero banking at their shared edge (a cross-tile blend is a leftover)
- [x] **Believable structure**: two rails with ties/sleepers and a spine, lattice or tube supports with
  cross-bracing and footings that follow the terrain/ground, a lift hill with a chain, a station with a
  roof and platform detail, brake sections, and colour by coaster type; support spacing and height rules
  that read well from the fixed camera. *Step 2, both renderers from the same frame, ties and supports
  spaced by arc length (ARCHITECTURE.md "Coaster structure"):* two rails at ±3/32 tile along the rolled
  normal, ties every 4 voxels, a spine; one support bent per raised piece (none on the station, none under a
  ring) with per-leg heights so nothing clips the bed, a beam, bracing that grows with height (rung at level
  2, a diagonal per 12-voxel bay above), footings on the grass (the step-2 review found them a voxel over it: a coaster cell has no slab; the footings, level-0 bed and station platform now reach `GROUND_TOP_Z`, pinned through the real scene), legs kept out of the walkway corridors
  under level-2+ track (pushed outward, or dropped); a static chain on every climbing segment keyed by
  `line.chained[i]` (step 4 only flips that data); a brake pad and fin on the run into the station (the
  designer has no brake pieces); the station gains a gate, a dispatch light and its own rails. Colour by
  type: rails in the accent, ties in the type colour, matching spine and supports (yellow/wood, cyan/purple,
  lemon/teal). Classic (`classicCoaster.ts`, pure and tested): the same elements as strokes, drawn once per
  construction, the draft into one pooled Graphics, no per-frame churn over 10,000 frames. *Leftovers:*
  the chain does not animate (classic static dashes; the voxel transform-slot plan is written up), no
  supports under a loop ring, helix / banked S-bend pieces, the four-orientation matrix waits for Phase 26
- [x] **Train realism** (step 1 only places each car on the line, oriented along its tangent, simple boxes): cars with a clear front, wheels/bogies, lap bars and seats, couplings that
  follow the curve (each car oriented along the tangent and slightly banked), per-type train styles,
  riders visible where the budget allows
  *Step 3, done in both renderers.* Shared: one car frame for both views (`coasterCarFrame.ts`: the bogie
  chord and the banked up axis, so cars pitch, yaw and roll with the track, upside down round a loop), and one
  seat model (the type's capacity spread over its cars; riders fill front to back and show only while the ride
  runs with someone aboard, never on a parked or loading train, never counted as guests). Classic: cars with a
  nose cone, headlight and fin, hull with stripe, bogies with wheels, two seat rows with lap bars, couplings
  that follow the curve, leaned by the banking, three distinct per-type styles, one rider dot per seat, pooled
  graphics with zero drawing over 10,000 frames (`classicTrain.ts`). Voxel: rigid parts on transform slots (a
  car, its riders, two coupling half-bars per coupling: 4 · cars − 2 slots), per-type car models with a lead car
  (comet nose and star, star chaser wedge and fin, serpent head and tail), chassis and wheels, seat rows,
  lap bars or hoops; 166 / 229 / 257 boxes per train uploaded once; filling, emptying and moving rebuild no
  chunk; the designer's draft shows the parked train (see ARCHITECTURE.md 'Coaster trains').
  *Leftovers:* wheels do not spin; the classic lean is a small seat offset rather than a true 3D roll and the
  classic zoom is shallow; a partly loaded train can show up to one car's seats minus one more riders than are
  aboard (whole cars fill); the star chaser's raised arms and back-row hoop can touch the next car or a dipping
  loop ring by under two voxels (pinned by `it.fails` in `coasterTrainReview.fuzz.test.ts`); real GPU frame
  cost unmeasured.
- [x] **Voxel budget** (step 1 measured: a corner is 45 to 125 boxes, the longest allowed coaster 5,525 boxes against 2,578 before, 3 ms to build. *Step 2, the structure:* a flat corner 66 to 91, a climbing or crest corner 98 to 136, a straight ramp 59 to 84, a loop piece about 180; the dev park coaster 444 → 735, the longest 5,525 → 6,500 (6,547 with its train, 1,802 in its heaviest chunk, 5 chunks rebuilt once in about 25 ms on the software path, 5 ms of it building the pieces), three 64-piece coasters on an empty map 17,320, all written into `budgets.ts` with a test; palette unchanged at 122 of 256; the software-GPU frame cost with the longest coaster running is unchanged within noise and is not representative of a real GPU, which is still unmeasured): curved pieces compile through the blueprint compiler into greedy-meshed boxes
  within the coaster box budget (measure a long coaster with many curves against the frame budget and
  the chunk rebuild cost when a piece is added); dither only, no alpha; the classic renderer draws
  the same curves with simple polylines
- [x] **Lift hills: chain or free (step 4, done 2026-10-10: see the sub-items).** An uphill run can be built
  **with a chain lift or without**. A chained hill pulls the train up at a steady lift speed (the
  behaviour every coaster has today, so existing coasters and saves default to *chained* and keep their
  exact numbers). A **free** (unchained) uphill lets the train climb on its own momentum: it
  **slows down noticeably but not fully** — a simple deterministic energy model (speed² falls with the
  height gained, scaled by a tunable gravity factor, never below a minimum creep fraction of top speed
  so a ride cannot stop dead on a hill and the sim has no stall/rollback state), speeding up again on
  the way down. Decisions to settle: the flag is per uphill piece or per connected hill (a "lift hill"
  segment in the designer, one toggle for a run of slope pieces); how the speed profile feeds ride
  stats (top speed, excitement, intensity, cycle time), cost (a chain lift costs extra and adds a little
  wear/running cost; a free climb is cheaper, and the designer's validity check warns or refuses when a
  climb is too steep for the speed the train will have there); fixed-point or integer maths so the
  profile is bit-identical across runs. Rendering: a visible chain (a link strip between the rails) only
  on chained pieces, plus a chain-lift clank marker for the audio phase. UI: a per-hill toggle in the
  coaster designer and in the built coaster's inspector, with the speed profile shown (a small
  speed-over-distance strip). Save: the layout gains the flag (schema bump with migration: all old pieces
  become chained); the determinism hash, the gameplay-invariance golden test (kept for chained
  coasters), undo, and the Phase 25 coaster cards (excitement versus reliability) read the new model
  *Status (game and rendering done, UI pending at the time of writing):*
  - [x] Per-run flag `freeClimb` on `CoasterPiece`; every old piece chained; schema 5 with `SAVE_MIGRATIONS[3]` and frozen v4 fixtures captured before `state.ts` changed; gameplay-invariance golden and a frozen-copy equivalence test green for chained coasters.
  - [x] Fixed-point free-climb model (`speedModel.ts`) with a creep floor, no stall state; feeds cycle time, stats (small bounded bonus), cost and the designer validity check (warning, refusal past `maxCreepSegments`); ruleset field `chainLiftCostMultiplier` plumbed, no card content.
  - [x] Rendering: chain strips only on chained climbs in both renderers (data-driven via `line.chained`); open drafts keep the flag through `openDraftRing`; the voxel draft signature includes it. Tests in `coasterLift.test.ts` and `classicCoaster.test.ts`. No shader work. The chain-lift clank marker is not built (audio phase).
  - [x] Docs: ARCHITECTURE.md "Lift hills", BALANCE_NOTES.md (all constants PROVISIONAL).
  - [x] UI: per-run toggle (CoasterPanel, rebindable key L, click target on the draft), inspector speed strip and chain cost line, KEYBINDINGS.md regenerated.
  - [x] Review fixes: `centreLineFor`'s cache signature includes `freeClimb` (a closed draft toggled in place redraws its chain strip); a free run costs reliability instead of gaining it, so a free hill after a drop is no longer better than a chained one on every axis; the stall refusal counts crawling segments per climb (free runs split only by flats add up); the inspector's chain cost line uses the construction and ride operating multipliers the ledger charged with.
  - Honest notes: the free twin in the play test earns about +26 % revenue (above the +25 % target, because of the shorter cycle); the bound is +35 % and the issue is in BALANCE_NOTES.md.
- [x] **Designer ghost** and the draft preview show the rounded result so what the player designs is what
  gets built (the Phase 10 requirement), including blocked-cell warnings on the curve (an open draft is shaped as `openLayoutRing`, both renderers; step 2: the draft shows the same rails, ties, supports, chain and station as the built coaster, dithered in voxels and at 0.85 alpha in classic)
- [x] The see-through cutaway, weather, day/night lighting, outlines and contact shadows keep working on
  the new geometry; rotating the map (Phase 26) works with it. *Step 1:* the geometry is ordinary static boxes,
  so all of these apply unchanged (checked on screenshots under the software rasteriser); nothing in the centre
  line depends on screen orientation; rotation itself is untested until Phase 26 exists. *Checked 2026-10-14 (headless
  Chromium):* the dev-park coaster at noon, dusk, night and rain in views 0 and Q, close-ups and see-through: outlines,
  contact shadows under the supports, lamp pools at night, rain streaks, and a clean cutaway that restores on release
- [x] Coverage (step 1 has the centre-line, train, determinism, budget, zero-rebuild, classic no-churn and
  gameplay-invariance tests; the four-orientation visual matrix waits for Phase 26 and the structure work; the matrix is
  voxel only since the classic renderer is legacy, 2026-10-13): the centre-line sampler (continuity of position and tangent at every join, the
  length per piece), train placement on the line, determinism of the compiled coaster models, a
  visual matrix of every piece type and the three coaster types in four orientations, frame cost and
  zero-rebuild tests with the longest allowed coaster *(visual matrix done 2026-10-14: the three types built through
  the designer (32, 32 and 46 pieces) with station, chain lift, free climb, high corners, S-bend, loops at ground and at
  height and a boost, parked and with the train on each feature, in four views (`scratchpad/matrix/out/coaster/`): rails
  continuous, supports and footings on the grass, trains on the line inside loops, loop rings round in every view, chain
  strips only on chained climbs, stations whole. Findings kept as leftovers: a loop ring at height has no support of its
  own (documented: supports are never under a ring); on a tight free-climb corner neighbouring cars overlap at the inner
  edge in view 1 (arc spacing 0.62 tiles); the boost chevrons were hidden by the train and not verified)*
- [x] Colour of coaster track, supports and trains is part of Phase 28 (colour customisation; delivered in step 2: four coaster slots, per coaster)
- [ ] Possible follow-up (Future Candidates): more piece types (helices, banked S-bends, block brakes)

**Definition of done:** coasters read as smooth, believable roller coasters in both renderers, trains
ride the visible rails, no gameplay number changed, a long coaster stays inside the budget, and lint,
TypeScript, tests and build pass.

## Phase 28 — Colour Customisation

The candy palette is the look of the game, but every ride, stall and decoration has one fixed colour set
from the catalog. This phase lets players **change the colours of things** — rides first, then the rest —
so a park can have its own identity. It touches the palette, the blueprint compiler, both renderers, the
save schema, undo and the UI, so it is planned as its own phase. Builds on Phase 12 (saves) and the
voxel palette and blueprint work; it fits after Phase 26 and before Phase 24's props.

- [x] **Colour slots per model**: each catalog blueprint declares a few named slots (Main, Accent, Trim for rides;
  Train, Seats, Rails, Supports for coasters; Walls and Roof for stalls and facilities; Seat and Back, Body and Lid,
  Post and Cap, Blooms and Petals, Basin; Arch, Sign and Posts for the entrance gate) that map to its existing palette
  materials; everything not in a slot (steel, wood, glass, water, lights, ground contact) keeps its fixed material so
  the model stays readable. Slots are data in `content/colours.ts` (the slot id is also the preset role; the voxel tag
  is positional) and the classic art, with a default that reproduces today's colours exactly (golden fingerprints of
  every ride and rotation from step 1, and of every non-ride object, the three trains, the gate and every build
  preview from step 2, taken before any change). A test (`colourSlots.crosscheck.test.ts`) asserts that the voxel
  tags, the classic paint and the declared slots are the same list for every colourable definition and the gate, and
  that every slot default is a palette material. **Step 2 delivered:** 3 coasters, 8 stalls and facilities, bench, bin,
  lamp, flowers, fountain and the gate. **Left:** fences and paths (decided: not colourable in this phase, see "Which
  things"); trees and rocks stay fixed by design
- [x] **Per-object colour state**: a placed object stores its chosen colour per slot (small, validated indices into a
  curated swatch set, not free RGB, so every choice stays inside the candy look and the 256-material voxel palette
  budget). Decided: pre-baked swatch materials (21 swatches, 131 of 256, no shader change, no fallback rung) rather
  than a per-instance shader recolour; a recolour is a data change that rebuilds the object's own chunk(s) once
  (a coaster: exactly its chunk set, each once). The entrance gate is a park-level record (`world.gateColours`).
  Measurements: ARCHITECTURE.md, Colour customisation
- [x] **Curated swatches and presets**: 21 themed swatches (three rows of seven), six named presets as data mapping
  slot roles to swatches (Candy = today's defaults, Seaside, Midnight, Autumn, Meadow, Berry), applicable to one
  object (the Paint tool with a preset brush) or the whole park (one undo entry), kept readable on every ground and
  in every light by a test that renders swatch x light: a CPU twin of the voxel composite (twelve looks: day, dusk and
  night under sunny, cloudy, rain and storm, with cloud shadow and wet ground) against every ground (grass, paving,
  curb, the stone and concrete decks and the plot tint of every catalog definition), with absolute floors for
  saturation, ground distance and pairwise distance at night too, plus the classic tint; every preset passes it.
  Nine catalog colours failed it in step 1 and were retuned as swatches; the slot defaults themselves stay as they are
  (pixel-pinned). Slots on glass and lamps keep their glow behaviour (lights are never slots). **Left:** the shipped
  Sunflower, Lemon, Timber and Wood defaults and the pale stall accents still grey or vanish at night (a default may
  not change in this phase: an art question)
- [x] **Which things**: rides and their vehicles, coaster track, supports and train (per coaster, tied into Phase 27),
  stalls and facilities, the bench, bin, lamp, flowers and fountain, and the entrance gate; guests and staff keep
  their colours, trees stay fixed. **Decided: paths and fences are not colourable (leftover):** a path colour needs new
  patterned paving materials, a readability pass with guests and litter on the paving and in the cutaway, and a
  classic path redraw; a fence colour is ground contact and would rebuild every ride chunk. A lights slot (emissive
  swatch variants) is also left
- [x] **UI**: a colour section in the inspector for the selected ride, coaster, stall or facility (a row per slot with
  swatch buttons, the object itself as the live preview, a Reset); a **Paint** tool (dock button, rebindable key `C`;
  the eyedropper `I`) with a small panel (21 swatches, Main / Accent / All, six presets, "Apply to whole park"): a
  click or a drag paints the Main colour of every object under the cursor, **Shift paints every part**, a preset or a
  picked colour set paints the whole object; one undo entry per gesture; the hover outlines the target through the
  overlay seam in both renderers, in every view rotation and with the see-through; the colour on the build ghost and
  on the placed object ("the next one will be teal", a chip on the armed card and a Colour button on the armed line).
  All keyboard operable and labelled (Phase 18 patterns; painting an individual object is the documented pointer
  gesture, keyboard players have the inspector and the whole-park preset), with no overlap at the supported sizes
  and rebindable keys through the keybinding registry (`KEYBINDINGS.md` regenerated). The layout audit (the panel
  open, with a copied brush, in build mode, with the clock popover, the performance overlay and a toast, and the
  stall and coaster Colours sections) and the a11y audit (accessibility tree, DOM wiring, keyboard walk with focus
  rings, axe) are clean at 1280x720 and 1440x800 and UI scales 85 to 130
- [x] **Persistence**: colours are part of the park state (schema 6 gave a placed object its colour record, schema 7
  adds the park-level gate record and the ruleset's `recolourCostMultiplier`, each with a migration and frozen
  fixtures captured before the state shape changed), the determinism hash, the undo ring and crash recovery. Invalid
  indices fall back to the slot default instead of failing the load (decided: restore **normalises**, it never
  refuses a save for a colour; a record on a non-colourable definition is dropped). Colours are not gameplay: a
  recolour never changes ratings, appeal or any simulation number (a test hashes the simulation across recolours of
  every kind, the gate and every preset on the whole park). A recolour is one undo entry (cosmetic: it restores
  colours only, no rewound time; picks on one object coalesce; a paint gesture, a whole-park preset and a series of
  picks are each one entry)
- [x] **Cost and unlock policy (data and plumbing)**: decided: free in the Sandbox, always; in a Scenario and on The
  Map a per-object cash cost from `GAME_CONFIG.colours.recolourCostPerObject.{scenario, map}` (both **0**: free until
  Phase 22 and Phase 25 decide) times the park rule `recolourCostMultiplier` (a card-modifiable rule, lower is better),
  charged once per gesture as one transaction and refunded by its undo; placing with a colour is free; never part of
  an objective (a test asserts no objective, card or progression project references a colour)
- [ ] **Unlock content for colours (Phase 22 / Phase 25)**: profile unlocks (swatch rows, presets) and cards that
  change the colour rules are not built: Phase 22 shipped the profile with building unlocks and bonuses only (its mode
  now selects the cost table: sandbox, scenario or map, all 0), and colour unlocks wait for Phase 25; the plumbing that
  lets them act later exists (the per-mode cost table and the multiplier). *(Still open after Phase 25, 2026-10-13: no
  colour card was added, because the map recolour cost is 0, so a card on `recolourCostMultiplier` would do nothing; a
  colour card waits until a mode charges for recolours or colour unlocks exist)*
- [x] **Both renderers**: the voxel renderer through the palette path (tags at authoring time, emit-time substitution,
  flat tags for cars, the gate and the ghost, a track paint table, a coaster recolour marking exactly its chunk set),
  the classic renderer by redrawing the object's slot art once (a stall or scenery swaps its art, a coaster redraws its
  track and rebuilds its train, the gate redraws; the old art is released with its GPU contexts, nothing per frame).
  The see-through cutaway, weather and day/night compose with recoloured objects. Classic screenshots of every kind in
  the defaults, a combination and presets at noon and night are in the Phase 28 step 2 shots. **Left:** a swatch-grid
  contact sheet per catalog entry
- [x] Coverage: slot defaults equal today's art (golden fingerprints, boxes and screenshots), restore validation,
  undo of a recolour and of a paint gesture, save/load round trip, zero-rebuild frame tests with recoloured moving
  rides and a running recoloured coaster, the palette-budget test, the contrast test, presets readability, the paint
  tool's pure model (a gesture is one undo entry, the eyedropper, the Shift rule, cost and overdraw), the input-context
  and keybinding tests (including the stored-binding migration for C and I), classic no-churn, and keyboard
  operation, plus a real-UI e2e (mouse, keyboard, undo, save, reload and Continue, an old v5 and v6 save loads, paint by
  click, Shift, drag, eyedropper, a preset on the whole park, colour before placing; classic) kept with the Phase 28
  scratch scripts. Classic defaults are pinned twice: golden fingerprints and a headless screenshot diff against the
  pre-change build (step 1: the dev park; step 2: 76 screenshots of the extended park, zero differing pixels outside the
  animation noise mask). Verified by the step-2 verifier: the voxel e2e (57/57) and the voxel dev-park diff (0 px outside the noise mask) both pass.

**Step 1 delivered (rides only):** the ten flat rides can be recoloured from the inspector in both renderers,
with undo, saving and loading, and nothing changes for a player who never opens the section.

**Step 2 delivered:** the rest of the colourable things (coasters, stalls and facilities, bench, bin, lamp, flowers,
fountain, the entrance gate), six named presets for one object or the whole park, the Paint tool with its eyedropper,
Shift rule and drag (one undo entry per gesture), the colour on the build ghost and on the placed object, rebindable
keys, the cost and unlock plumbing, schema 7. **Left (honest):** paths and fences (not colourable: new patterned
materials and a readability pass, or an every-chunk rebuild), a lights slot (emissive swatch variants), the Phase 22
profile unlocks and Phase 25 cards for colours (only the data and plumbing exist, free by default), shareable
profile-level presets and custom user presets, a live preview of the recolour on the object under the hover (the hover
is an outline and a tint), painting an individual object from the keyboard (the inspector and the whole-park preset
cover it), per-car colours on a coaster, a park banner (no such object), and the shipped Sunflower, Lemon, Timber and
Wood defaults and the pale stall accents that grey or vanish at night.

**Open questions (answered):** pre-baked palette variants (chosen: 21 swatches, 131 of 256 materials, no shader
change); scenery gets slots (lamp, flowers, fountain, bench, bin), paths and fences do not; the entrance gate is
customisable (a park-level record) and there is no park banner object; colour presets are not shared between parks
(a small profile-level list stays a follow-up).

**Definition of done:** the player can recolour rides (and then the rest) from curated swatches, with a
paint tool and presets; colours persist and undo; defaults are visually identical to today; recolouring
changes no simulation number and costs no extra rebuilds for moving parts; lint, TypeScript, tests and
build pass.

## Phase 29 — Guest Life, Souvenirs & Build Filters (2026-10-15)

Owner request (2026-10-15): many more guest interactions and animations (sitting on benches, looking at decorations,
feeling sick, being sick, getting hot, getting cold, and more of the agent's own), build-menu filters (all coasters
under one tab, all family rides under another, and so on), and more shops (umbrellas, hats, balloons, and so on).
Built in one pass; schema 15, content version 5. Code: `src/game/guests/life.ts` (the shared pure rules),
`GuestSimulation` (states, decisions, needs), `GAME_CONFIG.guestLife`, the voxel figure poses and models
(`contracts/figures.ts`, `scene/figureModels.ts`, `scene/figures.ts`), `src/ui/buildFilterModel.ts`.

**Guest life (simulation).**
- [x] Three new guest states: `walkingToBench`, `resting` (sitting) and `pausing` (a short standing activity). Four new
  saved guest fields: `nausea`, `warmth`, `souvenirs` (a bitmask) and `activity` (the pause, the bench seat or a
  flourish; validated against the state on restore).
- [x] **Benches** (Ribbon Bench, two seats each, reserved when a guest heads for one): a tired guest (energy below 50,
  always below 35) walks to the nearest free seat within 12 steps, sits until rested (energy back to 90, 6–24 s, +3
  energy and +0.25 happiness a second); a park without benches makes tired guests say so ("I wish there was a bench.").
- [x] **Admiring**: on a lovely spot (scenery score 20+) a guest sometimes stops to admire the scenery, or photographs a
  landmark (appeal 30+), facing it (+2.5 happiness); near a running ride a guest sometimes stops to watch it.
- [x] **Nausea and being sick**: rides above intensity 45 unsettle a stomach (more for a guest who likes gentler rides,
  more on a full stomach); at 55 the guest stops, queasy; still at 80 after that they are sick on the path, a sick
  litter pile (3 units, a yellow puddle; nearby guests mind it twice as much and say "Eww, someone was sick here!").
  Queasy guests avoid intense rides and put off food; nausea settles at 0.6 a second.
- [x] **Warmth**: each guest's warmth drifts toward the park's ambient warmth (weather, night, biome temperature; a new
  derived `ParkConditions.ambientWarmth` and `night`). Hot guests (78+) fan themselves, grow thirstier and seek cold
  treats; cold guests (22 and below; `guestLife.warmth.cold`, the value the run margin proofs ran at) shiver and seek
  warm food and drinks; both lose a little happiness. Rain without
  an umbrella soaks guests ("I'm getting soaked!").
- [x] **Flourishes** (pose only, no timing change): cheering after a great ride, eating or drinking after a purchase,
  showing off a new souvenir. **Sulking**: giving up on a queue is a 2 s stomp before wandering off. **Waving**: new
  arrivals wave at the gate.
- [x] Park Pulse insights for the new thoughts (queasy, sick, too hot, too cold, soaked, vomit on a path, no bench,
  lost balloons, photos, watching rides).
- [x] **Master switch** `GAME_CONFIG.guestLife.enabled`: off, the game plays bit for bit as before Phase 29 (proven by
  `session/defaultIdentity.review.test.ts`, which runs with it off and keeps every pin).

**Souvenirs and shops.**
- [x] A new service kind `souvenir` and five stalls (all free from the first park): **Brolly Booth** (umbrella:
  keeps the rain chill and the soaking off; opens over the guest in the rain), **Hat Hutch** (sun hat: halves the heat),
  **Balloon Bouquet** (balloon: a mood lift, floats overhead, and sometimes slips away — "Oh no, my balloon!"),
  **Plushie Parlour** (teddy: a mood lift, hugged), **Glow Cart** (glow wand: a mood lift at night, glows). Desire
  follows the weather and the mood (umbrellas in the rain, hats in the heat, glow wands at night, balloons and plushies
  for happy guests); a guest keeps $8 back for rides and holds each keepsake once. Sales are their own finance category
  (Souvenirs, saved only once used, like Land) and drop no litter.
- [x] **Bean Barrow**, a warm drink stall (hot coffee and cocoa) for cold guests.
- [x] Kiosk ridge icons for the five keepsakes; the warm barrow shows the cup.

**Animation (voxel renderer).**
- [x] 17 new keyframe columns (22 in all): sit, hunch, vomit, jump, arms up, fan A/B, shiver A/B, point, camera,
  stomp A/B, eat, wave A/B, hold. Two-frame poses alternate on simulation time (a paused park stands still).
- [x] Seated guests are drawn on their seat of the bench, facing its front (the simulation keeps them on the path).
- [x] Five guest models carrying a souvenir (umbrella, balloon, sun hat, plush, glow wand; 10-box budget,
  `BOX_BUDGET.figureWithProp`); figures face the scenery they admire and the ride they watch. Sick piles draw a puddle.
- [ ] The classic (legacy, frozen) renderer shows none of the poses or props (it draws the guests standing).

**Build filters.**
- [x] A filter rail left of the card strip (the dock keeps its height): Rides by All / Coasters / Gentle / Family /
  Thrill (the same bands as the card tags), Treats by All / Food / Drinks / Souvenirs, Scenery by theme. Each chip shows
  its count; the choice is kept per category while switching tabs. Paths, Facilities and Comforts have no rail.

**Save and determinism.** Schema 15: migration 14 to 15 gives every saved guest the neutral values (0 / 50 / 0 /
null); the litter pile's `sick` and the management `souvenirSales` total are optional keys. The sick cells a guest
step produces are turned into litter by the session in the same tick, so they are never saved. The determinism
harness ignores the derived bench and landmark lists and the bench seat table, and drops the neutral guest-life values
from its observables. Re-pinned for the deliberate gameplay change (with notes in each file): `save/liftPersistence`,
`save/determinism` 2c, the v9–v13 fixture plays (`modes`, `runSave`, `v11`–`v13Fixtures`), the guest weather pin and
the two figure shader sources. The older "byte for byte" migration proofs run the chain to schema 14
(`save/schema14TestSupport.ts`).

**Balance.** The run margin proofs and the First Day pacing still pass; see BALANCE_NOTES "Phase 29".

**Open for the owner:** a browser playtest of the feel (how often guests pause, sit, are sick; whether souvenirs sell
enough); whether the souvenir stalls should sit behind research; a guest inspector that shows a guest's nausea, warmth
and souvenirs *(done in Phase 30, 2026-10-15: the guest inspector)*.

**Closed in Phase 32 (2026-10-15):** tests for the rules above that had none: the balloon slipping away (the bit, the
mood drop, the pause only while wandering), the balloon, plush and glow-wand mood lifts and their ceiling, watching a
running ride, hot thirst (`hotThirstFactor`), the souvenir money reserve and price limit, the shop-queue sulk, and the
sick pile's double litter penalty and "Eww" thought (`guests/GuestSimulation.phase32.test.ts`,
`operations/OperationsSimulation.phase32.test.ts`; no KNOWN GAP). The seated guest's half-tile jump onto the bench is
fixed in the renderer: sitting down and standing up now interpolate. The opt-in sweeps were re-run under guest life
(BALANCE_NOTES "Phase 32").

## Phase 30 — Guest Life Readability & Complaint Links (2026-10-15)

Owner request (2026-10-15): keep developing, and "when guests complain about long queues or expensive prices, the
player must be able to click to get to the building they complain about". The orchestrator added making Phase 29
visible: there was no guest inspector, the Park Pulse could be filled by weather and climate lines alone, raw Phase 29
status thoughts reached the Pulse, and the Overview counted only hunger, thirst and toilets. No schema bump (schema
15, content version 5); version 0.3.0. Code: `guests/life.ts` (`setThought`, `COMPLAINT_THOUGHTS`),
`GuestSimulation` (`thoughtInsights`, `guestNear`, `restingGuestOn`, `guestSnapshot`), `src/ui/ComplaintLink.tsx`,
`GuestInspector` in `src/ui/Hud.tsx`, `GameApp.focusBuilding` / `selectGuest`.

**Complaint links (the owner's feature).**
- [x] A guest record carries `thoughtObjectId`: the building the current thought complains about. Only the eight
  `COMPLAINT_THOUGHTS` keep one (a long queue, a full queue, a closed ride or service, "I'm not paying that much.",
  "I can't afford that anymore." and "That souvenir was pricey."); every thought is written through
  `setThought(guest, text, objectId)`, which clears the id for any other thought. Set where the building is known:
  joining or giving up a ride or service queue (kept through the 2 s sulk), refusing a ride or stall price at the
  entrance, at boarding or at the counter. The "too expensive" line of a guest who turned down several destinations
  names none.
- [x] Park Pulse and the dashboard's Live signals (Overview) and Repeated thoughts (Activity) show "→ Cloud Hopper"
  after a complaint line whose building still stands. Complaints are grouped per building, so a price complaint at a
  ride and one at a stall are two lines, each linking its own building. Pressing it eases the camera there, closes the
  management dashboard and opens the ride or stall inspector, with keyboard focus moved to that inspector's close
  button. One shared component (`ComplaintLink`, named "Show <name>") in all three places; a demolished building gives
  no link. End to end in `app/GameApp.phase30.review.test.ts` (ride queue, ride price, stall price).
- [x] Clicking a row of the Buildings tab goes through the same `focusBuilding`, so it closes the dashboard too
  (the Phase 11 known-open item). The advice line now reads "Select a row to centre the camera on it. Rides, stalls and
  facilities also open their inspector."

**Guest inspector.**
- [x] Click a guest (pointer tool, no ride or stall under the cell) to open a read-only inspector beside the Park
  Pulse, in the same slot as the ride and stall inspectors: "Guest #id", what they are doing ("Queueing for Cloud
  Hopper", "Resting on a bench"), their thought with the complaint link, happiness, money (dollars and cents), hunger,
  thirst, toilet, energy, nausea, warmth (hot / cold / comfortable), the rides they like (gentle, family, thrill, the
  build-card bands), the souvenirs they hold, where they are heading, how long they have been in the park, and the flags
  tired, queasy, hot, cold and soaked. A guest is found within 0.75 of a cell of their drawn figure (riders, shoppers and
  guests in a facility are not drawn and are skipped); a click on a bench picks the guest sitting on it. *(Phase 36: in
  the browser this caught only the feet; the test now also covers the figure's height, `app/guestPick.ts`.)*
- [x] Esc and the close button close it; selecting a ride or stall, the Paint tool, a session swap, or the guest
  leaving the park (within one 250 ms UI sync) closes it too. It is exclusive with the ride and stall inspectors.

**Park Pulse.**
- [x] A three-line budget instead of two (revises PA-009, see Phase 11): while any guest thought exists, opening
  hours, weather, capacity and crowd lines share at most two lines, so one thought always shows; with no thoughts
  they may use all three. The climate line left the Pulse (it stays in the clock popover). `PulseAnnouncer` reads only
  the lines on screen.
- [x] The card is no longer one big button (a link may not sit inside a button): a launcher button (title and
  stats, opens the Overview as before), the insight lines, and a small "Open management report" button.
- [x] Insight triage of the Phase 29 thoughts: status lines ("Looking for somewhere to sit.", "Time for a little sit
  down.", "Phew, that passed.") are never summarised; the five keepsake lines, the glow wand at night and the new umbrella-in-the-rain
  line read as one line, "N guests are enjoying their souvenirs."; "That souvenir was pricey." reads
  "guests found their souvenirs pricey." `thoughtInsights()` now returns five lines (was three): the Activity tab lists all five, the Overview the first
  three and the Pulse what its budget leaves.

**Other readability.**
- [x] Overview: a second chip row, Tired / Queasy / Too hot / Cold / Soaked / Resting (the first five ask for
  attention when above 0), counted at the guest simulation's own thresholds in the same guest scan
  (`OperationsSnapshot.comfort`). Operations, Park care: SICK PILES. Both are absent while `guestLife.enabled` is off.
- [x] Stall inspector: a souvenir stall is a "SOUVENIR STALL" with a "Demand now" line ("Umbrellas sell in the rain ·
  dry now", "Glow wands sell at night · selling now"), from the guests' own desire rule (`souvenirSellsNow`).
  Buildings tab: a souvenir stall row reads "Umbrellas · sell in the rain" instead of "relieves 0".
- [x] Ride inspector: every ride shows its band tag and "Excitement N · Intensity N"; above the queasy threshold
  (intensity 45) it adds "Intense: some riders feel queasy".
- [x] Toasts carry a glyph per class: "!" on an alert (red badge), ✓ otherwise (the Phase 11 known-open item).
- [x] The pause menu's Parks chooser asks the Quit question (Save and quit / Quit without saving / Cancel) when the
  park has unsaved changes, and then opens the chosen panel; the start screen's chooser never asks.
- [x] The first-autosave integrity check covers every checksummed schema (`persistJob.ts` `storedSaveProblem`), so a
  tampered older-schema autosave is no longer replaced (Phase 12 left-over item).
- [x] Changelog entry 0.3.0, "Guest life and the guest inspector", for Phases 26 to 30; `package.json` 0.3.0.

**Guest life rules.**
- [x] A need gate: a guest whose hunger, thirst or toilet need is at `guestLife.lifeNeedCeiling` or above skips every
  life activity (bench, admire, photo, watch, fan, shiver). Shipped at the leave thresholds (hunger 96, thirst 94,
  toilet 97, one shared constant), where it is a safety net only; see the decisions.
- [x] A guest walking to a bench counts as moving, so a severe crowd costs them happiness like any walker.
- [x] Souvenir thoughts: a stall sale gives the keepsake line ("Now the rain can do its worst!"); "That souvenir was
  pricey." only when the stall charges above its default price and the guest was not satisfied (below 60). "What a
  lovely souvenir!" remains only for a souvenir stall without a keepsake kind.
- [x] An umbrella holder in the rain thinks "Glad I have an umbrella." (the counterpart of soaked; it never
  replaces a complaint).
- [x] The sick-cell contract is documented on `drainSickCells` (the session drains them every tick; a standalone
  guest simulation keeps them until drained) and pinned by a test.

**Tests.** `guests/GuestSimulation.phase30.test.ts`, `save/phase30Rules.test.ts`, new cases in
`GuestSimulation.serialize.test.ts`, `ManagementSimulation.test.ts` and `OperationsSimulation.test.ts`,
`ui/phase30Markup.test.tsx`, `ui/phase30Dashboard.test.tsx`, `ui/ComplaintLink.test.tsx`, `ui/aboutModel.test.ts`,
`app/GameApp.guestInspector.test.ts`, `app/GameApp.parksChooser.test.ts`, `app/GameApp.phase30.review.test.ts`, and
Phase 30 cases in `persistJob.test.ts`, `weatherModel.test.ts`, `inputContext.test.ts` and `a11yCss.test.ts`. Whole
suite after the review fixes: 437 files passed, 3 skipped; 7,763 tests passed, 20 expected fail, 74 skipped. Typecheck,
lint and build pass; main chunk 1,401.81 kB (1,393.00 kB before the phase; the pre-existing 500 kB warning remains).

**Save and determinism.** `thoughtObjectId` is an OPTIONAL key of the saved guest, written only while not null, so a
park with no live complaint is byte-identical at schema 15 and there is no schema bump. Restore accepts it absent or
null (null) or a non-negative integer, and refuses anything else; it may name a demolished building (readers check the
world). `checkSessionConsistency` adds one law: a resting or bench-bound guest's destination, while it still stands,
must be a bench. The determinism harness drops `thoughtObjectId` while null, keeps the observed insights unsplit and
without their link (`thoughtInsights(10, false)`, text and count only), and drops `operations.comfort`; all three are
pure functions of observed fields. The guest snapshot, the comfort counts and the Pulse demand line are never saved.
Re-pinned, key only (each file has a note proving the hash with the key stripped equals the Phase 29 pin): the guest
weather pin, the v12 sandbox and scenario 600-tick plays and the v13 sandbox and scenario plays (the v13 crowded park
twice: the key, then the litter thought going through `setThought`). No pin moved for a gameplay reason;
`session/defaultIdentity.review.test.ts` (guest life off) keeps every pin, and the 282 run margin proofs pass.

**Decisions (defaulted by the orchestrator on 2026-10-15; open for the owner to overturn)**

- **The need gate sits at the leave thresholds, not at 72.** The design's 72 (the "urgent unmet need" level) moved
  The Map seed 4 L5 "visitors" (Standard with no cards, and the Tough deck) to exactly 90 % of its time limit, failing
  two margin proofs; the contract said not to retune. At 96 / 94 / 97 the gate cannot fire in a running session
  (`shouldLeave` runs first), so the rule exists but changes nothing. BALANCE_NOTES "Phase 30".
- **Complaint links group per building** in the Pulse and the dashboard; a building named by one guest only does
  not show (the two-guest minimum of every insight).
- **The pricey-souvenir line is a price complaint**: it carries the stall and counts in the value factor's price
  complaints.
- **A guest is picked within 0.75 of a cell** of their figure, lower id on a tie; a bench sitter by the bench.
- **The Pulse keeps two report controls** (the launcher and the small button, same effect), so the card stays one
  click target as before.
- **Old raw thoughts stay raw** ("My feet need a rest.", "That ride is closed."): summarising them would move the
  guest-life-off pins.
- **The dashboard link is an underlined amber text link** (the dashboard is light); the Pulse link is a mint pill.

**Open for the owner:** a browser playtest of the links, the guest inspector and the three-line Pulse *(checked in
headless Chromium in Phase 36, at 1280x800 and 1100x690: the links work from the Pulse, Live signals and Repeated
thoughts; two fixes: a click on a guest's body now picks them, and the link frames the building beside its inspector;
the feel is still the owner's)*; whether to
retune the need gate to 72 (set `lifeNeedCeiling` to `{ hunger: 72, thirst: 72, toiletNeed: 72 }` and rerun
`run/winnability.*`); whether a complaint named by one guest should show; a hover highlight of the selected guest
(there is none; the inspector names the guest only); the classic renderer still shows no Phase 29 poses or props.

## Phase 31 — Autosave Generations (2026-10-15)

The Phase 12 step 2 leftover: with one autosave generation, one bad autosave write could cost the whole park. There
are now two rolling generations, `autosave` and `autosave-previous`. No save schema change, no simulation change and
no IndexedDB version bump (the new slot is a new key in the same two object stores); no determinism pin moved. It
builds on Phase 30's integrity check (`storedSaveProblem`) without changing it. Code: `src/app/saves`
(`autosaveGenerations.ts`, `constants.ts`, `types.ts`, `memorySaveStore.ts`, `idbSaveStore.ts`, `persistJob.ts`,
`SaveManager.ts`, `recoveryController.ts`, `recoveryMonitor.ts`, `recoveryTypes.ts`), `app/runSlots.ts`,
`GameApp.ts` (start-screen preview), `ui/menuModel.ts`, `ui/saveLoadModel.ts`, `ui/SaveLoadDialog.tsx`,
`ui/recoveryModel.ts`.

**Slot model.**
- [x] A new slot id `autosave-previous` (`AUTOSAVE_PREVIOUS_SLOT_ID`; `AutosaveSlotId` in the closed `SaveSlotId`
  union), kind `auto`. Which generation a row is follows from its id (`autosaveGeneration`), so nothing new is stored
  in the metadata; the UI says "Previous autosave" (`PREVIOUS_AUTOSAVE_LABEL`). Every user of the id union was checked:
  the store's `isSaveSlotId`, list order (autosave, previous autosave, manual slots), `metaForMove`, the manager's sort,
  the dialog rows, Continue, the run slots and recovery.
- [x] An older build lists the new record as an unreadable orphan (`Unknown slot "autosave-previous".`) with Delete
  as its only action; it never loads or overwrites it. Documented in `types.ts` and ARCHITECTURE.md.

**Store rotation.**
- [x] `StoreWriteOptions.rotateTo`: in the SAME read-write transaction as the write, the record the slot holds (meta and
  payload, re-keyed, the target's revision advanced) replaces whatever the target holds, then the new record is put.
  The quarantine's `move` was not reused, because it requires a free target and the previous slot is never free; the
  rotation shares `metaForMove` and `asSaveRecord` with it instead. The rules are pure and shared by both stores
  (`planRotation`, `rotatedRecord` in `memorySaveStore.ts`).
- [x] Nothing rotates out of an empty slot, or out of a record the store calls unreadable (damaged meta, missing
  payload, unreadable status, newer schema): such a write only got through with `replaceUnreadable`.
- [x] A failed write leaves both generations intact: proved for both stores in the contract suite (a refused
  write, a payload that cannot be cloned) and for IndexedDB with the fake's new fault `quota-on-put` with
  `afterWrites` (the LAST put fails after the two rotation puts landed), a quota error on commit and an abort half-way.

**Writer.**
- [x] Every autosave write rotates: `persistJob.ts` `writeOptionsFor` adds `rotateTo` for the autosave slot, so the
  save worker and the idle writer (both call `persistSealedJob`) rotate. Manual slots are unchanged. A job for the
  previous slot is refused (read-only).
- [x] The rule (`mustVerifyBeforeWrite`): a record is rotated only when it is known good. Either the write expects
  a revision and is not the first autosave of the page session (the store then refuses unless the slot still holds
  what this tab wrote or loaded), or the record passes `storedSaveProblem` first: the first autosave of a session
  (`verifyExisting`) and any autosave write that expects nothing. A record that fails is refused with
  `unreadable-slot` before anything is written; the manager marks it unreadable and quarantines it to a free manual
  slot as before, and the save that follows finds the autosave slot empty, so nothing rotates and the good previous
  generation stays. The manager sets `verifyExisting` for those cases.
- [x] After an autosave lands the manager updates the previous row by the same rule (`noteRotation`), without a
  re-read; a test pins that its list equals the store's.

**Readers.**
- [x] One shared helper, `autosaveGenerations.ts`: `resumableAutosave` (the current generation when it is readable,
  else the previous one when it is readable, never the previous one beside a readable current one whatever the
  clocks say) and `continuableSlots` (the readable slots with at most that one generation). `menuModel.readableSlots`
  is `continuableSlots`, so `latestSave`, `slotsNewestFirst`, Continue, the mode resume offers and GameApp's
  `menuContinue` use it; `latestRunSlot` and `autosavedRunAtStake` (either generation, the current one first) use it.
- [x] The start screen's preview re-reads its candidates after each failed try, so an autosave that fails to build
  hands over to its previous generation, and Continue plays exactly that park (state hash equals the stored one).
- [x] Crash recovery: the controller hands both generation rows to the monitor; `decideRecovery` offers the previous
  generation when the current one is unreadable or was quarantined AND the interrupted tab wrote it
  (`RecoveryOffer.autosave.slotId`). Resume loads that slot and checks that slot's revision; "Not now" keeps that slot
  (`keepAutosaveAsRecovered(revision, slotId)`). The prompt says "The last autosave could not be read, but the one
  before it was saved 5 min ago." and names it "Previous autosave".
- [x] The previous generation is read-only: `saveToSlot` refuses it (not a manual slot), quick save never targets
  it, `rename` refuses it, and deleting it is refused as busy while an autosave (which rotates into it) is in flight.

**UI.**
- [x] Save / Load lists a "Previous autosave" row right after the autosave, only when one exists, tagged PREV, with
  its mode, place, park time and "saved 10 min ago" time; Load and Delete only. The delete question of the autosave
  says "Delete Autosave and the previous autosave? This cannot be undone." Continue's subtitle reads "… · Previous
  autosave · 10 min ago" when it stands in.

**Tests.** New `saves/autosaveGenerations.test.ts`; Phase 31 cases in `saveStore.contract.store.test.ts` (both
stores), `idbSaveStore.store.test.ts`, `persistJob.test.ts`, `SaveManager.manager.test.ts`,
`recoveryMonitor.recovery.test.ts`, `recoveryController.recovery.test.ts`, `GameApp.menu.test.ts`,
`ui/saveLoadModel.test.ts`, `ui/menuModel.test.ts`, `ui/menuModel.run.test.ts` and `ui/recoveryModel.test.ts`; the
fake IndexedDB gained `quota-on-put` `afterWrites`. Whole suite: 438 files passed, 3 skipped; 7,820 tests passed, 20
expected fail, 74 skipped. Typecheck, lint and build pass; main chunk 1,405.35 kB (1,402.12 kB before the phase), save
worker 46.25 kB (45.43 kB before); the pre-existing 500 kB warning remains.

**Decisions (defaulted by the orchestrator on 2026-10-15; open for the owner to overturn)**

- **Two generations, not more.** One previous generation is enough to survive one bad write; more would be a
  constant (`AUTOSAVE_SLOT_IDS`) plus a slot id each.
- **Deleting the autosave deletes both generations**, previous first, because a player who deletes it wants that park
  gone and Continue would otherwise bring back an older copy of it. **Except an unreadable autosave**: then only the
  damaged record goes and the previous generation stays as the fallback. Deleting the previous generation deletes
  only it (`slotsToDelete`).
- **Trust a revision-checked record without re-hashing it.** Rotating does not re-verify this tab's own write on
  every autosave (that would cost a payload read and a 30 ms hash per autosave, on the main thread in the idle
  writer); the revision check proves the record is the one this tab sealed. The first autosave of a session and any
  write without an expectation are verified.
- **The rolling slot is not protected like other unreadable slots.** A rotation replaces whatever
  `autosave-previous` holds, even a record flagged unreadable: it only ever holds an older copy of the park the
  current autosave has moved past, and the damage was already shown on its row.
- **The previous generation is read-only**: no save, no quick save, no rename. Its name is the autosave name it
  carried (a renamed autosave keeps its name in both generations).
- **Recovery offers the previous generation only when the interrupted tab wrote it**, and never while the current
  one is readable (a current autosave of another live tab is not "your interrupted park", and neither is the
  interrupted park's older copy behind it).

**Open for the owner:** the deletion policy above; whether more than one previous generation is wanted; a real-browser
run of the rotation against IndexedDB in headless Chromium (the fake IndexedDB and the memory store prove it here;
the Phase 12 browser harness was not rerun) *(done in Phase 36: real IndexedDB, three autosaves, two rotations, the
"Previous autosave" row, then a reload and Continue)*; whether the rolling slot should quarantine an unreadable previous
generation instead of replacing it.

## Phase 32 — Re-measure & Phase 29 Close-out (2026-10-15)

This phase measures the game and closes test gaps; it retunes nothing. The opt-in sweeps were last recorded after Phase
14, before Phases 21, 29 and 30. Phase 29 shipped several guest-life rules with no test of their own, and a seated
guest jumped half a tile onto the bench. No save schema change, no content version change and no simulation change, so
no determinism pin moved. Code: `src/rendering/voxel/scene/figures.ts` (renderer only). Tests:
`guests/GuestSimulation.phase32.test.ts`, `operations/OperationsSimulation.phase32.test.ts` and a new case in
`rendering/voxel/scene/figures.test.ts`.

**Re-measure (BALANCE_NOTES "Phase 32").**
- [x] `RUN_SWEEP=1` (300 stages): the same two rows miss as before, and both miss by more. Standard seed 102 L5 (Seaside,
  visitors) is at 95 % (was 93 %) and Standard seed 106 L5 at 93 % (was 91 %), against 0.90. No new row misses. Medians
  moved by at most 1 point. The largest moves are on the two Seaside level-5 visitors stages (+2 at Standard and Tough,
  +5 and +6 at Relaxed).
- [x] `CARD_BALANCE=1` (588 card stages): no DOMINANT; the same two TRAPs on the same stage (Velvet Ropes and Premium
  Pricing, C3 seed 102). There are 13 DEAD in the bot (was 12), and seven cards changed flag on the 2-point edge. Season
  Ticket no longer slows the spirits cell (C2): it was +35.8 to +38.8 points on two seeds and is now 0 on all three.
- [x] `STRATEGY_SWEEP=1`: 54 of 54 parks are healthy (was 51 of 51). The sweep now includes Meadow Estate, the eighth
  shipped map (Phase 21). Strategy means moved by at most about 4 %.
- [x] Nothing retuned; every finding is listed in BALANCE_NOTES as open for the owner.

**Phase 29 close-out: tests for the untested rules** (`guests/GuestSimulation.phase32.test.ts`, 12 tests).
- [x] A balloon slips away. The test checks that only the balloon bit is cleared and that happiness drops by
  `balloonLossHappiness` after the same tick's keepsake lift. A wandering guest stops mid-route for the
  `balloonLost` pause and then decides afresh. A guest walking to a ride or queueing loses the balloon and thinks the
  line, but does not stop. A rider keeps the balloon. The chance is `balloonLossPerSecond` per second, checked just
  above and just below the draw.
- [x] The keepsake mood lifts: balloon, plush, and a glow wand at night (not by day), each at its configured rate and
  additive. The lift stops at `souvenir.maximumHappiness` and never pulls a happier guest down.
- [x] Watching a ride: a guest stops only for a *running* ride, only within `watchRideDistance` (Chebyshev, from the
  footprint; 3 watches, 4 does not), and only below `watchRideChance`. The guest faces the ride (`destinationObjectId`)
  and carries on after the pause.
- [x] Hot thirst: from warmth `hot` (78) on, thirst grows `hotThirstFactor` (1.25) times as fast; at 77.99 it does not.
- [x] The souvenir money reserve and price limit. A guest buys only with the price plus `reserve` ($8) in hand, not a
  cent less. The most they pay is `fairPrice x (minimumPriceShare + desire / desirePerShare)`, which they carry to the
  counter as `servicePriceLimit`. Nobody buys a keepsake they already hold. In play, a guest short of the reserve never
  heads for the stall, while one with money to spare does.
- [x] The shop-queue sulk: giving up on a stall queue costs 5 happiness and takes the guest out of the queue. The
  guest then stomps for the `sulk` pause and wanders on, still complaining about the stall (`thoughtObjectId`).
- [x] The sick pile (`operations/OperationsSimulation.phase32.test.ts`, 4 tests). It costs `sickLitterFactor` (2)
  times the plain litter penalty, across the litter radius. The cap applies first and is then doubled, so a sick pile
  can cost up to 4 an interval. A walker says "Eww, someone was sick here!" at once (plain litter waits for the comment
  interval), and the line clears a complaint link. A queueing guest minds the pile silently; a rider or a shopper is
  not touched. Sickness off the path marks the pile it lands on.
- [x] No test exposed a bug, so there is no KNOWN GAP and no gameplay change.

**Cosmetic (renderer only).**
- [x] A guest sitting down no longer jumps half a tile onto the bench. `seat()` in `scene/figures.ts` overwrote both the
  previous and the current history, so the first seated frame snapped to the seat. Now the seat is computed first
  (`seatOf`) and passed to `track` as the guest's position. Sitting down interpolates from the path to the seat over one
  step, and standing up interpolates from the seat back to the path (the seat is under the 2-cell snap distance). A new
  figure, a skipped step or a guest who reappears still snaps, as before. The test "sits down and stands up smoothly"
  fails on the old code (5 voxels off on the first seated frame) and passes now.

**Tests and gates.** Whole suite: 440 files passed, 3 skipped; 7,837 tests passed, 20 expected fail, 74 skipped (199 s). Typecheck, lint and build pass; main chunk 1,405.35 kB (the pre-existing 500 kB warning remains).

**Open for the owner:** whether to retune Standard level 5, since the two known misses grew to 95 % and 93 % (the Phase
25 and Phase 16 decision not to retune still stands). Why the Seaside level-5 visitors stages slowed by 2 to 6 points
under guest life (not measured). Season Ticket's lost spirits penalty. The noisy DEAD flag. The float formatting slip
in the card summary (`0.15000000000000002`).

## Phase 33 — Readability Pass 2 (2026-10-15)

A player-facing readability pass after Phase 30. It changes no simulation rule, no save field and no determinism pin:
every item is UI text, layout or a UI store field. No schema bump (schema 15, content version 5); version 0.3.1. Code:
`src/ui/hudLockModel.ts` (`researchRequirementLine`), new `src/ui/landModel.ts` (`describeLand`),
`src/ui/weatherModel.ts` (`weatherGuestLines`), `src/ui/modeLabels.ts` (`parkTitleOf`), `UiState.parkTitle`,
`GameApp.modeUi` / `syncUi`, `Hud.tsx` (BuildDock, TopBar, ClockChip), `ManagementDashboard.tsx` (OverviewTab).

**Locked build cards state their exact requirements.**
- [x] A research-locked card keeps "Requires Spin Studies" and adds a second line with the project's own terms from
  the progression snapshot: the effective RP cost, the cash, every prerequisite study and every milestone, met or not
  ("300 RP · $300", "950 RP · $1,100 · after Vertical Motion · rating 60"; an experience milestone reads "100
  experiences"). The card's title carries the same line. The research card still marks which are missing.
- [x] The line may wrap to two lines; the description of a research-locked card gives up its second line for it
  (`.needs-research`), so the card grows by at most one small line. GAME_DESIGN's "still outstanding" line is updated.

**Land in the Overview.**
- [x] An estate's Overview has a fifth KPI, LAND: "12 / 64 parcels" and "from $1,230" *(Phase 36: label LAND PARCELS,
  figure "12 / 64", because the five-column row cut the old figure)* ("all owned" or "none for
  sale" when no parcel is for sale), shown only while `UiState.land` is non-null. The Land button's tooltip and the KPI
  both read `describeLand`, the same `LandUi` figures.

**Weather lines teach the Phase 29 effects.**
- [x] The clock popover lists, under the forecast and the climate line, what the weather and the night do to guests
  right now, and the weather chip's tooltip repeats it after the forecast: "Rain: guests without an umbrella get soaked
  and unhappy; umbrellas sell." (the biome's word: Sleet, Storm, Blizzard), "Hot: guests get hot and thirsty; sun hats
  and cold drinks sell.", "Night: guests get cold; warm drinks and glow wands sell." Rain and night are read from the
  existing `WeatherUi.sellingSouvenirs` (the guests' own `souvenirSellsNow` rule), so no night flag was added. Nothing
  shows with guest life off.
- [x] The Park Pulse keeps one weather line (the three-line budget): only the heat line changed, to "cold drinks and
  sun hats sell best" (80 characters, inside the 90 limit) while guest life is on.

**The Shops tab.**
- [x] The 'Treats' build tab is now 'Shops' (it holds food, drinks, umbrellas, hats and plushies); its filter rail is
  "Filter shops". Every player-facing 'Treats' in `src` was updated: the First Day card shows "From Shops, place a
  Picnic Pocket…" and "…beside the path, from Shops." (see the decisions), and the 0.3.0 changelog line; comments in `unlockCopy.ts` and
  `buildFilterModel.ts`, test names in `buildFilterModel.test.ts` and GAME_DESIGN's filter line. KEYBINDINGS.md never
  named the tab. "cold treats" (the food word) is unchanged.

**Park name in the top bar.**
- [x] Verified: the brand's subtitle was a fixed "Garden Gate" in every park. It now names the park on screen
  (`parkTitleOf`): a Scenario's name ("Sunny Start"), a Map level's ("Level 3 · Seaside"), or in a Sandbox the map's
  ("Meadow Garden", "Meadow Estate", a generated map's name). Published with the mode at a session swap and by
  `syncUi`; a long name ellipsises at 190 px, its title has the whole name.

**Changelog.** [x] 0.3.1, "Safer autosaves and clearer cards", for Phases 31 to 33; `package.json` 0.3.1.

**Tests.** New `ui/landModel.test.ts` and `ui/phase33Markup.test.tsx`; Phase 33 cases in `ui/hudLockModel.test.ts`, `ui/firstDayModel.test.ts`,
`ui/weatherModel.test.ts`, `ui/aboutModel.test.ts` and `app/GameApp.modes.test.ts`. Whole suite: 442 files passed, 3 skipped;
7,860 tests passed, 20 expected fail, 74 skipped (202 s). Typecheck, lint and build pass; main chunk 1,408.29 kB
(1,405.35 kB before the phase; the pre-existing 500 kB warning remains). No determinism pin moved.

**Decisions (defaulted by the orchestrator on 2026-10-15; open for the owner to overturn)**

- **'Treats' is renamed 'Shops'.** The tab holds souvenir stalls since Phase 29; "Shops" is the catalog's own
  category id. The ◒ glyph stays.
- **The First Day step text in `game/onboarding/content.ts` keeps "Treats"; the card shows "Shops".** Editing the
  content moved every determinism observable hash (`liftPersistence.review.test.ts`, 7 fixtures, and
  `defaultIdentity.review.test.ts`), because the hint text is an observable. The UI maps the tab name instead
  (`dockTabWording` in `firstDayModel.ts`, a whole-word "Treats" only, so "cold treats" stays). Renaming the content
  needs a key-only re-pin of those fixtures; left for the owner.
- **The requirement line names every requirement, met or not**, as the project's terms; the research card is where
  met and missing are marked. A milestone reads as its target ("rating 60"), not its name ("Rising Reputation").
- **The guest-life weather lines stay out of the Pulse**: the rain line already fills the 90-character Pulse line, so
  only the heat line gained "sun hats". The full lines are in the clock popover and the weather chip's tooltip.
- **The night line is read from `sellingSouvenirs`** (glow wands sell exactly at night), not from a new flag.
- **The Sandbox title is the map's name**, not "Sandbox park" (the save metadata's name); a renamed save slot does not
  rename the park on screen.
- **Land KPI shows "none for sale"** when parcels are left but none is for sale now.

**Open for the owner:** a browser check of the build dock height with a two-line requirement on a late research card
(the static markup is pinned, the layout was not measured; no browser was available), of the five-KPI Overview row
at 820 px and wider, and of the top-bar subtitle with the longest scenario names *(measured in Phase 36: the
requirement line adds 8 to 10 px, and the dock was already past its 204 px anchor in Scenery, so the anchors moved;
"12 / 64 parcels" was cut to "12 / 64 p…", so the label now says LAND PARCELS; the subtitle ellipsises at 190 px)*; whether the requirement line should
mark met requirements; whether the Shops rename should also rename the "◒" glyph; whether to rename the First Day content itself (a re-pin).

## Phase 34 — Bundle Budget & Load Split (2026-10-15)

The main chunk had grown with no guard: 748.6 kB at the voxel measurement, 866.7 kB (251.7 kB gzip) after Phase 12 and
1,408 kB (422 kB gzip) before this phase, and Vite warned about it. This phase measures what the initial load is made
of, splits off what can be split without a behaviour change, and adds a budget. No simulation rule, save field, schema
(15) or content version (5) changed, and no determinism pin moved: the migration code moved between modules verbatim.

**Measured (before).** Bytes per source module, summed from a sourcemap build into the scratchpad (minified bytes;
the initial load is the entry chunk plus the chunks it imports statically: 8 files, 1,752 kB, 523 kB gzip):
pixi.js 252 kB in the entry plus about 240 kB in the statically imported Pixi chunks (`Geometry`, `RenderTargetSystem`
and smaller); react-dom 179 kB; `GameApp.ts` 86 kB; the save plumbing in `app/saves` 57 kB; `Hud.tsx` 54 kB;
`WorldRenderer.ts` 40 kB plus about 45 kB of classic art (`rideArt`, `classicPropArt`, `classicCoaster`,
`classicWeather` and others); `ManagementDashboard.tsx` 36 kB; the session 34 kB; the content catalogs and maps about
60 kB; the migration chain and envelope checks about 9 kB (`version.ts`), with `consistency.ts` 7 kB.

- [x] **Classic renderer and Pixi.** `GameApp.mountClassicRenderer` imports `rendering/WorldRenderer` with `import()`,
  like the voxel renderer; the feedback report reads `renderer.kind` instead of `instanceof WorldRenderer`. Nothing else
  in the entry imported Pixi, so pixi.js left the initial load entirely: it now arrives with whichever renderer mounts.
  The fallback paths are unchanged (same order, same toasts); the fallback now downloads the classic chunk when it
  needs it. `GameApp.classic.test.ts` and the lifecycle tests pass unchanged; the mirror check is new
  (`GameApp.voxelOnly.test.ts`: a voxel game never evaluates the classic module), and both directions are also
  checked in the static import graph.
- [x] **Save migration and validation.** The chain (`SAVE_MIGRATIONS`, `migrateSave`, `assertMigrationChain`,
  `readSchemaVersion`, `parseSaveText` and the envelope checks) moved verbatim from `save/version.ts` to
  `save/migrate.ts`, and `ParkSession.fromSave` became `sessionFromSave` in `session/fromSave.ts`. Only
  `app/saves/loadSave.ts`, already behind `import()`, imports it, so the chain is in the `loadSave` chunk (1.0 kB before,
  10.2 kB now). Nothing became async: the load path was already a dynamic import, so `SaveManager` and `GameApp` are
  unchanged. Tests now import `migrateSave` and friends from `./migrate` and call `sessionFromSave` (import lines only).
  The per-owner restore validation and `consistency.ts` stay in the entry: snapshot undo restores through
  `ParkSession.fromState`, synchronously.
- [x] **Rarely opened panels.** Settings (with the Keyboard section and its CSS), Save / Load and the Paint panel are
  lazy chunks (15 kB, 11 kB and 6 kB). `src/ui/lazyPanels.tsx` keeps their open checks in the entry; the bodies load on
  first open (`SettingsDialogBody`, `SaveLoadDialogBody`, `PaintPanelView`; `SaveLoadButton` moved to its own module so
  the HUD does not pull the dialog in). Nothing is drawn while a body loads; the dialog's input context is already
  active, so the game ignores keys as before. A chunk that cannot be fetched is caught by an error boundary that closes
  the panel and shows "This panel could not be loaded. Check your connection and try again."; the next open retries.
- [x] **Not split, with the reason.** The start menu's panels (New park, The Map setup, Scenarios, Collection, About and
  the feedback form, about 35 kB together): the menu moves focus to the panel's heading in the same commit as the panel
  opens, which a lazy body would miss, and New park and The Map are on the first-session path. The Management dashboard
  (36 kB) and the Map run screens (16 kB): opened in most sessions. The HUD, the simulation and the save store and
  autosave: needed at boot (the park runs behind the start screen). React: needed at boot.
- [x] **Budget.** `build.chunkSizeWarningLimit` is 1,025 kB (the entry plus about 5 %), so the build no longer warns and
  will warn again when the entry grows. `src/app/bundleBudget.test.ts` builds in memory with the real vite.config.ts
  and fails when the entry passes **301,700 B gzip** or the initial load **363,300 B gzip** (measured 287,239 B and
  345,911 B with `CompressionStream`, plus 5 %). It is opt-in (`BUNDLE_BUDGET=1 yarn -s test
  src/app/bundleBudget.test.ts`, about 8 s): a production build inside the default run would compete with the whole
  suite for the CPU. Its measuring helpers run every time. `src/app/bundleSplit.static.test.ts` (always on) pins which
  modules the entry may not reach statically.

| Chunk (raw / gzip, kB) | Before | After |
|---|---|---|
| Entry `index-*.js` | 1,408.3 / 422.3 | 976.4 / 289.6 |
| Initial load (entry + static imports) | 1,752 / 523 (8 files) | 1,148 / 346 (10 files) |
| `GuestSimulation` (shared, initial) | 144.3 / 45.9 | gone (now in the entry and `parse`) |
| `parse` (shared maps and content, initial) | — | 77.3 / 25.5 |
| `effects` (shared cards and scenarios, initial) | — | 39.2 / 12.3 |
| `jsx-runtime` (shared React, initial) | — | 30.9 / 11.8 |
| `VoxelRenderer` (lazy) | 314.3 / 104.7 | 314.4 / 104.7 |
| `worldInput` (Pixi + shared rendering, lazy) | — (in the entry) | 248.8 / 74.9 |
| `WorldRenderer` (classic, lazy) | — (in the entry) | 122.4 / 39.2 |
| `Geometry` (Pixi) | 104.3 / 31.9, initial | 103.6 / 31.6, lazy |
| `RenderTargetSystem` (Pixi) | 76.7 / 21.9, initial | 76.7 / 21.8, lazy |
| `browserAll` (Pixi, lazy) | 42.7 / 11.2 | 42.7 / 11.2 |
| `saveWorker` (worker bundle) | 46.3 | 45.9 |

Vite's own gzip column; the initial-load totals use the test's measurement (the same within 1 %). A voxel game still
downloads Pixi before the world appears, now after the entry has run, so the total bytes to the first world frame are
about the same (the UI and the boot screen can run sooner); a game that never opens Settings, Save / Load or Paint and
never loads a save skips about 30 kB, and every classic-only byte is skipped by every voxel game.

**Tests.** New `app/bundleSplit.static.test.ts` (18), `app/bundleBudget.test.ts` (2, plus 1 opt-in),
`app/GameApp.voxelOnly.test.ts` (1), `ui/lazyPanels.test.tsx` (5). Updated for the move (paths only):
`entranceLiteral.review.test.ts` and `content/colourNoRequirement.test.ts` now name `save/migrate.ts`. Whole suite: 446 files
passed, 3 skipped; 7,886 tests passed, 20 expected fail, 75 skipped (217 s). `BUNDLE_BUDGET=1`: 3 passed. Typecheck,
lint and build pass, and the build no longer warns about chunk size.

**Decisions (defaulted by the orchestrator on 2026-10-15; open for the owner to overturn)**

- **The budget counts gzip, of both the entry and the initial load.** The entry alone can shrink while the first
  download does not (rolldown moves shared code into common chunks the entry imports), so the initial load is the
  number that matters to a player; the entry is what Vite warns about.
- **The budget test is opt-in** (`BUNDLE_BUDGET=1`), and the always-on guard is the static import-graph test plus the
  build's own warning limit.
- **`fromSave` stays synchronous** and moved to its own module instead of becoming async through `ParkSession` and
  `SaveManager`: the load path was already behind `import()`, so the split needed no async change.
- **A panel chunk that fails to load closes the panel with an alert toast**; the next open retries.
- **The menu panels, the Management dashboard and the Map screens stay in the entry** (above).

**Open for the owner:** real-browser first-load timing (time to the boot screen, to the start menu and to the first
world frame, on a throttled connection and a slow CPU) before and after; whether the first open of Settings, Save /
Load or Paint feels delayed on a slow connection (prefetching them when the browser is idle is a small follow-up)
*(the prefetch is done in Phase 35, and Phase 36 saw it fetch the three chunks in the production build; the
slow-connection check is still the owner's)*;
whether to make the budget test part of the default run or CI; whether to split the menu panels with a focus hand-off.

## Phase 35 — Friction Pass (2026-10-15)

Small player-facing fixes that earlier phases left open. No simulation rule, save field, schema (15) or content version
(5) changed, and no determinism pin moved; the settings blob gained no field (two key actions only, which the existing
sparse `keybindings` overrides already cover). Version 0.3.2. Code: `src/settings/keybindings.ts` (`toggleCrowdHeatmap`,
`toggleMute`, the Sound group), new `src/settings/muteToggle.ts`, `GameApp` (`toggleMute`, `firstFrame`, two shortcut
cases), `src/ui/lazyPanels.tsx` (`prefetchLazyPanels`), `src/ui/App.tsx`, `src/ui/ScenarioHud.tsx` (`hasMoreBelow`,
`MoreBelowCue`), `UtilityBar` in `Hud.tsx`.

**Keys.**
- [x] **Mute key (Phase 15 open line).** `toggleMute`, default M, group Sound, park-view scope. A press sets the Master
  volume to 0 and remembers the level; the next press brings it back (the default 70 when nothing is remembered: muted
  from the slider, or after a reload). The toast names the state: "Sound muted · M to unmute" (the live key) or "Sound
  on · Master 70 %", class `important`. A held key does not flip it twice.
- [x] **Crowd heatmap key (Phase 14 decision line).** `toggleCrowdHeatmap`, default T, group View. It calls
  `GameApp.setCrowdHeatmapVisible`, the method the rail button reaches through the bridge, so it turns the scenery
  heatmap off and, with the classic renderer, stays off with the same toast. The ≋ button's title and
  `aria-keyshortcuts` now name the key ("Toggle crowd flow heatmap (T)").
- [x] Both new defaults carry `yieldsDefault`: a player who had bound another action to T or M keeps it and the new
  action loads unbound (the Phase 26 Q/E pattern). KEYBINDINGS.md regenerated with
  `UPDATE_KEYBINDINGS_DOC=1 npx vitest run src/settings/keybindings.doc.test.ts` (new "Crowd heatmap" row and a Sound
  section).

**Idle prefetch of the lazy panels (Phase 34 open item).**
- [x] `GameApp.firstFrame` resolves on the first app frame; `App.tsx` then calls `prefetchLazyPanels()`, which fetches
  the Settings, Save / Load and Paint chunks one per idle slot (`requestIdleCallback` with a 10 s timeout, else a 2 s
  `setTimeout`) through the same `PANEL_LOADERS` that `React.lazy` uses, so the later open resolves from the module
  cache. A failed prefetch is silent (no toast, no console); the panel's open then behaves as in Phase 34 (the error
  boundary speaks). `bundleSplit.static.test.ts` still passes: the bodies stay behind `import()`.

**Park Pulse card list (Phase 25 open line).**
- [x] A "more below ▾" cue under the card list while rows hide below its fold (`hasMoreBelow`: scroll height minus scroll
  top minus client height over 1 px), updated on scroll, on a resize (`ResizeObserver`) and when the rows change.
  `aria-hidden`: a screen reader already hears every row. Not interactive.

**Phase 11 "Known and left open".**
- [x] Verified: the toast glyph and the estate row / inspector were fixed in Phase 30.
- [ ] The armed coaster's footprint as a white outline, not a red fill: not done. The voxel overlay already draws each
  footprint cell in the bulldoze red at 50 % alpha with a white outline, so the cause (the track drawn over the ground
  diamonds, or the scene's own preview) can only be found in a browser. *(Fixed in Phase 36.)*
- [ ] Panning up at 1100x690 leaving the plot behind the build dock: not done; a camera clamp change that needs a browser
  at that size to check (⌂ and V still bring it back). *(Fixed in Phase 36.)*

**Changelog.** [x] 0.3.2, "Faster start and fewer snags", for Phases 34 and 35; `package.json` 0.3.2.

**Tests.** New `settings/keybindings.phase35.test.ts` (6: defaults, yielding, the mute step and toast),
`ui/moreBelowCue.test.tsx` (2); Phase 35 cases in `app/GameApp.keys.test.ts` (4: mute and unmute, a rebound mute key,
the heatmap with a voxel-like renderer, the classic toast), `ui/lazyPanels.test.tsx` (4: idle scheduling one panel per
slot, silent failure, the timer fallback, the default loaders) and `ui/aboutModel.test.ts` (1). Updated: the registry
count and defaults (`keybindings.test.ts`), the group titles (`keyboardSettingsModel.test.ts`), the ≋ button markup
(`phase14Markup.test.tsx`). Whole suite: 448 files passed, 3 skipped; 7,903 tests passed, 20 expected fail, 75 skipped (210 s). `BUNDLE_BUDGET=1`: 3 passed. Typecheck, lint and build pass; entry chunk 978.85 kB / 290.49 kB gzip (976.4 / 289.6 before the phase; the prefetch and the two keys), still under the 1,025 kB warning limit and the gzip budget.

**Decisions (defaulted by the orchestrator on 2026-10-15; open for the owner to overturn)**

- **Mute is the Master volume at 0**, not a new settings field: the slider shows it, it survives a reload, and no settings
  shape changed. The level to come back to lives for the session only; after a reload unmute gives the default 70.
- **M for mute, T for the crowd heatmap** ("traffic"; C, H and N were taken or used by tests as free keys), both
  rebindable and both yielding to older bindings.
- **Mute is a new Sound group** in Settings > Keyboard and KEYBINDINGS.md; the heatmap key sits in View.
- **The mute toast is `important`** (shown unless notifications are Minimal); the heatmap key has no toast of its own,
  as the button has none, except the classic renderer's existing one.
- **Prefetch one panel per idle slot**, after the first world frame, in the order Settings, Save / Load, Paint.
- **The "more below" cue is drawn only**, with no count of hidden rows and no click.

**Open for the owner:** a browser check of the cue at the 820 px and 720 px container heights (the markup and rule are
pinned, the layout was not measured; not checked in Phase 36 either); whether the prefetch makes the first open feel
instant on a throttled connection *(Phase 36 checked in headless Chromium that the chunks are fetched and that M and T
work; the throttled feel is still the owner's)*; the two Phase 11 renderer items above *(fixed in Phase 36)*; whether mute should also work behind dialogs and menus (it uses the park-view
scope like the other view keys).

## Phase 36 — Browser Verification (2026-10-15)

Phases 30 to 35 were built today and tested only in vitest and jsdom. This phase ran them in headless Chromium. The
setup was Playwright 1.64.1 driving Chrome for Testing 156.0.8078.4, with software GL (ANGLE on SwiftShader), at
1280x800 and 1100x690. The production build was served from `dist`; the dev hooks (`?dev=1`, `__parksmithDev`) ran
against the dev server. Setup notes are in `.voxel-handoff/understand/headless-browser.md` section 14. Screenshots and
scripts are in the session scratchpad (`browser/shots`, `browser/scripts`).

This phase changed no simulation rule, save field, schema (15) or content version (5), and moved no determinism pin.
Every fix is in UI, layout or renderer code. Version unchanged (0.3.2).

**Verified in headless Chromium (software GL).**
- [x] **Phase 30, Park Pulse.** The card keeps its three-line budget: two non-thought lines (capacity, bottleneck) and
  one thought. Three thoughts show when there are no others.
  - A real queue complaint was produced: a $1 carousel and 160 guests.
  - A stall price complaint was produced with the test's recipe (two guests turned away at the counter).
  - Both show "→ name" links in the Pulse, in Live signals (Overview) and in Repeated thoughts (Activity).
  - A link from the dashboard closes it, eases the camera to the building, opens the ride or stall inspector, and moves
    focus to the inspector's close button. The same is true from the Pulse.
- [x] **Phase 30, guest inspector.** It opens on a click on a walking or standing guest, and on a click on the bench
  under a seated guest.
- [x] **Phase 30, stalls and comfort.** The souvenir stall inspector reads "SOUVENIR STALL" and "Umbrellas sell in the
  rain · dry now". After the developer weather switches to rain it reads "· selling now". The Buildings row reads
  "Umbrellas · sell in the rain". The Overview shows the comfort chip row.
- [x] **Phase 31.** Autosave rotation against the real IndexedDB.
  - Three autosaves gave revisions 1, 2, 3 in `autosave` and 1, 2 in `autosave-previous`: two rotations. The payload
    store holds both keys. The autosaves were the park-start one, then two hidden-page flushes.
  - Save / Load lists "Previous autosave" right after the autosave. At 1100x690 the AUTO / PREV tags give way to the
    names.
  - After a reload, Continue names the autosave and loads the park with every built path.
- [x] **Phase 33.**
  - The Rides dock is 212 px high with the two-line requirement ("650 RP · $750 · after Spin Studies").
  - Meadow Estate's Overview shows five KPIs at both sizes.
  - The top-bar subtitle shows "Harvest Festival" and "Level 5 · Seaside" whole, and ellipsises a 46-character name at
    190 px, with the whole name in the title.
  - The 'Shops' tab is shown.
- [x] **Phase 34 / 35, prefetch.** Production build, network log: `SettingsDialog` (JS and CSS), `SaveLoadDialog` and
  `PaintPanel` are fetched about 1.8 s after load, while the start screen's park runs. Opening Settings, Save / Load and
  Paint afterwards fetches nothing more; only the save worker arrives, at the first autosave.
- [x] **Phase 35, keys.** M shows "Sound muted · M to unmute", then "Sound on · Master 70 %". T turns the crowd heatmap
  on and off; the ≋ button's `aria-pressed` follows, and its title names T.

**Bugs found and fixed.**
- [x] **A click on a guest's body or head missed them** (Phase 30). The figure is about 20 px tall where one view cell
  along the view diagonal is 32 px, and a click 8 px or more above the feet missed.
  - Cause: the pick took the guest within 0.75 of the clicked GROUND cell, but a click on the body lands on the ground
    behind the figure.
  - Fix: `app/guestPick.ts` `pickGuest` measures the distance to the segment from the clicked cell 0.7 of a view cell
    towards the viewer, for the shown view rotation. `GameApp.selectObjectAt` uses it.
  - After the fix, clicks up to 24 px above the feet pick the guest.
  - The simulation's `guestNear` is unchanged.
- [x] **A complaint link at 1100x690 hid its building under the inspector it opened.** `focusBuilding` centred the
  building in the viewport, and the ride inspector beside Park Pulse covers the middle at that size.
  - The focus now passes the HUD's cover (`layoutModel.hudInsets`, with the inspector when one opens) to
    `RendererPort.focusCell`.
  - The voxel camera puts the building in the middle of what is left (`VoxelCamera.safeCentreFractions`,
    `focusCellXY` fractions).
  - The Neighborhoods focus uses the same cover without the inspector. The classic renderer still centres.
- [x] **Phase 11: the armed coaster's footprint as white outlines only.** The overlay did fill each cell. But it
  composites alpha as a 4x4 dither, and the 4/8 checkerboard of the demolition red over the brick path averaged out to
  the path's own pink at 1:1. A clear that will happen now fills at 6/8 (`overlays.ts` `BULLDOZE_FILL_ALPHA`). A refused
  clear and build previews keep 4/8.
- [x] **Phase 11: panning up or left at 1100x690 parked the plot behind the dock or Park Pulse.** The clamp kept a plot
  cell under the viewport, not under the part the HUD leaves uncovered.
  - `VoxelCamera.setSafeInsets` makes the clamp work on the uncovered rectangle, with the margin computed from its size.
    `RendererPort.setViewInsets` carries the insets.
  - GameApp sends them on attach, on a resize and on a UI scale change.
  - With no insets the clamp is bit-identical, and the existing clamp tests pass unchanged.
- [x] **The dock outgrew its layout anchor.** Measured dock heights: Paths, Facilities and Comforts 189 px, Shops 196,
  Rides 212, Scenery 223. The anchor was 204 px.
  - In Scenery, a research-locked card with a two-line name (Harbor Lighthouse) is 126 px. It was 116 before Phase 33,
    so it was already past the anchor.
  - At 1280 px and wider the help hint ran into the dock's top edge, and Park Pulse's cap (`--dock-reserve`) could reach
    8 px into it.
  - New anchors: `dockHeight` 223 and `dockReserve` / `--dock-reserve` / `.help-hint` 251. `--side-floor` is now 271, so
    side panels stay above the hint.
  - The cursor readout now sits at `--dock-reserve` + 26 instead of a copied 258 px.
- [x] **The five-KPI row cut the land figure to "12 / 64 p…"** (Phase 33) at every size, because the dashboard has a
  fixed width. The label now reads LAND PARCELS and the figure "12 / 64". The tooltip is unchanged.

**Seen, not changed (open for the owner).**
- Price complaints that come from planning link nothing, by design ("too expensive" from a guest who turned down
  several destinations). A $25 carousel gave 80 guests "think a price is too high" with no link. Only refusals at a
  building's entrance or counter link, so in normal play the price link is rare.
- "That queue is completely full." reaches the Pulse raw. Old raw thoughts stay raw (the Phase 30 decision).
- The souvenir stall's "Demand now" line sits below the inspector's fold at 1280x800, so the player has to scroll to
  see it.

**Still needs real hardware or a person.**
- Everything about speed and feel: GPU cost, frame times, the first-load timing and the prefetch on a throttled
  connection. SwiftShader is not a GPU.
- Real fonts. Avenir Next and Segoe UI fell back to Liberation Sans, so wrap points (the 223 px dock, the title
  ellipsis) may differ by a line on Windows and macOS.
- Safari, Firefox and Edge, real touchpads, and a real wheel.
- A person's playtest of the guest-life feel.
- Phase 31 crash recovery offering the previous generation. It needs a killed tab, and was not run.
- The Phase 35 "more below" cue at 820 px and 720 px container heights. It was not checked.
- The camera framing on the classic renderer, which ignores the insets.

**Tests.**
- New: `app/guestPick.test.ts` (5), `app/GameApp.phase36.test.ts` (3), `rendering/voxel/camera.insets.test.ts` (4).
  The camera test includes the 1100x690 pan that fails without insets.
- New cases: `overlay/bulldozePreview.review.test.ts` (6/8 for a clear that will happen, 4/8 otherwise) and
  `ui/layoutModel.test.ts` (the inspector anchors, `hudInsets`, the readout on the reserve).
- Updated: `ui/phase33Markup.test.tsx` (LAND PARCELS).
- Whole suite: 451 files passed, 3 skipped; 7,917 tests passed, 20 expected fail, 75 skipped (214 s). A first run with
  the browser checks going at the same time timed out one 5 s test (`save/session.serialize.test.ts`); it passes alone
  and in the quiet rerun.
- `BUNDLE_BUDGET=1`: 3 passed. Typecheck, lint and build pass. Entry chunk 981.22 kB / 291.33 kB gzip (978.85 /
  290.49 before), still under the 1,025 kB warning limit and the gzip budget.

**Decisions (defaulted by the orchestrator on 2026-10-15; open for the owner to overturn)**

- **The anchors follow the measured dock** (223 px) instead of shrinking the cards. This keeps the Phase 33 two-line
  requirement and the Phase 29 scenery stats. Park Pulse and the side panels give up 19 px of height and scroll sooner.
- **The HUD cover is one rectangle per side**, taken from the layout anchors, not measured from the DOM. It is generous
  where the dock is narrower than the screen.
- **A guest figure reaches 0.7 of a view cell**, measured on the default zoom. A click on the ground just behind a
  guest therefore picks them too.
- **A clear that will happen is filled at 6/8** in the voxel overlay. The classic renderer keeps 50 %, because it does
  not dither.

## Start Screen Backdrop (2026-10-16, outside the phase order)

Asked for directly; no save field, schema or determinism pin changed. Code: `src/ui/menuModel.ts` (`bootMenuDecision`),
`src/app/cameraSweep.ts` (`sweepZoomStep`, `sweepDayPhase`), `GameApp` (`starterPark`, the sweep), `RendererPort`
(`cameraZoom`, `setCameraZoom`, voxel only), `src/game/session/devPark.ts` (`DEV_PARK_CENTRE`).

- [x] **Every boot opens on the start screen**, a first run included. This replaces the Phase 23 decision that dropped a
  new player straight into the Sandbox First Day park. New park from the menu still gives the First Day hints; `&menu=0`
  still skips the menu.
- [x] **With nothing to continue, the backdrop is the developer park** (paused, First Day hints dismissed, the drift
  centred on the built park). It is only a backdrop: New park starts a fresh, empty session. Stamping it takes about
  1–6 ms. If the layout cannot be stamped, the empty starter map is shown as before.
- [x] **The sweep does more than drift.** The zoom steps through whole levels above the starting one (0, +1, +2, +1,
  16 s each; a step is a cut, so the pixel art stays crisp), and the light runs through a full day in 150 s from the
  park's own time, easing in like the drift. The zoom the park had is put back when the sweep stops. Reduced motion
  keeps the still frame (no zoom steps, the park's own light); `&time=` still pins the light.

## Phase 37 — Path Drag Re-route (2026-10-16)

**Problem.** If a path drag ran into something it cannot cross (a building, a prop, water), the whole draft turned red
and stayed red: the draft only grew, so moving the pointer back did not take the bad cells out.

**Built.** Code: `src/app/pathDraft.ts` (`extendPathDraft`, `blockedDraftCells`), `GameApp.handleMove` /
`previewDraftPath`, a `blocked` argument on `RendererPort.drawPreview` (classic `WorldRenderer`, voxel
`VoxelRenderer` → `VoxelOverlays.drawPreview`, part of the voxel preview key). No save, schema or pin change.

- [x] **Backtrack.** A cell of the pointer's line that is already in the draft cuts the draft back to that cell. The
  line is walked cell by cell, so a fast move that crosses the trail cuts at the first trail cell it meets and grows on
  from there. The preview and the hover card (cost, message) redraw at once.
- [x] **Decided: cut on any trail cell.** A drag cannot cross its own trail in one gesture (crossing cuts back); a
  crossing is two drags. Existing world paths are not draft cells, so crossing them is unaffected.
- [x] **Blocked cells are drawn apart.** The cells that cannot take a path are red and the rest mint, in both
  renderers, kept through a view turn. A draft the park cannot afford (or one with nothing new to build) is all red,
  as before; the hover card still refuses a draft with any blocked cell.
- [ ] **Step back from the keyboard: not built.** Backspace while the button is held would drop the last cell, but
  the next pointer move re-adds it at once (the line runs from the draft's end to the pointer), so it only helps
  with a still pointer. Pulling back does the same job. Revisit if playtests ask for it.
- [x] Unchanged: the release builds only an all-valid, affordable draft, as one undo entry; the refusal toast names
  the first blocked cell; a mid-drag Ctrl+Z empties the draft.
- [x] Tests: `pathDraft.test.ts` (cut, full pull-back, steer round, fast cross, no duplicates),
  `GameApp.pathDraft.test.ts` (into a bench, pulled back and round it builds exactly the final route; hover cost
  follows the cut; unaffordable is all red; mid-drag Ctrl+Z), `rendering/pathDraftPreview.test.ts` (both renderers).

## Phase 38 — Coaster Track Over and Under (2026-10-16)

**Problem.** A coaster could not cross itself or anything else at a different height: `validateCoasterLayout` refused
any repeated cell and the world held one occupant per cell. The only crossing was track at level 2+ over a path.

**Built.** Code: `game/coaster/design.ts` (`isExclusiveCoasterPiece`, `trackPiecesMayCross`, `coasterCrossings`, two
new failures), `GameWorld` (`trackLayers`, `coasterPieceConflict`, `objectsAt`, `trackHeightsAt`, `hasSomethingUnder`),
`BuildDefinition.clearanceLevels`, `GameApp` (designer re-entry, conflict message, selection cycling), voxel
`pieceBoxes(…, supports)`. No schema bump: the layers are rebuilt from the saved pieces at load.

- [x] **Clearance in levels.** `GAME_CONFIG.coaster.trackClearanceLevels` = 2, the same as `pathClearanceHeight`. With
  today's caps (2, 3, 4) a crossing needs ground-level track under level 2+ track. Raising the caps stays a balance
  question (BALANCE_NOTES Phase 38).
- [x] **Over objects.** `clearanceLevels` on benches, the bin, flowers, the planter (1), the idol (2), the fountain,
  lamp and torch (3); track at `clearanceLevels + 1` or higher passes over them, and they may be built under such
  track. Everything else (rides, stalls, the entrance, tall scenery) is never crossed. A render test keeps every value
  honest against the voxel model's height.
- [x] **Stations and specials stay alone**: a station piece, a loop, a boost and the piece after a loop (its ring
  overhangs it) are never crossed, above or below, by track or objects. Paths under them keep the old rule.
- [x] Layered occupancy: one ground occupant plus track layers per cell. `objectAt` answers the ground occupant first,
  else the top-most track; `objectsAt` lists all, top first; a repeated click on a crossing steps the selection down.
- [x] `validateCoasterLayout`: `overlapping` for the same height, `crossing-too-close` ("Too close to the track below: 2
  levels needed."), `crossing-not-allowed` for an exclusive piece. Restore refuses a save with a crossing too close or
  over an object it does not clear.
- [x] Bulldoze takes the ground occupant (or path) first, then the top-most track; demolishing removes only that
  object's layers. Undo unchanged.
- [x] Saves: no schema bump. Determinism: final states, events and fingerprints unchanged in every fixture; only the
  `observables` probe (which asks `canPlaceCoasterPiece` on every cell) moved and was re-pinned.
- [x] Stats: +2 excitement per crossing, at most 3 counted; a layout without a crossing is unchanged.
- [x] Draft: the designer may re-enter a cell it already uses when the height rule holds; a refused re-entry toasts
  the clearance message once per cell. The status line names the world conflict (other track, a path, a building).
- [x] Height in the hover line while laying track: "Next piece at level 0 · track here at level 2" (the draft's own
  pieces and other coasters in that cell).
- [x] Supports (voxel): a piece with something under it (other track, a low object, a lower piece of its own layout)
  gets no bent; its neighbours carry it. Paths under track keep the Phase 27 walkway rule.
- [ ] **Not built: see-through for the lower track** and a classic-renderer support rule (classic is frozen). The
  train-clearance fuzz review stays `it.fails` as before.
- [x] Tests: `game/coaster/crossing.test.ts` (figure eight validates and builds; level 0/1 refused; boost crossing
  refused; bonus; second coaster over the first at clearance and not closer; bulldoze takes the upper; bench under,
  stall refused, too-low bench refused, lamp refused; save/load round trip; too-close save refused),
  `rendering/voxel/content/coasterCrossing.test.ts` (no bent on the upper piece, the `supports` flag, model heights),
  `GameApp.coasterLift.test.ts` (designer re-entry at clearance, refusal with the message).

## Phase 39 — More Coaster Types (built 2026-10-16: wild mouse, wooden, launch, inverted)

**Before.** Three coaster types (`comet-trail`, `star-chaser`, `skyline-serpent`), the same steel coaster with different
numbers. **Now** every `CoasterTypeDefinition` has a `family` (`steel`, `wild-mouse`, `wooden`) that selects build
rules (`validateCoasterLayout`), ride-model weights (`GAME_CONFIG.coaster.families`, read by `deriveCoasterStats`; the
`steel` row is exactly the old numbers) and art (track look, supports, cars). Content version 6; no schema change (a
coaster stores its type id).

**Built (step 1).**
- [x] **Wild mouse: Whisker Mouse** (`whisker-mouse`, research *Tight Turns*, tier 2 after Spin Studies). Height cap 3,
  no specials, **flat turns only** (`mouse-turn-not-flat`: "Wild mouse turns must be flat: climb and drop on the
  straights."). Turns weigh 2.4 (steel 1.5), steep turn pairs 4 (2.2), drops less (biggest drop 6, descent 3). Cheap
  (station 280, piece 32). **Deviation:** two four-seat cars (capacity 8), not one: a single car carried a third of a
  family coaster for 70 % of its price and lost on every axis. Lead car with a mouse face (ears, whiskers, nose).
- [x] **Wooden: Timber Twister** (`timber-twister`, research *Timber Framing*, tier 2 after Family Favorites). Height
  cap 3, no loops or boosts, rougher (biggest drop weighs 13, steel 10) with an airtime bonus of 1.5 per drop (up to
  4), reliability 76 (wears faster), cheaper track (piece 42). Wood ties, a timber spine and **lattice bents** (every
  bay braced both ways, `emitCrossBrace`, no overlapping boxes), a mine-cart lead car with a lantern.
- [x] Catalog cards and colour slots use existing catalog colours only, so the voxel palette gained no material.
  Classic renderer: palettes for both (the classic train falls back to the comet style).
- [x] Tests: `game/coaster/families.test.ts` (families, mouse rule, ride model, save round trip),
  `rendering/voxel/content/coasterFamilies.test.ts` (lattice in timber, no overlaps, cars compile); the enumeration
  tests (colour slots, filters, research tree, branch copy) name the two new cards; determinism pins unchanged (the
  harness drops appended definitions and projects, as for Phase 16).

**Not built yet (step 2+).**
- [x] **Launch: Thunder Launch** (`thunder-launch`, step 2, research *Launch Lab*, tier 3 after Vertical Motion). A new
  special `launch` (straight, not on the station; the boost's chevrons), at least one required (`launch-missing`). The
  speed model fires the train out at `speed.launch` (8.5, above the drop cap 6), so a chain-free climb after it rides
  the momentum up a top hat; the family's height cap is `coaster.launchMaximumHeight` (5). Launches add excitement 6,
  intensity 8, $420 and running cost; no saved stat changed shape (a layout without a launch derives exactly as
  before). On a 32-piece top hat: excitement 97.8, intensity 91.7, top speed 8.3, $4,610 (BALANCE_NOTES Phase 39).
- [x] **Inverted: Bat Wing** (`bat-wing`, step 3, research *Suspended Track*, tier 3 after Timber Framing). The game
  keeps the piece level as the train's level; the art draws the track one level up (`INVERTED_TRACK_LIFT`, 13 voxels)
  and hangs the cars under it (`coasterHangOffset`, 4 voxels below the normal rail top), on steel gantries (two legs
  beside the train and a beam over the top, every other straight piece) instead of bents. Rules: no loops; a path
  (or a low object) under it needs one level more than under ordinary track; it never crosses other track or itself
  (`TrackLayer.hangs`, also checked at load). Turns weigh 2 and steep turn pairs 3.2 (steel 1.5 / 2.2). Deviation
  from the plan's "every piece outside the station at level 3": the lifted drawing lets the station stay at level 0
  and the cars clear the ground at every level. Checked in headless Chromium.
- [ ] Candidates after these: mine train, spinning, bobsled, flying, water coaster.
- [ ] Per family still open: a lift/launch sound per family (Phase 15 synth), a classic train style per family,
  determinism fixtures with one coaster per family, and a played balance check (BALANCE_NOTES Phase 39).

## Phase 40 — Building Fronts: Four Directions and Front-Only Access (built 2026-10-16)

**Problem.** A building can only face two ways. The build rotation (R) runs 0–3 and is saved that way, but it is
treated as a footprint orientation only: `footprintSize` swaps width and depth on odd turns, and the voxel models turn
with `visualQuarterTurn = rotation % 2` (`rendering/voxel/contracts/space.ts`: "r and r + 2 are the same world model").
The front of a stall therefore always faces screen lower-left or lower-right in view 0, and on a path to its north or
west the player cannot turn its counter toward the path. Separately, the front means nothing to guests:
`GuestSimulation` makes every path cell beside ANY side of the footprint an access cell, so a stall with its back to
the path still sells.

**Goal.** Every building can face all four ways, and the front decides access: guests buy, queue and sit only from the
front. A shop built facing away from the path cannot be reached.

**Four real directions (40a, built).** Code: `contracts/space.ts` (`QuarterTurn` 0–3, `visualQuarterTurn` = the
rotation, `propQuarterTurn` keeps map props at two looks), `blueprint/compile.ts` (`rotateModel` applies the single turn
q times; the cache holds four turns), `scene/rigid.ts` (`writeRotatedPartTransform` for all four turns), `figures.ts`
(a bench seat faces the bench's front), `game/types.ts` `frontOf`, `game/access.ts` `frontEdgeCells`,
`app/buildFacing.ts`.
- [x] Every model is drawn in all four turns (voxel). The classic renderer keeps its two sprites (frozen fallback).
  The ghost marks the cells in front of the front edge with small white diamonds (rides, stalls, facilities, comforts;
  not scenery or paths).
- [x] R and the Rotate button already stepped through four rotations; the toast now says where the front points on
  screen ("Picnic Pocket · 2×2 · front lower left"), following the map view.
- [x] Moving parts, colour slots and the view rotation work in all four turns (rigid test for every turn; the colour
  slots are materials, not geometry). No pin moved: no fixture holds a building at rotation 2 or 3.
- [ ] The Phase 27 visual matrix gains the two new turns: with the browser verification pass.

**Front-only access (40b, built).** Code: `game/access.ts` (`frontEdgeCells`, `isFrontOnly`, `sameFootprintRotations`),
`GameWorld` (`setFrontAccess`, `frontAccessFor`, `frontFacesPath`, `facingRotation`, `buildObject(…, { exactRotation })`),
`GuestSimulation.refreshDestinations` and `ManagementSimulation` connectivity, the ruleset key `frontAccess`
(`scenarios/rules.ts`, `ParkSession`, schema 16 with migration 15→16), `GameApp` hover (auto-facing, R override,
`FRONT_FACES_NO_PATH`).
- [x] The access cells of a front-only building are the path cells just outside its front edge (every cell along a
  wider front counts). Staff still use every side.
- [x] **Decided (as recommended): services and benches are front-only**; rides keep every side; bins and scenery have
  no access.
- [x] **Placement help:** arriving beside a path, the ghost turns a front-only building toward it (a turn that keeps
  the footprint first, then a quarter turn where that fits). R wins on the cell it was pressed on, until the pointer
  moves to another cell. The player's click builds exactly the turn the ghost shows.
- [x] **Feedback:** a building whose front faces no path can still be built; the hover line says "Front faces no path:
  guests cannot reach it. Press R to turn it." Once built it counts as not connected, so the existing no-path badge
  (Phase 11, PA-024) and the management warnings name it. The ghost keeps the build colour (red means "cannot be
  built"); a separate warning tint is not built.
- [x] **Existing parks do not break — deviation from the per-object plan.** Front-only access is a ruleset key
  (`frontAccess`, written last, only when on), like Phase 14's `crowdFeedback`: a NEW park compiles it from
  `GAME_CONFIG.access.frontOnly`; every park saved before Phase 40 has no key and keeps every side for every building,
  old or new. No object is turned at load and there is no `legacyAccess` flag: an old park plays exactly as it did, and
  its saves and the frozen fixtures load byte for byte. Schema 16; migration 15→16 drops only a hand-edited key.
- [x] Anything but the player's click turns a front-only building to face a path where its footprint allows: scenario
  and map starting objects, the dev park, the strategy and scenario bots, the determinism fixtures. Every starting park
  has every service and bench facing a path (`frontAccess.test.ts`).
- [x] Pins: with `frontOnly` off every pin holds (`defaultIdentity.review.test.ts`; the renderer identity tests run with
  it off). With it on: fixture 2c moved only by the key; the seven lift-review parks that seed or build their own
  stalls were re-pinned; the four scenario parks did not move.
- [x] Re-measure: see BALANCE_NOTES "Phase 40".

**Tests (built).** `blueprint/fourTurns.test.ts` and `scene/rigid.test.ts` (four distinct turns, the cache, moving parts
in every turn), `app/buildFacing.test.ts`, `game/frontAccess.test.ts` (the rule compiles and saves last; front edge
cells; a stall facing the path is a destination and one facing away is not, a two-wide front gives two access cells;
non-player placement turns, the player's is exact; every starting park faces its paths; every dev park service sells),
`app/GameApp.fronts.test.ts` (auto-facing, R override with the warning, rides not turned), migration 15→16.

## Phase 41 — Cinematic 3D Camera (built 2026-10-16 after the owner's go)

**Why it is closer than it sounds.** The voxel renderer already holds the park as real 3D data: axis-aligned boxes (32
voxels per tile) with heights, drawn by vertex pulling. What makes the picture isometric is the projection in the
vertex shader, the 2:1 voxel space, the low-res target with integer upscale and the texel snapping. A different camera
is a different projection of the same boxes; the scene, the blueprints and the simulation do not change.

**What it costs (estimate, to be measured in step 0).**
- Geometry is not the problem: the dev park is about 15,600 boxes and the worst park about 61,400 (some 190,000 to
  740,000 triangles), small for any GPU that runs the composite today.
- The cost moves to the GPU fill and the composite. A low camera sees to the horizon, so the low-res target fills with
  terrain and overdraw rises; the screen-space passes (lights, shadows as decals, dither, see-through) were written for
  one projection and must be checked or redone.
- Main thread: unchanged per frame except a frustum cull of the chunks (the static chunks are already the unit).
- Expected: no visible cost on the one measured desktop GPU, and a real risk on phones and Intel iGPUs (already the
  open hardware checklist). The 3D camera therefore runs only where the isometric view does not: the menu, a view-turn
  transition and ride-along, never while building. It can be switched off (Settings > Graphics), and reduced motion
  turns it off.
- The pixel-art look: a smoothly moving perspective camera shimmers on a texel grid. Options to weigh in step 0: render
  the 3D camera at full resolution (sharper, costlier), keep the low-res target and accept some shimmer, or snap the
  camera to texel steps.

**Steps.**
- [x] **0. Spike (decides the rest).** Built behind the developer flag `&camera3d=1` (`orbit`) or `&camera3d=low`:
  `gpu/shaders/perspective.ts` (a vertex stage that shows, per box axis, the face toward the eye and maps world voxels
  through `uViewProj`; the isometric opaque fragment shader and the G-buffer unchanged), `voxel/cameraOrbit.ts` (orbit,
  low pass, look-at and perspective matrices, unit-tested), `VoxelGpu.drawChunksPerspective` (every live chunk, no
  cull yet), `rendererFlag.ts` `CAMERA_3D`. Without the flag nothing changes (no pin moved).
  - **It works on the first real try.** Screenshots (local only, `.voxel-handoff/phase41-spike/`): the orbit shows the
    whole dev park in true perspective; the low pass at 30 voxels walks between the Ferris wheel, the drop tower, a
    fenced ride and a tree, and the boxes read well up close.
  - **Measured (headless SwiftShader, 1280×800, dev park, clean view, 8 s):** isometric 9.6 fps, orbit 10.0 fps (no
    figures drawn), low pass 7.9 fps (more fill from near boxes). SwiftShader-bound, as every number here; the real-GPU
    cost is still unmeasured.
  - **What breaks:** (1) the light is wrong: the picture is dark and blue-shifted, because the composite rebuilds world
    positions and depth from the isometric depth key (shadows, light pools, fog and outlines all read it); a
    perspective composite (or writing the key the composite expects) is needed. (2) No sky: beyond the map is the flat
    background colour. (3) Guests, staff, litter, shadows, the ghost and the draft are not drawn (their programs are
    isometric); coaster cars and riders are, as rigid parts. (4) No frustum cull. (5) Pixel snapping does not apply,
    so a moving camera would shimmer; the spike renders at the low-res target and upscales like the isometric view.
  - **Recommendation:** go for steps 1 to 3 (sky, menu shots, smooth view turns) after a perspective composite; ride-
    along (step 4) after them. Decision for the owner.
- [x] **1. Sky and horizon (with the light fixed).** Owner go 2026-10-16 ("kör allt på rad"). `VoxelGpu.setPerspective(view
  | null)` replaced the spike's built-in orbit: the renderer sends a view per frame (`RendererPort.setCinematic`; the
  `&camera3d` flag still orbits or glides). A cinematic composite (`compositeShaderSource('lite', 'rain',
  { perspective: true })`): the lite face light (the G-buffer's perspective depth breaks the full look's outline,
  shadow and weather taps), a sky gradient above the horizon row (`horizonRow`) graded by the park's day look (night
  mixes toward the backdrop), and distance fog toward the horizon colour from the linear depth. Faces turned away
  from the isometric light are lit like their opposite (the cause of the spike's dark picture, with the dawn light of
  the test). A grass skirt five map widths out, a few voxels under the ground. Guests and staff draw through a
  perspective figure program (`perspectiveFigureShaderSource`). Still not drawn: litter, shadow decals, light pools,
  outlines. A failure to build the programs sets `perspectiveOk` false for good, and everything stays isometric.
- [x] **2. Menu shots.** `app/cinematicShots.ts` (pure, tested): four 14-second shots with cuts (a high orbit, a low
  dolly in from the gate along the inward way, a rise circling the first coaster or ride, a closer orbit the other
  way), eased inside each shot, the subject framed right of the menu card. The start screen's sweep plays them when the
  renderer draws them, Graphics detail is Full (Lite = the old isometric drift: the Settings switch the plan asked
  for, without a new setting) and motion is allowed (reduced motion keeps the still frame). Leaving the menu hands
  back the isometric camera.
- [x] **3. Smooth view turns.** Q / E yaw through the cinematic camera in 420 ms (smoothstep) about the ground point at
  the middle of the screen (`viewTurnCamera.ts`, tested): the isometric projection is an orthographic camera at 30°
  elevation, √2 texels per voxel, with z drawn at √(2/3); a 6° perspective camera far away with that z scale lands
  within a texel of it, so the snap to the new isometric view at the end does not show. The CPU side (picking, the
  scene sort, overlays) is in the new view from the first frame. A press during the yaw is dropped
  (`RendererPort.viewTurning`). Reduced motion, Lite graphics and loads snap as before. **Found on the way:** the
  isometric picture is the mirror image of a physical camera (+x runs right and toward the viewer), so every
  cinematic frame is flipped in x: signs read the right way, and the menu framing was turned round to match.
- [x] **4. Ride-along.** "Ride along" in the ride inspector (coasters) or "Ride view" (flat rides), shown only where
  the cinematic camera is offered (a GPU that draws it, Full graphics, motion allowed). A coaster rides in its lead
  car at a rider's eyes, looking down the track (`rideCamera.ts trainRideView`, from the train's own interpolated
  pose, `VoxelScene.leadCarPose`); a flat ride gets a slow close circle at riders' head height (riding a flat ride's
  moving part is not built). The simulation runs on; the HUD hides except a small bar with the ride's name, a
  comfort choice (Wide view 80° / Calm view 60°; no camera shake is added at all) and Exit ride. Esc always ends it;
  a demolished ride, a new park, Lite graphics or reduced motion end it too. Known: a loop keeps the world's up (no
  roll), so the view does not turn over inside the loop.
- [ ] **Later, not in this phase:** a free camera for screenshots (with the "In-game screenshots" candidate), and full
  3D building. Building would need ray picking, the ghost and overlays in 3D and a new camera control scheme; it stays
  under "Explicitly not now".

**Owner decision (2026-10-16).** Everything else stays as it is: building, managing and normal play use the isometric
camera only. The 3D camera is used for the menu shots, the view-turn transition and ride-along, and nowhere else.

**Rules.** Presentation only: nothing reaches the simulation, the hash or the undo ring. The classic renderer gets
none of it (frozen). If the GPU lacks something, the feature hides and the isometric view stays. Each step has its own
performance gate against the voxel table.

**Tests.** The projection maths (orbit, yaw blend landing on each isometric view exactly, ride-along camera from a train
pose) is pure and unit-tested; the chunk frustum cull keeps every visible chunk; the menu, the turn and the ride-along
fall back to the isometric view on a GPU without the feature and under reduced motion; a view turn refuses input until
it lands.

## Phase 42 — Staff Window and Buildings Window (built 2026-10-16; owner request 2026-10-16)

**Before.** Both lived only as tabs in the Management dashboard: staff as one card per role (no single worker could be
seen), buildings as one flat list with a few sort buttons, refreshed only while the dashboard was open.

**Built.** Two floating windows, usable while the park runs. Code: `ui/WindowFrame.tsx` (+ `windows.css`),
`ui/StaffWindow.tsx` and `ui/BuildingsWindow.tsx` (lazy chunks through `lazyPanels.tsx`, prefetched when idle),
`ui/staffWindowModel.ts`, `ui/buildingsWindowModel.ts`, `ui/windowPrefs.ts`, the store's `openWindows`, `workers`,
`buildingsView`; `OperationsSimulation.workersSnapshot` / `fireStaffById`; `GameApp` (`fireWorker`, `focusWorker`,
`centreBuilding`, `setObjectsOpen`, `adjustObjectPrice`, the UI tick, the keys, Esc).

**Staff window.**
- [x] Key **K** (`staffWindow`, rebindable, `yieldsDefault`), and "Manage staff in the Staff window" in the Operations
  tab. Docked beside the utility rail, draggable by its title bar (the title bar stays on screen), remembers whether
  it was open (local storage, per player; never in a save).
- [x] Per role: hire, train and payroll, the busy count and the cap. (Operations keeps its cards too, for now.)
- [x] Per worker: a generated name from the id (presentation only, no save field), what they are doing in words
  ("Repairing Aurora Wheel", "Walking to empty Tidy Totem", "Idle"); a click eases the camera to the worker; "Fire"
  dismisses exactly that worker. **Not built:** a highlight on the worker in the world, and "time since hired" (the
  simulation keeps no hire time; it would need a save field).
- [x] Overview: litter (units and tiles), rides waiting for a mechanic and broken rides, cleanliness, and the hints
  "more cleaners needed" (dirty while every cleaner is busy) and "hire another mechanic" (a breakdown waits).
- [x] Out of scope as planned: shifts, rosters, patrol zones.

**Buildings window.**
- [x] Key **O** (`buildingsWindow`), and a link at the top of the dashboard's Buildings tab (the tab stays for now; Phase
  43 decides the dashboard's future).
- [x] Filters by group (rides, coasters, food, drink, souvenirs, facilities, comforts, scenery) and by state (open,
  closed, broken down, no path access, which includes a Phase 40 front facing no path, needs inspection), plus a name
  search; they combine, each shows its count, and the choice is remembered per player.
- [x] Columns per group (a scenery row shows appeal; services show price, queue, served, revenue, satisfied; rides add
  wait, per hour and condition); a header click sorts, again flips the direction, missing values always last. **Not
  built:** profit, age and last inspection (no such reads exist yet).
- [x] Row actions: the name centres the camera, ⓘ opens the inspector, open or close, price − / +. Selected rows can be
  opened or closed together.
- [x] Live: rows come from the 250 ms `buildingsSnapshot`, published while the window (or the dashboard) is open, never
  per frame. A row whose open state or status changed flashes once (not with reduced motion).

**Shared.**
- [x] `WindowFrame`: title, close, drag (kept on screen), the focus moves in on open and back on close, Esc inside it
  closes it; Esc with nothing else open closes the newest window before the pause menu opens. An open window widens
  the camera's left inset (`hudInsets(…, windowOpen)`), pushed when windows open or close.
- [x] Lazy chunks; the entry stays at 985 kB raw / 292 kB gzip, inside the Phase 34 budget (`BUNDLE_BUDGET=1` passes).
- [x] No simulation rule changes; the only new game-side reads are `workersSnapshot` and `fireStaffById`.
- [ ] **HUD buttons:** not on the utility rail (two more buttons push the developer rail past the smallest supported
  height); they arrive with the Phase 43 menu bar. Until then: K, O and the dashboard links.

**Tests.** `ui/phase42Windows.test.tsx` (names, activity lines, hints; the worker snapshot and "fire this one"; filters,
counts, search, sort both ways, a stored view; the two windows' markup; the camera inset; the drag clamp),
`app/GameApp.windows.test.ts` (K and O, Esc order, bulk close only the given rows, a price step by id, workers published
only while the Staff window is open), the lazy-panel and import-graph tests (five lazy panels).

## Phase 43 — Main Menu Bar (built 2026-10-16; owner request 2026-10-16)

**Before.** The ways into the panels were spread out (the cash pill opened the dashboard; Research, Operations and the
Buildings list were only dashboard tabs; the dock and Park Pulse were always on screen).

**Built.** Code: `ui/MenuBar.tsx`, `ui/menuBarModel.ts`, `ui/windows.css`; store `dockOpen` / `pulseOpen` (remembered
with the window prefs); four new keybindings; `layoutModel.ts` anchors.

- [x] Buttons along the bottom edge, in this order: **Build**, **Staff**, **Buildings**, **Park Pulse**, **Finances**,
  **Research**, **Land**, and **Parks** (or **Run map** in a run). Icon plus label; the key and any attention line in
  the tooltip. The order and names are open for the owner to change.
- [x] Each button toggles its area and shows as pressed while it is open: the build menu, the two Phase 42 windows,
  Park Pulse, the dashboard on Finances or Research, the Land tool (off an estate it says the park owns all its land).
  Windows may be open together; the dashboard is still the one full-screen-height panel.
- [x] Badges: Staff (rides broken or waiting for a mechanic), Buildings (no path access, which includes a Phase 40
  front facing no path), Research (projects ready to buy), Park Pulse (warnings while the card is closed). One polite
  live line reads them all.
- [x] Keys (all `yieldsDefault`, rebindable in Settings > Keyboard, in KEYBINDINGS.md): Build menu **Shift+B**, Park
  Pulse **Shift+P**, Finances **Shift+F**, Research **Shift+R**; Staff **K** and Buildings **O** (Phase 42); Land **L**
  (Phase 21).
- [x] Placement as the owner decided: along the bottom edge (`.menu-bar`, bottom 12, 44 tall); the dock now opens above
  it (bottom 66, `--dock-reserve` 300, the help hint on it). **Deviation:** the build menu and Park Pulse are open by
  default and can be closed with the bar (both remembered per player), rather than the dock starting hidden: a new
  player still sees the dock on the First Day. While a First Day build step is active and the dock is closed, the Build
  button is outlined.
- [x] The top bar keeps park status, clock, speed, Parks / Run map, Save / Load and cash (the cash pill still opens
  Finances). The view toggles and Settings stay on the rail; Menu (Esc) stays.
- [x] Narrow layouts (container width ≤ 1240): icons only, labels in the tooltips; the bar scrolls sideways instead of
  wrapping. The clean view hides it with the rest of the HUD.
- [x] Layout: the anchor model includes the bar and caps Park Pulse above the dock reserve (it scrolls past it, with
  the Phase 35 cue). Checked in headless Chromium at 1280×800 and 1100×690 (Phase 42 windows and the bar together).
- [x] The camera's bottom inset shrinks to the menu bar when the build menu is closed (`hudInsets(…, dockOpen)`).
- [ ] Not built: the First Day hint texts were not reworded (they name tabs, which open from Build).

**Tests.** `ui/menuBar.test.tsx` (order, Parks/Run map, pressed states, badges appear and clear, the live line, the
First Day outline, Land off an estate, the markup with key hints), `layoutModel.test.ts` (the bar in the anchor model,
Park Pulse above the dock), the keybinding registry and doc.

## Phase 44 — Shuttle Launch Coaster (built 2026-10-16; owner request 2026-10-16)

**Request.** "The launch coaster launches from the station by default, with an initial speed the player sets. Then an
uphill the train climbs and rolls backward to the station, so the track does not need to be a closed circuit."

- [x] **Thunder Launch becomes a shuttle.** A shuttle layout is open: the 3-piece flat station at level 0, then any
  track (turns, hills, boosts, loops), ending where the player stops laying it. The station fires the train out at the
  **launch speed** the designer sets (cells per second, saved on the first piece as `launchSpeed`; 6–14 in steps of 0.5,
  default 10). The train climbs until its momentum runs out, rolls backward the whole way and the station brakes stop it.
- [x] Rules (load-safe, `validateCoasterLayout`): no closure; at least `shuttle.minimumPieces`; no `launch` pieces (the
  station is the launch) and no special on the last piece; at least one climb of 2 levels. Designer-only checks
  (`checkCoasterDesign`, never at load): the train must not reach the end with speed to spare (`shuttle-overshoots`),
  must turn on a climb, not run dry on the flat (`shuttle-stops-flat`), and must not crawl over a hill on the way back
  (`shuttle-stalls-back`). A saved closed Thunder Launch (no `launchSpeed`) still loads and runs as a circuit.
- [x] Speed model `shuttleProfile`: integer energy (speed squared) out and back, the same loss per level as a free
  climb, a small friction per segment; the turnaround is a fraction of a segment. Saved `travelSeconds` hold the
  outbound times (nominal times on unused pieces); `durationSeconds` is out + back + loading. The train animation reads
  the out-and-back timeline (`coasterHeadIndex`), scaled to the saved duration.
- [x] Stats: the station launch counts as one launch; riding backward adds `shuttle.backwardExcitement`.
- [x] Art: the open centre line (`centreLineFor` builds a shuttle on its own open ring, scratch pieces after the last
  real piece, so piece indices are unchanged); no brake at the spike end and no chain anywhere; launch chevrons on the
  station. Designer: a launch speed control, the shuttle's turnaround shown in the status line.
- [x] Tests: validation, speed model (overshoot, flat stop, return stall), timeline monotone and ending parked, save
  round trip with `launchSpeed`, legacy closed launch layout still loads, art compiles without overlaps.
- [x] Built as planned; schema 17 (migration 16→17 drops a hand-edited `launchSpeed`), content version 7. Numbers in
  BALANCE_NOTES Phase 44. Code: `game/coaster/shuttle.ts`, the shuttle branches of `design.ts`, `lift.ts`,
  `centreLine.ts`, `coasterTrain.ts`; designer `GameApp.coasterAdjustLaunch`, Hud launch row.

## Phase 45 — Tall Coasters (built 2026-10-16; owner request 2026-10-16)

- [x] `coaster.absoluteMaximumHeight` is 10 (the save cap; `launchMaximumHeight` is gone); each type keeps its own cap
  (`coasterMaximumHeight`). Thunder Launch reaches 10 (a shuttle's spike); the new steel **Titan Hyper**
  (`titan-hyper`, research *Hyper Engineering*, tier 3 after Vertical Motion, 120 RP, $1,500) reaches 10. Catalog card,
  colour slots and classic palette reuse existing catalog colours (no new palette material); the serpent's car.
  **Deviation:** tier 3, not 4 (the tree has three tiers); the Titan takes loops and boosts now, the Phase 46 elements
  when they exist.
- [x] Intensity: a drop deeper than 4 levels counts each level past 4 at a quarter (`coaster.tall`), in both the
  biggest drop and the descent, so a level-10 hyper reads about 90, not a pinned 100. Every layout of the old cap
  derives exactly as before (the golden invariance and determinism pins did not move).
- [x] Checked at level 10 in headless Chromium (software GPU): towers and bracing reach the ground, chunk bounds come
  from the boxes, the shuttle train runs out to the spike and back. Classic renderer has no height bound.
- [x] Tests: `families.test.ts` (caps, intensity, save at level 10), `coasterFamilies.test.ts` (a level-10 tower, no
  overlaps); enumeration tests name the new card and project.

## Phase 46 — Coaster Elements (built 2026-10-16; owner request 2026-10-16)

- [x] New specials (`CoasterElement`), each with cost, excitement and intensity (`coaster.specials`), a speed effect
  (`coaster.elements`: drag on a circuit, energy on a shuttle, where an inversion also needs 4 cells/s to enter), art
  and car poses from the centre line:
  - **Airtime hill** (`airtime-hill`, one straight piece): a 0.8-level hump.
  - **Corkscrew** (`corkscrew`, two straight pieces): a full roll round a heartline 11 voxels above the rail.
  - **Zero-g roll** (`zero-g-roll`, two straight pieces): a full roll round a 6-voxel heartline over a one-level hump.
  - **Cobra roll** (`cobra-roll`, two turns the same way, a U-turn): a 2.5-level hump rolling a full turn toward the
    inside of the U, inverted at the top.
  - **Helix** (designer tool, "Helix left / right"): four turns round a 2 × 2 block, a level a piece toward the track
    height setting, over or under its own entry, and a fifth piece straight out. Recognised in the stats
    (`coasterHelixRuns`: four or more turns the same way rising or falling two levels or more; up to two count) and
    banked at 40° instead of 26°.
- [x] Rules: a two-piece element's second piece is the element's (straight for the rolls, the second turn for a
  cobra), exclusive like the piece after a loop, never on the station or a shuttle's end; the next special waits a
  plain piece after the element (`specials-too-close`); `cobra-needs-u-turn`. The designer puts a two-piece element on
  the piece before the last. Who takes what: Titan Hyper and Skyline Serpent all four; Thunder Launch airtime,
  corkscrew and zero-g (ridden out and back, so they count twice); Star Chaser and Timber Twister airtime hills.
- [x] The centre line owns the shapes (`elementKind` / `elementFrom` / `elementTo` / `elementSign` per piece, the hump
  and the heartline swing in the sampler, the roll in `centreLineRollInPiece`), so track, train, classic view and ride
  camera agree. The voxel track draws an element piece with `emitSweptPiece` (the cross-section voxelised along the
  rolled frame, merged into boxes, inside the tile; about 130 boxes for a hill, 260–410 for a roll); a bent carries
  it. The train's culling headroom grows by an element's rise.
- [x] No saved layout changes: a layout without an element derives exactly as before (the golden invariance and
  determinism pins did not move). Checked in headless Chromium: corkscrew, airtime hill, zero-g roll and cobra roll
  on one Titan Hyper, the train rolling through, and the classic view.
- [x] Tests: `game/coaster/elements.test.ts` (rules, stats, cost, shuttle energy, roll and hump on the line, helix,
  save round trip), `coasterFamilies.test.ts` (swept pieces inside their tiles, no overlaps, within the allowance),
  `GameApp.coasterLift.test.ts` (two-piece toggling, the helix tool).
- [ ] Not built: a sound per element, element markers in the inspector's evidence line, inverted-family elements.

## Voxel Renderer (main renderer)

The main renderer since 2026-10-06. The classic renderer stays the automatic fallback and is reachable with `?renderer=classic`. Architecture is under Renderers in ARCHITECTURE.md. It is a visual change on the fixed camera, not the "Full 3D" listed under not-now.

**Classic renderer: legacy (project owner's decision, 2026-10-13).** The classic renderer is frozen: it gets no new
features, no new tests beyond keeping it booting and playable as the fallback, and no new measurements. Every open plan
item that said "both renderers" is voxel only from this date (PA-018 closed, Phase 11B closed, Phase 14 heatmap, Phase
15 effects, Phase 21 camera, Phase 27 matrix). It is kept, not deleted, because it is the only protection for a machine
that fails the voxel capability checks and only one real GPU has been verified. Removal is the last item below.

- [x] `RendererPort` seam; shared `worldInput.ts` and `coasterTrain.ts`; classic never loads the voxel module (tested)
- [x] 2:1 voxel space, vertex-pulled boxes, MRT G-buffer, composite, integer upscale
- [x] Palette, world-anchored patterns, Bayer dither, low-res texel budget, integer zoom
- [x] Runtime blueprint compiler and models for the catalog, keyframed figures, rigid ride parts, coasters, litter, ghost and draft, overlays, badges
- [x] Interpolation by `SimulationClock.stepFraction` for figures, ride parts and trains (voxel only)
- [x] Fallback to classic (capabilities, software GPU, link/draw failures, fatal errors, context loss), `window.__voxelFailure`
- [x] fxc-safe composite with a static test, lite composite level, `window.__voxelDegraded`, `&voxelComposite=lite`, `&voxelDebug=1`
- [x] Measured against classic on the dev park (below)
- [x] Real hardware, one machine: Windows, Chrome, ANGLE/Direct3D 11, full composite (below)
- [ ] Real-hardware checklist, rest: Intel iGPU laptop; Mali and Adreno phones; the lite fallback on a real driver; Metal (Safari/macOS, iOS)
- [ ] Default-zoom and 6x gate misses (below): find the real default zoom at common screens and bring `zoom=1` to the zoom=2 cost
- [ ] Half-detail rendering when zoomed out
- [ ] Chunk sub-culling, and culling of figures, shadows and litter *(figures done 2026-10-14: the packer writes only
  the guests and staff inside the camera's view plus 3 cells (`FigurePacker.setCull`, `VoxelRenderer.cullFigures`); they
  keep their history off screen, so one walking back in interpolates on. Chunk sub-culling, contact shadows and litter
  are still drawn whole)*
- [ ] Figure level of detail at one texel per figure
- [ ] Night palette is too monochrome *(not changed 2026-10-14: `dayLook.test.ts` pins the presets because the player
  likes the night look as it is; a change is the owner's call)*
- [x] Overlay target resize *(done 2026-10-14: the overlay target is 1 x 1 while the overlay is empty and takes the
  low-res size when something is drawn (`VoxelGpu.setOverlayVisible` / `fitOverlay`); the light target is still full size)*
- [x] Scenario and Park Tour check under the voxel renderer *(done 2026-10-14: all ten scenarios start through the real
  UI on the voxel renderer with the right map, the objective panel and no console message (the Park Tour is retired).
  Fixed from it: a sustain objective's sentence said "for 0:00" (the snapshot carries the hold as
  `requiredSustainSeconds`), and a "reach" objective showed a straight-line pace ("12 of 20 · pace → 4249" parcels);
  the pace now shows on "earn" objectives only (`scenarioPanelQa.test.tsx`))*
- [ ] Static-texel cache so unchanged chunks are not re-rasterised
- [x] An in-game setting instead of the URL flag *(done 2026-10-14: Settings > Graphics, Renderer (Voxel / Classic)
  and Light and shading (Full / Lite composite); read at start, "Applies after a reload" with a Reload button; a URL
  `?renderer=` or `&voxelComposite=` still wins)*
- [ ] **Remove the classic renderer** once the real-hardware checklist above and the Phase 19 browser pass are done:
  delete `WorldRenderer` and the `classic*` modules, their tests and the static tests that gate them, keep the shared
  `RendererPort`, `worldInput`, `coasterTrain`, `seeThrough` and `viewRotation` models, and replace the fallback with an
  unsupported-GPU screen that offers the lite composite and `voxelGpu=min` before giving up. Until then the fallback
  paths stay tested as they are
- [x] Voxel is the default renderer. This was the project owner's decision after testing on one real Windows, Chrome and Direct3D 11 machine (see Measured); the hardware checks above stay open and now guard the default rather than an experiment, and the classic fallback is what protects a machine that fails them

### Measured (dev park, 1,000 guests, 1280x800, DPR 1, speed 1x)

SwiftShader (software GPU), headless Chromium, unminified dev build for the frame numbers, median of 3 runs, [min-max]. Classic is no-MSAA. Frame cost is `requestAnimationFrame` callback ms per frame (rAF) and CDP Task ms per frame, with the main thread throttled 1x, 6x and 12.2x.

| config | rAF 1x | rAF 6x | rAF 12.2x | Task 6x | Task 12.2x |
|---|---|---|---|---|---|
| classic | 6.60 | 44.5 [41.9-59.3] | 112.1 [110.8-126.2] | 52.4 | 135.5 |
| voxel zoom=2 | 2.50 | 9.28 [9.06-10.12] | 20.9 [18.9-21.4] | 16.9 | 39.9 |
| voxel zoom=1 | 2.31 | 15.5 [12.5-16.2] | 23.1 [21.7-25.0] | 26.4 | 39.9 |
| voxel zoom=2, `voxelGpu=min` | 0.78 | 5.04 [4.39-5.16] | 10.9 [9.9-11.4] | 8.68 | 18.6 |

- WebGL per frame at 1x: draws 986 classic, 15.2 voxel (max 17; 18, max 19 at zoom=1). Uploaded bytes 305 KB classic, 42.9 KB voxel (38.9 KB at zoom=1); 32.8 KB of that is texture rows. The first voxel frame uploads 676 KB once (16 chunks).
- Renderer main-thread self time at 1x (Pixi + WebGL + `src/rendering`): classic 3.3 ms strict (about 6 counting all Pixi chunks), voxel 0.91 ms (about 0.55 steady).
- Heap over 60 s, production build: classic 38-56 MB, 3.86 MB/s allocated; voxel 13-29 MB, 3.04 MB/s. Neither grows. Allocation is dominated by simulation and React in both.
- Frame rate under `voxelGpu=min`: 57.9 fps at 6x [49.9-59.4], 43.8 fps at 12.2x against 7.3 fps classic.
- Bundle: main chunk 748.6 kB raw / 218.3 kB gzip (baseline 746.3 / 214.7); lazy voxel chunk 204.1 kB / 71.1 kB, fetched only with the flag. First load on SwiftShader: canvas at about 1.5 s voxel against about 0.53 s classic.
- Scene (node probe): 14,554 static boxes in 16 chunks (budget 30,000 for the dev park), 1,051 dynamic, about 15,600 total.

**Gates.**

| gate | result |
|---|---|
| renderer main thread at 1x <= 1.0 ms | pass, thin margin (0.91) |
| draws per frame <= 30 | pass (15-19) |
| steady uploaded bytes <= 64 KB | pass (43 KB) |
| rAF 6x <= 8 ms | **fail** in default voxel (9.28, zoom=1 15.5); pass under `voxelGpu=min` (5.04) |
| rAF 12.2x <= 16 ms | **fail** in default voxel (20.9, zoom=1 23.1); pass under `voxelGpu=min` (10.9) |
| Task 6x <= 8 ms and 12.2x <= 16 ms | **fail**, including under `voxelGpu=min` at 12.2x (18.6) |
| `voxelGpu=min` >= 55 fps at 6x | pass on the median; one of 3 runs was 49.9 |
| `voxelGpu=min` >= 2x classic fps at 12.2x | pass (6.0x) |

**Real hardware (one Windows machine, Chrome, ANGLE/Direct3D 11, full composite).** Dev park, 1,000 guests, 1920x1080 viewport at 70% browser zoom, Chrome DevTools CPU throttling, read from the in-game performance overlay (its FPS is a smoothed average, so it can exceed the display rate on a fast monitor). The GPU model was not recorded.

| CPU throttling | FPS | RENDER ms |
|---|---|---|
| none | 61 | 0.3 |
| 4x | 62 | 1.5 |
| 6x | 63 | 1.8 |
| 12.2x (low-tier mobile preset) | 77 | 3.3 |
| 20x | 13 | 11.3 |

The 6x gate (at least 55 fps) is met on real hardware, and the voxel renderer holds the frame rate up to 12.2x; it only falls apart at 20x. This supports the reading that the SwiftShader rAF failures above were pessimistic. One machine and one GPU: it does not replace the checklist above.

**Caveats.** There is no real GPU and no Direct3D number: SwiftShader's rasteriser shares the CPU with the main thread, so the default-voxel rAF gates are probably pessimistic, but that is an inference from the `voxelGpu=min` difference, not a measurement. The machine ran about 20% slower than the earlier baseline, so the ratios (voxel rAF is 0.19-0.21x of classic) are safer than the absolutes. Runs vary (voxel 6x zoom=1 spread 12.5-16.2 ms); gl-stats and heap used one run per config; classic with MSAA was not re-run. Every voxel window has one 70-110 ms outlier frame, attributed to a lazy Pixi shader link that was not identified. Blueprint prewarm shows as about 16 frames of 4-18 ms in the first second, above its 4 ms budget. `zoom=1` is heavier than `zoom=2`; if the real default at 1280x800 is 1, the 6x and 12.2x gates miss by more. Visible boxes, texels rasterised and per-pass GPU time were not measured.

### Known limitations

Minor review findings left unfixed:

- Culling is per chunk only; figures, shadows and litter are always drawn.
- The light target is full size and always allocated (the overlay target is now 1 x 1 while empty); the overlay re-renders on every camera texel change and on each 400 ms bob step when non-empty.
- Scene allocation grows with guests (about 5.7 B per guest per frame), and the figures texture re-uploads every dirty row each frame.
- The shared index buffer is Uint32, 18 per box, and is respecified whole when it grows.
- The first placement of a heavy blueprint can hitch (cold compile 15-46 ms), and prewarm always compiles its first entry whatever the budget.
- The composite takes its full fetch count on silhouette texels.
- ~~Picking uses the ground diamond, but a path's top face is drawn 3 texels higher.~~ Fixed 2026-10-14: the voxel
  renderer re-picks 3 texels lower and takes that cell when it is a path (`refinePick`, an optional `bindWorldInput`
  argument; the classic renderer picks as before). Verified in headless Chromium (1 px sweep, views 0 and Q); the build and
  bulldozer preview diamond on a path now sits on the raised top too, and a window resize re-picks the cell under a still
  pointer.
- The startup self-test probes rgba8 and a flat vec4, not the formats and varyings the pipeline uses; drawing-buffer and viewport limits are only partly handled.
- ~~Degradation to the lite composite is silent for the player.~~ Fixed 2026-10-14: each new `__voxelDegraded` label is
  told once in a toast that names what went and points to Settings > Graphics (`app/alpha/degradationNotice.ts`).
- `src/game/performance.test.ts` can fail when the machine is loaded.

### See-through cutaway (building behind buildings)

Design: see `ARCHITECTURE.md` "See-through". Hold X to peek; automatic while a tool is armed.

- [x] Shared pure model `src/rendering/seeThrough.ts` (focus, fade, slew) with tests; `RendererPort.setSeeThrough?`
- [x] GameApp wiring: armed from tool and input context, hold-to-peek X (`planPeekKey`, released on keyup, blur, hidden page, lost capability), HelpHint text
- [x] Voxel renderer, dither rung: dithered cut of static chunks (`worldCut` program, no alpha blending), degrade label `no-seethrough`, also tried once for a failure that names no program; path drags and footprints wider than 6 cells open around the cursor cell only; static fxc guard for `worldCut`; documented in ARCHITECTURE.md. Its 1-texel screen door read as a mirror or moire pattern (user feedback), so it is now the fallback (`&voxelSeeThrough=dither`).
- [x] Voxel renderer, translucent rung (default, `&voxelSeeThrough=alpha|dither|off`): the occluders are faded to `SEE_THROUGH.OCCLUDER_OPACITY` (0.3, same constant as classic) through a small front G-buffer (`worldFront`), lit by `compositeFront` and mixed in the composite; rungs translucent -> dither (`no-translucent-seethrough`) -> off (`no-seethrough`). This knowingly relaxes "no alpha blending" for this effect only. Review fixes: the front layer has its own light pass (no lit/unlit seam at the rim at dusk and night) and is switched off where the main G-buffer holds something nearer (guests, litter in front of the faded building are no longer tinted); the `it.fails` KNOWN GAP test is now a real test.
  - Leftovers (voxel): not verified on a real Direct3D 11 GPU (compile of `worldFront`, `compositeFront` and the grown composite, cost of the second light pass and the extra front draws, depth-key precision); needs a look on a Windows machine. Guests, litter and shadows are not part of the faded layer (they are drawn crisp; those behind a faded building read through it, those in front are not tinted); the contact shadows of an occluder do not fade with it; the lite composite shows the dither rung.
- [x] Classic renderer: `ClassicSeeThrough` fades display objects in front of the focus to alpha 0.3 (pooled, searched only on focus change, instant under reduced motion, cleared on session swap and destroy, demolished object stays opaque). Tests `classicSeeThrough.test.ts`, `WorldRenderer.seeThrough.test.ts`; headless screenshots checked.
  - Leftovers (classic): boxes are cached at creation from the rest pose, so a ride whose machinery swings outside its rest box can fade a frame late or early at the edge; the whole object fades (including its plot tint), not a hole; a coaster track fades as one piece; guests behind a faded building are drawn as before, not specially revealed; the hint ring behind a building was not filmed in classic, only pinned by the layer-order test.

## Next vertical slices

- [x] Phase 2: entrance, guests, cached pathfinding, needs, leaving
- [x] Phase 3: queues, boarding, ride cycles, payments, inspector
- [x] Phase 4: food/drink/toilets, thoughts, satisfaction
- [x] Phase 5: finances, reputation, Park Pulse insights
- [x] Phase 6: litter, staff, condition, breakdowns
- [x] Phase 7: ride/service research, build unlocks, and scenery influence
- [x] Phase 8A: resettable park sessions, scenarios, objectives, and results
- [x] Phase 8B: Pulse Cards, loadouts, tradeoffs, and reward drafts
- [x] Phase 8C: branching Park Tour map and between-park progression
- [x] Phase 9: profile 1,000+ guests and optimize measured bottlenecks
- [x] Phase 10: simplified coaster prototype (built before the Phase 9 performance pass)

## Definition of done per phase

Lint, TypeScript, unit tests, and production build pass; the previous slice remains playable; new constants are centralized and important pure rules are tested.

## Future Candidates

Ideas worth keeping, none of them commitments. Nothing here is scheduled, and anything that grows
into a phase must first justify itself against the priority order — friction, readability,
feedback, persistence, balancing, content, new systems.

- Terrain elevation
- Water as buildable terrain
- More coaster piece types (banked turns, helices, brakes, block sections); the visual side of coasters is Phase 27
- Custom queue paths, separate from walkways
- Richer scenery theming, including themed zones that read as one place
- Marketing campaigns
- Seasons that change the look of the park and the weather mix (builds on Phase 20)
- Challenge modifiers for Sandbox
- Achievements
- Shareable park seeds
- In-game screenshots
- A mod architecture over the existing data-driven catalogs
- The Map extensions (Phase 23): a branching route (`nextLevelIndices`, the Park Tour's two-branch idea), limited retries or
  "continue with a penalty" as a challenge option, `pick N of M` offers, a separate run autosave slot, an "ironman" option
  that hides manual saves during a run, a queue-time objective family, the research-tree variant for unlocked buildings
  (with Phase 25)

## Explicitly not now

Deliberately out of scope. Listed so the question does not have to be re-argued.

- Multiplayer
- User accounts
- Cloud saves
- Full 3D gameplay (building, picking and the HUD on a free camera). A cinematic 3D camera on the same voxel data
  (menu shots, smooth view turns, ride-along) is planned as Phase 41 (owner request 2026-10-16)
- Supply chains
- Electrical grids
- Water pipes
- Advanced staff scheduling (shifts, rosters, patrol zones)
- A water park
- Terrain simulation (erosion, soil, drainage)
- Modular buildings assembled from parts
- Advanced coaster physics (g-forces, banking, friction models)
- A mod marketplace
