# Parksmith — Game Design

## Promise

Turn a quiet patch of green into a lively miniature park. Building is immediate; guests and finances make every layout choice matter. The first playable slice focuses on the tactile pleasure of sketching paths and placing colorful attractions without modal friction.

## First-session loop

1. Begin with $5,000 and an entrance on a 32×32 plot (the default Meadow Garden; Phase 24 adds six biomes and seven hand-made maps with other gates, natural obstacles that can be cleared for a price, and their own weather and climate: chosen under New park).
2. Drag a path into the park.
3. Place an attraction or service beside it.
4. Open the park, read the live Park Pulse, and expand.

Phase 0–1 proves camera feel and construction. Later slices add guests, queues, needs, operations, progression, and scenarios without replacing the same world model.

## Guest slice

An open park with a ride connected beside the entrance path attracts a steady stream of miniature guests. Each guest has a preferred intensity, hunger, thirst, toilet need, energy, a visit budget, a current thought, and a finite stay. They score only reachable destinations, walk the actual path network, use operational rides and services, and eventually return through the gate. Closing the park sends everyone home.

## Ride operation slice

Reachable rides now create real queues and dispatch on capacity or a short maximum wait. Guests pay only when they board, disappear into the moving attraction for its full cycle, then return to the path with satisfaction derived from preference fit, excitement, price, and their actual queue wait. A contextual inspector exposes the evidence needed to manage the ride while keeping pricing and open/close controls immediately accessible.

## Guest service slice

Hungry, thirsty, and uncomfortable guests compare reachable food stalls, drink stalls, and toilets against attractions using urgency, distance, wait, price, and recent visits. Services process one deterministic FIFO customer at a time, charge only after a final affordability check, relieve exactly their matching need, and feed price/wait/value back into happiness and satisfaction. Players can inspect, price, open, and close every service. Park Pulse groups repeated unmet needs and value complaints into concise live observations.

## Guest life slice (Phase 29)

Guests have lives between the rides. A tired guest walks to a free bench seat and sits until rested; a park without benches makes tired guests say so. On a lovely spot a guest stops to admire the scenery or takes a photo of a landmark, and a running ride draws a few onlookers. Intense rides unsettle stomachs, more for a guest who prefers gentler rides and more right after a meal: a queasy guest stops, avoids thrills and food for a while, and one still queasy after that is sick on the path, a mess the cleaners must clear and the passers-by mind. Every guest feels the weather: heat makes them fan themselves, thirsty and keen on cold treats; cold and night make them shiver and seek warm food and drinks; rain without an umbrella soaks them. They cheer after a great ride, eat and drink what they buy, stomp off from a queue that took too long and wave as they arrive.

Souvenir stalls sell keepsakes a guest carries for the rest of the visit: an umbrella that opens in the rain, a sun hat, a balloon (which sometimes slips away), a teddy and a glow wand that lights up the night. Demand follows the weather and the mood, never a need. The build dock filters its cards: rides by coasters, gentle, family and thrill; shops by food, drinks and souvenirs; scenery by theme.

## Park management slice

The management dashboard turns the running simulation into decisions without replacing the park view. Overview, finances, and activity tabs separate operating profit from construction and other cash movements, expose recent transactions and bounded trends, and summarize guests, happiness, queues, throughput, services, and unmet needs. Park rating is derived only from implemented evidence such as guest experience, value, accessibility, variety, and park size; stronger ratings increase organic arrivals. Park Pulse and threshold-based notifications explain notable changes and point to conditions the player can act on. The guest ceiling is visible: the Pulse shows "41 of 52 guests", and the Overview names its two inputs, ride seats and park rating (and why no one arrives when the gate is shut, paths are too few or no open ride is reachable); a park that sits at the ceiling says so.

Crowds are visible and have a cost (Phase 14). Every path tile carries a rolling count of the guests walking through it, shown as guests a minute on a crowd heatmap (quiet, normal, busy, severe bottleneck; voxel renderer) that the rail's Crowd flow toggle swaps with the scenery heatmap. In a park started since Phase 14, a path that carries more than about 400 guests a minute per lane slows the guests walking it (down to 0.6x), and a severe one makes the guests on it less happy and say "It's so crowded here."; below that nothing changes, so an ordinary park plays exactly as before, and parks saved earlier show the heatmap and the neighborhoods but never get the slowdown. There is no collision and no rerouting: guests still take the shortest way. The park divides itself into neighborhoods around its rides, each with a stable name from the biome, and the Neighborhoods tab lists their guests, needs, spending, litter, scenery, queues, demand and whether food, drink and a toilet are within reach; a row centres the camera on the place. Park Pulse describes a neighborhood ("Hawthorn Row has a bottleneck", "Willow Green has no toilet within reach") and never says what to build.

