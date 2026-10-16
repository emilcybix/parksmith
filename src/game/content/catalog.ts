import type { BuildDefinition } from '../types';

export const BUILD_CATALOG: readonly BuildDefinition[] = [
  {
    id: 'sunstone-path', name: 'Sunstone path', kind: 'path', category: 'paths', icon: '◇',
    description: 'A bright, guest-ready walkway. Drag to sketch.', buildCost: 12, footprint: [1, 1], color: 0xf2d79c, accent: 0xfff0c8,
  },
  {
    id: 'petal-roundabout', name: 'Petal Roundabout', kind: 'ride', category: 'rides', icon: '✦', theme: 'garden',
    description: 'A gentle orbit beneath a striped canopy.', buildCost: 1_150, footprint: [3, 3], color: 0xef6f8f, accent: 0xffd166,
    stats: { capacity: 12, duration: 38, excitement: 32, intensity: 18, runningCost: 6, ticketPrice: 4, reliability: 96 },
    openAir: false,
  },
  {
    id: 'comet-cups', name: 'Comet Cups', kind: 'ride', category: 'rides', icon: '◎', theme: 'carnival',
    description: 'Spinning cups with just enough mischief.', buildCost: 1_750, footprint: [3, 3], color: 0x8f7cf7, accent: 0x61e7d3,
    stats: { capacity: 16, duration: 42, excitement: 49, intensity: 38, runningCost: 9, ticketPrice: 5.5, reliability: 92 },
  },
  {
    id: 'cloud-hopper', name: 'Cloud Hopper', kind: 'ride', category: 'rides', icon: '↟', theme: 'futuristic',
    description: 'A compact tower with a buoyant drop.', buildCost: 2_850, footprint: [3, 3], color: 0x53b7e8, accent: 0xffd166,
    stats: { capacity: 10, duration: 34, excitement: 68, intensity: 61, runningCost: 13, ticketPrice: 7.5, reliability: 86 },
  },
  {
    id: 'aurora-wheel', name: 'Aurora Wheel', kind: 'ride', category: 'rides', icon: '◉', theme: 'futuristic',
    description: 'A glowing skyline landmark for every age.', buildCost: 4_200, footprint: [4, 3], color: 0x36c99f, accent: 0xf5f06c,
    stats: { capacity: 24, duration: 65, excitement: 46, intensity: 12, runningCost: 16, ticketPrice: 6, reliability: 94 },
  },
  {
    id: 'moonpetal-carousel', name: 'Moonpetal Carousel', kind: 'ride', category: 'rides', icon: '❀', theme: 'carnival',
    description: 'A slow, glittering classic for every age.', buildCost: 900, footprint: [3, 3], color: 0xd977b8, accent: 0xfff0c8,
    stats: { capacity: 14, duration: 40, excitement: 26, intensity: 10, runningCost: 5, ticketPrice: 3.5, reliability: 97 },
    openAir: false,
  },
  {
    id: 'bumble-coach', name: 'Bumble Coach', kind: 'ride', category: 'rides', icon: '➾', theme: 'garden',
    description: 'A gentle striped train that tours the lawns.', buildCost: 1_300, footprint: [4, 2], color: 0xe8b23a, accent: 0x2b2d42,
    stats: { capacity: 16, duration: 55, excitement: 30, intensity: 14, runningCost: 7, ticketPrice: 4, reliability: 95 },
  },
  {
    id: 'harbor-swings', name: 'Harbor Swings', kind: 'ride', category: 'rides', icon: '⌔', theme: 'seaside',
    description: 'Chair swings that lean into the sea breeze.', buildCost: 1_600, footprint: [3, 3], color: 0x4c9fd4, accent: 0xffd166,
    stats: { capacity: 14, duration: 40, excitement: 44, intensity: 42, runningCost: 8, ticketPrice: 5, reliability: 91 },
  },
  {
    id: 'splash-rings', name: 'Splash Rings', kind: 'ride', category: 'rides', icon: '◍', theme: 'seaside',
    description: 'Round boats bump through a splashing channel.', buildCost: 2_200, footprint: [4, 3], color: 0x3aa7a3, accent: 0xbde0fe,
    stats: { capacity: 12, duration: 50, excitement: 55, intensity: 48, runningCost: 11, ticketPrice: 6, reliability: 88 },
  },
  {
    id: 'gale-spinner', name: 'Gale Spinner', kind: 'ride', category: 'rides', icon: '๑', theme: 'futuristic',
    description: 'Twin arms that whip riders through the wind.', buildCost: 2_600, footprint: [3, 3], color: 0x9557d1, accent: 0x61e7d3,
    stats: { capacity: 8, duration: 36, excitement: 66, intensity: 72, runningCost: 12, ticketPrice: 7, reliability: 84 },
  },
  {
    id: 'thunder-drum', name: 'Thunder Drum', kind: 'ride', category: 'rides', icon: '◉', theme: 'carnival',
    description: 'A pounding rotor drum for real thrill seekers.', buildCost: 3_400, footprint: [3, 3], color: 0xc0392b, accent: 0xf5f06c,
    stats: { capacity: 10, duration: 30, excitement: 74, intensity: 86, runningCost: 15, ticketPrice: 8.5, reliability: 80 },
    openAir: false,
  },
  {
    id: 'comet-trail', name: 'Comet Trail', kind: 'ride', category: 'rides', icon: '∿', custom: 'coaster',
    description: 'A friendly starter coaster. Hills up to level 2.', buildCost: 400, footprint: [1, 1], color: 0xe4572e, accent: 0xffd166,
  },
  {
    id: 'star-chaser', name: 'Star Chaser', kind: 'ride', category: 'rides', icon: '☄', custom: 'coaster',
    description: 'Taller hills up to level 3 — and vertical loops.', buildCost: 550, footprint: [1, 1], color: 0x7048c9, accent: 0x61e7d3,
  },
  {
    id: 'skyline-serpent', name: 'Skyline Serpent', kind: 'ride', category: 'rides', icon: '༄', custom: 'coaster',
    description: 'The full toolkit: level 4 summits, loops, and launch boosts.', buildCost: 750, footprint: [1, 1], color: 0x1b7f79, accent: 0xf5f06c,
  },
  {
    id: 'picnic-pocket', name: 'Picnic Pocket', kind: 'shop', category: 'shops', icon: '▰', theme: 'garden',
    description: 'Warm snacks packed for wandering.', buildCost: 480, footprint: [2, 2], color: 0xf59e55, accent: 0xffe2a8,
    stats: { serviceType: 'food', serviceDuration: 3.2, needRelief: 62, itemPrice: 7 },
    serves: 'warm',
  },
  {
    id: 'fizz-foundry', name: 'Fizz Foundry', kind: 'shop', category: 'shops', icon: '◒', theme: 'carnival',
    description: 'Cold sparkling drinks in bright cups.', buildCost: 420, footprint: [2, 2], color: 0x48bfe3, accent: 0xd5f6ff,
    stats: { serviceType: 'drink', serviceDuration: 2.4, needRelief: 68, itemPrice: 4.5 },
    serves: 'cold',
  },
  {
    id: 'glacier-scoop', name: 'Glacier Scoop', kind: 'shop', category: 'shops', icon: '❅', theme: 'seaside',
    description: 'Cold scoops that cheer more than they fill.', buildCost: 520, footprint: [2, 2], color: 0x7fc8e8, accent: 0xfff0f5,
    stats: { serviceType: 'food', serviceDuration: 2.6, needRelief: 45, itemPrice: 4.5 },
    serves: 'cold',
  },
  {
    id: 'lemon-light', name: 'Lemon Light', kind: 'shop', category: 'shops', icon: '◓', theme: 'seaside',
    description: 'Fresh-pressed lemonade under a striped shade.', buildCost: 480, footprint: [2, 2], color: 0xe8d44d, accent: 0xd5f6ff,
    stats: { serviceType: 'drink', serviceDuration: 2.2, needRelief: 60, itemPrice: 5.5 },
    serves: 'cold',
  },
  {
    id: 'waffle-windmill', name: 'Waffle Windmill', kind: 'shop', category: 'shops', icon: '◈', theme: 'garden',
    description: 'Hearty waffles worth queueing for.', buildCost: 850, footprint: [2, 2], color: 0xb9743c, accent: 0xffe2a8,
    stats: { serviceType: 'food', serviceDuration: 3.6, needRelief: 75, itemPrice: 9 },
    serves: 'warm',
  },
  {
    id: 'snack-sprint', name: 'Snack Sprint', kind: 'shop', category: 'shops', icon: '▱', theme: 'carnival',
    description: 'Fast, affordable bites with lighter relief.', buildCost: 700, footprint: [2, 1], color: 0xf6b34f, accent: 0xfff0b8,
    stats: { serviceType: 'food', serviceDuration: 1.8, needRelief: 42, itemPrice: 5.5 },
  },
  {
    id: 'comfort-cabin', name: 'Comfort Cabin', kind: 'facility', category: 'facilities', icon: '▣',
    description: 'Clean, compact guest facilities.', buildCost: 650, footprint: [2, 2], color: 0x5a9b8f, accent: 0xe4fff7,
    stats: { serviceType: 'toilet', serviceDuration: 4.5, needRelief: 100, itemPrice: 1 },
  },
  {
    id: 'comfort-pavilion', name: 'Comfort Pavilion', kind: 'facility', category: 'facilities', icon: '▦',
    description: 'A larger high-throughput comfort stop.', buildCost: 1_250, footprint: [3, 2], color: 0x4f8f86, accent: 0xcdf8ec,
    stats: { serviceType: 'toilet', serviceDuration: 2.6, needRelief: 100, itemPrice: 1.5 },
  },
  {
    id: 'ribbon-bench', clearanceLevels: 1, name: 'Ribbon Bench', kind: 'amenity', category: 'comforts', icon: '⌑',
    description: 'A cheerful place to recharge.', buildCost: 55, footprint: [1, 1], color: 0xb96748, accent: 0xffd166,
  },
  {
    id: 'tidy-totem', clearanceLevels: 1, name: 'Tidy Totem', kind: 'amenity', category: 'comforts', icon: '▥',
    description: 'A bin guests can spot from afar.', buildCost: 45, footprint: [1, 1], color: 0x48786b, accent: 0x8ee3c5,
    stats: { amenityType: 'bin', binCapacity: 10 },
  },
  {
    id: 'lollipop-lamp', clearanceLevels: 3, name: 'Lollipop Lamp', kind: 'scenery', category: 'scenery', icon: '♧', theme: 'carnival',
    description: 'A warm pool of light after dusk.', buildCost: 35, footprint: [1, 1], color: 0x335c67, accent: 0xffe66d,
    stats: { sceneryAppeal: 8, sceneryRadius: 3 },
  },
  {
    id: 'confetti-tree', name: 'Confetti Tree', kind: 'scenery', category: 'scenery', icon: '♣', theme: 'garden',
    description: 'A compact tree with a candy-colored crown.', buildCost: 70, footprint: [1, 1], color: 0x2f855a, accent: 0xf687b3,
    stats: { sceneryAppeal: 18, sceneryRadius: 4 },
  },
  {
    id: 'sunburst-flowers', clearanceLevels: 1, name: 'Sunburst Flowers', kind: 'scenery', category: 'scenery', icon: '✿', theme: 'garden',
    description: 'A pocket of bright, low flowers.', buildCost: 28, footprint: [1, 1], color: 0x52b788, accent: 0xffcf56,
    stats: { sceneryAppeal: 10, sceneryRadius: 3 },
  },
  {
    id: 'ripple-fountain', clearanceLevels: 3, name: 'Ripple Fountain', kind: 'scenery', category: 'scenery', icon: '≋', theme: 'garden',
    description: 'A cool blue centerpiece for a small plaza.', buildCost: 380, footprint: [2, 2], color: 0x4ea8de, accent: 0xbde0fe,
    stats: { sceneryAppeal: 35, sceneryRadius: 5 },
  },
  // Phase 22: profile-gated entries (scenario rewards). They reuse existing catalog colours, so the voxel palette
  // does not grow. They are APPENDED so every id keeps its place; no research project exists for them.
  {
    id: 'tiki-tumbler', name: 'Tiki Tumbler', kind: 'ride', category: 'rides', icon: '۩', theme: 'adventure',
    description: 'Carved tiki tubs spin around a thatched totem.', buildCost: 1_900, footprint: [3, 3], color: 0xb96748, accent: 0x61e7d3,
    stats: { capacity: 12, duration: 44, excitement: 52, intensity: 44, runningCost: 10, ticketPrice: 5.5, reliability: 89 },
    profileGate: true,
  },
  {
    id: 'cactus-cooler', name: 'Cactus Cooler', kind: 'shop', category: 'shops', icon: '⧖', theme: 'adventure',
    description: 'Prickly-pear coolers from a cactus-shaded cart.', buildCost: 560, footprint: [2, 1], color: 0x2f855a, accent: 0xf687b3,
    stats: { serviceType: 'drink', serviceDuration: 2.0, needRelief: 62, itemPrice: 5 },
    serves: 'cold', profileGate: true,
  },
  {
    id: 'cocoa-chalet', name: 'Cocoa Chalet', kind: 'shop', category: 'shops', icon: '♨', theme: 'carnival',
    description: 'Hot cocoa and pretzels by a crackling stove.', buildCost: 720, footprint: [2, 2], color: 0xc0392b, accent: 0xfff0f5,
    stats: { serviceType: 'food', serviceDuration: 3.4, needRelief: 70, itemPrice: 8 },
    serves: 'warm', profileGate: true,
  },
  {
    id: 'lantern-maple', name: 'Lantern Maple', kind: 'scenery', category: 'scenery', icon: '♠', theme: 'carnival',
    description: 'A red maple strung with paper lanterns.', buildCost: 95, footprint: [1, 1], color: 0xe4572e, accent: 0xffd166,
    stats: { sceneryAppeal: 22, sceneryRadius: 4 },
    profileGate: true,
  },
  // Phase 16: content and balance pass 2. APPENDED so every id keeps its place and grant ordering stays valid; every
  // colour is an existing catalog hex, so the voxel palette does not grow.
  {
    id: 'puddle-jumpers', name: 'Puddle Jumpers', kind: 'ride', category: 'rides', icon: '⊙', theme: 'garden',
    description: 'Little frog pods that hop over a lily pond.', buildCost: 650, footprint: [2, 2], color: 0x52b788, accent: 0xffcf56,
    stats: { capacity: 8, duration: 30, excitement: 20, intensity: 6, runningCost: 3, ticketPrice: 2.5, reliability: 99 },
  },
  {
    id: 'rocket-pendulum', name: 'Rocket Pendulum', kind: 'ride', category: 'rides', icon: '⟁', theme: 'futuristic',
    description: 'A rocket gondola that swings ever higher.', buildCost: 2_400, footprint: [3, 3], color: 0x7048c9, accent: 0x61e7d3,
    stats: { capacity: 12, duration: 36, excitement: 64, intensity: 70, runningCost: 15, ticketPrice: 7, reliability: 80 },
  },
  {
    id: 'temple-trek', name: 'Temple Trek', kind: 'ride', category: 'rides', icon: '⌂', theme: 'adventure',
    description: 'A covered cart ride through a torchlit lost temple.', buildCost: 2_600, footprint: [4, 3], color: 0xb96748, accent: 0xffd166,
    stats: { capacity: 20, duration: 60, excitement: 42, intensity: 24, runningCost: 11, ticketPrice: 5.5, reliability: 93 },
    openAir: false,
  },
  {
    id: 'pretzel-pram', name: 'Pretzel Pram', kind: 'shop', category: 'shops', icon: '∞', theme: 'carnival',
    description: 'Warm salted pretzels from a quick little pram.', buildCost: 360, footprint: [2, 1], color: 0xb9743c, accent: 0xffe2a8,
    stats: { serviceType: 'food', serviceDuration: 2.4, needRelief: 48, itemPrice: 3.5 },
    serves: 'warm',
  },
  {
    id: 'coconut-cove', name: 'Coconut Cove', kind: 'shop', category: 'shops', icon: '◔', theme: 'seaside',
    description: 'Slow, chilled coconut coolers that truly quench.', buildCost: 640, footprint: [2, 2], color: 0x3aa7a3, accent: 0xbde0fe,
    stats: { serviceType: 'drink', serviceDuration: 3.0, needRelief: 85, itemPrice: 6.0 },
    serves: 'cold',
  },
  {
    id: 'bunting-mast', name: 'Bunting Mast', kind: 'scenery', category: 'scenery', icon: '▽', theme: 'carnival',
    description: 'A tall mast strung with festive bunting.', buildCost: 32, footprint: [1, 1], color: 0xef6f8f, accent: 0xffd166,
    stats: { sceneryAppeal: 7, sceneryRadius: 4 },
  },
  {
    id: 'shell-planter', clearanceLevels: 1, name: 'Shell Planter', kind: 'scenery', category: 'scenery', icon: '⌓', theme: 'seaside',
    description: 'Sea pinks spilling from a giant scallop shell.', buildCost: 45, footprint: [1, 1], color: 0x7fc8e8, accent: 0xfff0f5,
    stats: { sceneryAppeal: 12, sceneryRadius: 3 },
  },
  {
    id: 'harbor-lighthouse', name: 'Harbor Lighthouse', kind: 'scenery', category: 'scenery', icon: '♜', theme: 'seaside',
    description: 'A striped lighthouse whose lamp sweeps the park.', buildCost: 520, footprint: [2, 2], color: 0x4c9fd4, accent: 0xfff0c8,
    stats: { sceneryAppeal: 30, sceneryRadius: 7 },
  },
  {
    id: 'tiki-torch', clearanceLevels: 3, name: 'Tiki Torch', kind: 'scenery', category: 'scenery', icon: '♆', theme: 'adventure',
    description: 'A carved torch that flickers along the trail.', buildCost: 38, footprint: [1, 1], color: 0xe4572e, accent: 0xffd166,
    stats: { sceneryAppeal: 9, sceneryRadius: 4 },
  },
  {
    id: 'jungle-idol', clearanceLevels: 2, name: 'Jungle Idol', kind: 'scenery', category: 'scenery', icon: '۞', theme: 'adventure',
    description: 'A mossy stone idol with glowing jade eyes.', buildCost: 80, footprint: [1, 1], color: 0x48786b, accent: 0x8ee3c5,
    stats: { sceneryAppeal: 20, sceneryRadius: 3 },
  },
  {
    id: 'neon-pylon', name: 'Neon Pylon', kind: 'scenery', category: 'scenery', icon: '‡', theme: 'futuristic',
    description: 'A slim pylon whose neon glow carries far.', buildCost: 55, footprint: [1, 1], color: 0x1b7f79, accent: 0x61e7d3,
    stats: { sceneryAppeal: 6, sceneryRadius: 6 },
  },
  {
    id: 'orbit-globe', name: 'Orbit Globe', kind: 'scenery', category: 'scenery', icon: '⊕', theme: 'futuristic',
    description: 'A great ringed globe that slowly turns overhead.', buildCost: 600, footprint: [2, 2], color: 0x8f7cf7, accent: 0x61e7d3,
    stats: { sceneryAppeal: 40, sceneryRadius: 5 },
  },
  // Phase 29: guest life and souvenirs. APPENDED so every id keeps its place; every colour is an existing catalog hex, so
  // the voxel palette does not grow. Souvenir stalls meet no need: guests buy a keepsake for the weather or the mood.
  {
    id: 'brolly-booth', name: 'Brolly Booth', kind: 'shop', category: 'shops', icon: '☂', theme: 'seaside',
    description: 'Bright umbrellas that keep the rain off.', buildCost: 520, footprint: [2, 1], color: 0x4c9fd4, accent: 0xfff0c8,
    stats: { serviceType: 'souvenir', souvenir: 'umbrella', serviceDuration: 2.2, needRelief: 0, itemPrice: 6 },
  },
  {
    id: 'hat-hutch', name: 'Hat Hutch', kind: 'shop', category: 'shops', icon: '⌒', theme: 'garden',
    description: 'Wide straw sun hats for the hottest days.', buildCost: 480, footprint: [2, 1], color: 0xe8b23a, accent: 0xfff0c8,
    stats: { serviceType: 'souvenir', souvenir: 'hat', serviceDuration: 2.0, needRelief: 0, itemPrice: 5 },
  },
  {
    id: 'balloon-bouquet', name: 'Balloon Bouquet', kind: 'shop', category: 'shops', icon: '⚬', theme: 'carnival',
    description: 'Cheerful balloons. Hold on tight!', buildCost: 380, footprint: [2, 1], color: 0xef6f8f, accent: 0xffd166,
    stats: { serviceType: 'souvenir', souvenir: 'balloon', serviceDuration: 1.6, needRelief: 0, itemPrice: 3 },
  },
  {
    id: 'plushie-parlour', name: 'Plushie Parlour', kind: 'shop', category: 'shops', icon: 'ʘ', theme: 'carnival',
    description: 'Cuddly bears that make any day better.', buildCost: 760, footprint: [2, 2], color: 0xd977b8, accent: 0xfff0c8,
    stats: { serviceType: 'souvenir', souvenir: 'plush', serviceDuration: 2.8, needRelief: 0, itemPrice: 8 },
  },
  {
    id: 'glow-cart', name: 'Glow Cart', kind: 'shop', category: 'shops', icon: '✧', theme: 'futuristic',
    description: 'Glow wands that light up the night.', buildCost: 440, footprint: [2, 1], color: 0x8f7cf7, accent: 0x61e7d3,
    stats: { serviceType: 'souvenir', souvenir: 'glowWand', serviceDuration: 1.8, needRelief: 0, itemPrice: 4 },
  },
  {
    id: 'bean-barrow', name: 'Bean Barrow', kind: 'shop', category: 'shops', icon: '☕', theme: 'garden',
    description: 'Hot coffee and cocoa that warm cold hands.', buildCost: 460, footprint: [2, 1], color: 0xb9743c, accent: 0xfff0f5,
    stats: { serviceType: 'drink', serviceDuration: 2.6, needRelief: 55, itemPrice: 4.5 },
    serves: 'warm',
  },
  // Phase 39: the first coaster families after steel (wild mouse, wooden), APPENDED like Phase 16's and 29's entries.
  {
    id: 'whisker-mouse', name: 'Whisker Mouse', kind: 'ride', category: 'rides', icon: 'ಎ', custom: 'coaster',
    description: 'A wild mouse: short two-car trains, tight flat turns, hills up to level 3. Small and cheap.', buildCost: 300, footprint: [1, 1], color: 0x4c9fd4, accent: 0xef6f8f,
  },
  {
    id: 'timber-twister', name: 'Timber Twister', kind: 'ride', category: 'rides', icon: '⋕', custom: 'coaster',
    description: 'A wooden coaster: rattling drops and airtime hills up to level 3, no loops. Wears faster.', buildCost: 450, footprint: [1, 1], color: 0xc0392b, accent: 0xffd166,
  },
  {
    id: 'thunder-launch', name: 'Thunder Launch', kind: 'ride', category: 'rides', icon: '⚡', custom: 'coaster',
    description: 'A launch coaster: no chain lift, a launch fires the train up a top hat to level 5.', buildCost: 900, footprint: [1, 1], color: 0x9557d1, accent: 0xf5f06c,
  },
] as const;

/** Phase 29: the entries appended for guest life and souvenirs (five souvenir stalls and the warm drink barrow), in order. */
export const PHASE29_DEFINITION_IDS: readonly string[] = ['brolly-booth', 'hat-hutch', 'balloon-bouquet', 'plushie-parlour', 'glow-cart', 'bean-barrow'];
/** Phase 39: the coaster families' catalog cards, appended last. */
export const PHASE39_DEFINITION_IDS: readonly string[] = ['whisker-mouse', 'timber-twister', 'thunder-launch'];

export const BUILD_BY_ID = new Map(BUILD_CATALOG.map((definition) => [definition.id, definition]));