## Park operations slice

Completed food and drink purchases now create waste deterministically. A reachable Tidy Totem absorbs nearby waste until its capacity is full; otherwise the waste becomes visible litter on the path. Litter affects guests in its immediate area, lowering happiness and producing a readable cleanliness complaint rather than an invisible global penalty.

Cleaners and mechanics are hired through the operations view and walk the same versioned path network as guests. Cleaners reserve separate jobs, remove litter, and empty filling bins. Mechanics prioritize broken rides and also perform preventive inspections on worn attractions. Removed paths, bins, litter, rides, or staff assignments release their reservations and trigger deterministic route recovery, so operational work never depends on dangling targets.

Every ride has data-driven reliability and a condition value that wears down through completed operating cycles. Poor condition raises a deterministic failure chance, but a detected failure waits for the active cycle to finish safely before closing the ride and releasing its waiting queue. A broken ride accepts no new guests, earns no further revenue, and remains unavailable until a mechanic completes a repair. The player's chosen open or closed intent survives both breakdowns and maintenance.

Staff payroll and inspection or repair costs are typed operating expenses, making the choice between more coverage and higher overhead visible in operating profit. Cleanliness and ride reliability contribute directly to park rating and bounded management trends. The operations dashboard, ride inspector, world indicators, and threshold notifications connect visible litter, filling bins, moving staff, worn rides, and breakdowns to exact causes and available responses. Developer controls can force a selected breakdown for deterministic testing.

## Research and park appeal slice

Completed ride and service experiences produce research points from actual park activity rather than passive waiting. Research projects are purchased with both accumulated insight and cash, immediately unlock their catalog content, and remain data-driven so later scenarios and Pulse Cards can modify the same rules. Early projects offer a real branch between another ride, a faster food counter, and landmark scenery; advanced rides and facilities require earlier studies, while the Aurora Wheel also requires a proven park-rating milestone. Since Phase 16 the tree has 14 projects in three tiers, and every opener but Spin Studies forks at the second tier: Family Favorites into water or a temple ride, Express Service into guest flow or a refreshment lab, Garden Appeal into seaside, adventure or futuristic decoration. A new park prices research at ten times the base points, so the opening projects take a few minutes of real park activity each and the whole tree takes well over an hour; the first choice of opener is a real one. Parks saved before Phase 16 keep their old research prices.

Experience and rating milestones award research points once and always expose their exact progress; they are small findings ("Finding: +20 RP"), not a way to buy the tree. Research spending has its own finance category and is treated as park investment rather than ordinary operating profit. Locked catalog cards remain visible, carry a LOCKED badge, and name the research project that unlocks them; one click opens that project's research card, which marks which prerequisites and milestones are still missing. Since Phase 33 the catalog card itself states the project's exact terms on a second line ("300 RP · $300", "950 RP · $1,100 · after Vertical Motion · rating 60"). The simulation itself enforces every lock — `ProgressionSimulation` is the world's build access policy — so UI state or shortcuts cannot bypass progression.

Scenery now creates local appeal instead of acting as decoration-only content. Each scenery definition supplies an appeal value and Manhattan radius with distance falloff; overlapping sources stack to a capped score and update only when the world changes. Nearby appeal affects which rides and services guests choose and improves their completed-experience satisfaction, which then feeds happiness. The explicit scenery component of park rating is the average appeal over the footprints of the park's reachable rides and services (decorations beside a ride count whether or not a path runs past them); the average over entrance-connected path tiles is only the fallback for a park with no destinations, and only the guests' walking happiness depends on decoration along the paths. A heatmap, placement preview, build-card values, and inspector evidence make the effect readable before and after construction. Rides, stalls and scenery carry one of five themes (garden, carnival, seaside, adventure, futuristic), and a themed ride or stall gains a small, capped extra score (at most +10) from same-theme scenery whose radius reaches it; the build card, the placement preview and the inspector say how much, and no objective or card ever requires a theme. Parks saved before Phase 16 have theme matching off.

## Modes: Sandbox, Scenario, The Map

The game has three ways to play, all on the same simulation. **Sandbox** has no objectives or card modifiers. **Scenario** is a browsable list of hand-made parks, each with one objective, a difficulty and a lasting reward (an unlocked building or a small permanent bonus). **The Map** is the roguelite mode and the default: a run of generated parks in different biomes played with a deck of cards that are used up. The hand-made Park Tour is retired; its four parks live on as scenarios (Sunny Start, Penny Lane, Garden Gala, Starlight Finale). A brand-new player lands in the Sandbox First Day park, and the game offers The Map once the park is stable. Progress that outlives a run is **discovered cards, unlocked buildings and difficulties, and small bounded bonuses**, never raw power; every card and bonus is an alternative or a small, listed edge, and no scenario or level may require a specific card, unlock or bonus.

### The Map: a run

1. **Start a run** from the main menu: a seed (or a random one) and a difficulty (Relaxed, Standard, or Tough once a Standard run has been won). The same seed and difficulty always make the same run: the same levels, objectives, conditions, starter deck and offers.
2. A run is **five levels**, cleared in order, one generated park each: Meadow first, then four distinct biomes. The run map shows them as a path with their biome, objective, conditions and card slots; nothing is hidden.
3. You start with **three cards**. **Before every level, two cards are offered and all of them join your deck.** Every card shows its upside and its downside, and an offer says when a card will do nothing on part of the road (a rain card before a desert level) or takes two slots.
4. **Before every level you choose cards from the deck** as that level's loadout (one slot on the first levels, up to three on the last; a rare card takes two). **Stage cards are used up when the level starts**; a one-shot is used up when you play it during the level and comes back to your deck if you never do. Playing fewer cards keeps them for later. You may play none.
5. **Play the level** like any scenario park: build and manage it while Park Pulse shows the objective (visitors, profit, crowd or spirits, scaled by level and difficulty: crowd opens the run on the first two levels, spirits asks for longer holds as the run goes on, and the last level asks for visitors or profit) and the level's conditions (small, stated rule changes such as dearer timber or slower service).
6. **Clear it** and you return to the run map for the next offer. **Fail it** (the deadline passes) and the run is over: the screen shows how far you got and what you learned, and "Try this seed again" starts the same run from the beginning. There are no retries inside a run and no run currency.
7. **Clear the last level** and you win: every card that joined your deck is discovered for good (so it can show up in later runs and in Scenario mode), and the first Standard or Tough win opens Tough.

**Difficulty.** Relaxed gives room to breathe: the first release's deadlines and targets. Standard has shorter deadlines (9.25 park days for the whole run instead of 10.5), higher targets and a little less cash. Tough keeps Standard's deadlines and targets and adds a condition from level 2, a busier map, a cash squeeze and a longer, higher spirits hold: harder, not longer. No level ever requires a card (a scripted player with no card clears every level at every difficulty); on Tough the cards are what make it comfortable. The numbers are provisional until the first playtest of the retuned table (BALANCE_NOTES, Phase 25).

Between levels the park behind the run screens is a frozen backdrop; inside a level undo works as always and never touches the deck. A run is saved with the park: it is continued after a reload or a crash exactly like a park, from the main menu's Continue or The Map's Continue run. Leaving an unfinished run for another park asks first, because the autosave is the one place the run lives; that includes starting a new run or park from the start screen while the autosave still holds an unfinished run.

### Pulse Cards

Cards are the choices of a run (and of a Scenario loadout). There are 48, in eight families built on systems the park already has: weather, day and night, arrivals, cleanliness and staff, rides and coasters, economy and pricing, scenery, and build.

- **Stage cards** change the park's rules for the whole level (guests arrive faster but carry less money; rides break down less but staff cost more). They are locked in when the level starts and their combined effect is shown before play.
- **One-shot cards** sit in a loadout slot and are played from Park Pulse whenever you choose during the level: a loan, a coach party of twenty guests, a park-wide sweep, a sunny forecast, an inspection, a burst of fireworks. Each has its price on the card (a fee now, happiness lost, or a cost due later). A played one-shot is used up; one you never play goes back to your deck. A later cost still unpaid when the level ends comes off the next level's starting cash (never below zero); whatever is unpaid after the last level is forgiven, and the result screen says how much. One-shots are played on The Map only; Scenario loadouts and drafts offer stage cards.
- **Rarity** (common, uncommon, rare) changes how often a card is offered and how many slots it takes, nothing else: uncommon cards appear from level 2, rare ones from level 3 and take two slots, because a rare is two trades in one card. No card is strictly better than another.

Objectives use simulation evidence and simulation time, so pausing never consumes a deadline. Examples include reaching a simultaneous guest target, earning a required operating profit before a deadline, sustaining rating and happiness, or completing visits while keeping queues below a limit. Each park has one required primary objective and at most one clearly stated constraint.

Every Pulse Card has at least one explicit upside and one meaningful downside. Cards change decisions rather than giving unconditional permanent power; stage cards remain locked during a park and expose their combined effects before play begins. Initial examples include:

- **Grand Opening:** organic arrivals increase, but arriving guests carry less money.
- **Local Contractors:** construction costs fall, but ride operating costs rise.
- **Quick Turnaround:** rides dispatch sooner, but every cycle costs more.
- **Hungry Tourists:** guests tolerate higher food and drink prices, but their needs grow faster.

Offers and rewards are seeded and duplicate-protected, weighted by rarity, and never hold two cards that cancel each other or a card that would do nothing in every biome still ahead. In Scenario mode a clear drafts one of three stage cards, from different families where it can, into your collection; in The Map the offers fill the run's deck and a victory discovers them for good. Wider strategic choice is the meta-progression; newly discovered cards should be alternatives rather than stronger tiers.

In Scenario mode failure returns to the loadout screen, resets the park with the same seed, and grants no reward. In The Map failure ends the run (no retries in this version; a later challenge option may add limited retries or a penalty). This keeps each park a distinct challenge while the run stays short enough to try again.

Card effects compose in a fixed order: base rules, the biome, scenario rules (a level's conditions included), permanent bonuses, selected cards, then safety clamps. They modify a typed per-run ruleset and never mutate shared catalog data. Both sides of every active card, objective progress, and the exact reason for success or failure must remain visible through Park Pulse.

## Original identity

- **Park Pulse:** a small, calm feed that turns simulation evidence into actionable observations.
- **Readable neighborhoods:** the park forms named pockets around its rides ("Willow Green", "Meadow Gate"), derived from attraction clusters and the path network and never painted by the player; local flow, needs, service reach and appeal are management inputs, read in the Neighborhoods tab, on the crowd heatmap and in Park Pulse (Phase 14).
- **Feedback you can feel (Phase 15):** money you spend or get back pops where it happened and the cash pill counts to its new value; rides, stalls and guests show small, sampled cues; six volume sliders mix the synthesised music, ambience (louder with more guests and rides in view, closer in) and cues, and nothing sounds before your first click.
- **Land as a decision (Phase 21):** on an estate (Meadow Estate, 64 x 64) the park owns the lawn by the gate and the rest is for sale in 8 x 8 parcels next to owned land. Land is dimmed and fenced until bought, its price is always on hover, the price grows with the land owned and is higher by the gate, and land is never sold back. The classic 32 x 32 maps are wholly owned.
- **Sketch-to-build:** paths paint continuously while dragging, with one running cost preview per gesture. Every construction gesture, demolition included, can be undone with `Ctrl+Z` or the dock's *Undo* control. Undo rewinds the **whole park** to just before the gesture — buildings, guests, cash, research and the simulation clock — from a ring of the last 20 snapshots, so a demolished ride comes back with its ticket price, open/closed state and history. Because that gives back real progress, the control says how much: "Undo · rewinds 42 s", and a rewind longer than a minute needs a second press. There is no redo, a scenario result closes the ring, and the profile and the run are never rewound. A ride or stall can also be demolished from its inspector (or with `Delete`), after a confirmation. Because one track cell removes a whole coaster, the bulldozer asks for two clicks on a coaster, and a bulldozer drag never removes one.

## Rules for clarity

- A valid placement is mint; invalid is coral.
- Costs appear before committing, in the ghost preview and the cursor readout, and every committed spend is confirmed by a toast. Money changes are animated (Phase 15): a money popup rises where the spend or gain happened, and the cash pill counts to its new value (450 ms, ease-out) and shows a rising delta chip for a change of $25 or more; under reduced motion the number jumps and the chip only fades.
- The world shows problems first; panels explain details second.
- Statistics exist only when they affect a player decision.

## Phase 1 content

Paths, four original flat rides, two stalls, a comfort station, benches, bins, trees, flower beds, lamps, and fountains. Attractions have data-ready footprints and operating statistics, though full operation begins in later phases.

Phase 16 widened the catalog without changing any existing number: three rides (Puddle Jumpers, the smallest and cheapest; Rocket Pendulum, a thrill ride available from the first minute; Temple Trek, a covered family dark ride), two stalls (Pretzel Pram, cheap warm food; Coconut Cove, a slow premium drink) and seven themed scenery pieces. Each theme has its own character in numbers: garden is the best appeal per dollar at a short radius, carnival is cheap and wide, seaside has the widest landmark (the Harbor Lighthouse), adventure pairs a cheap ring with a strong focal piece, and futuristic has the widest small radius and the strongest landmark (the Orbit Globe). The first park has garden and carnival scenery free; the other three themes are researched.
