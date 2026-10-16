import type { PropKindId } from '../../../game/maps/props';
import type { CoasterContent, LitterEmitter, ObjectContent, PropContent } from '../contracts/content';
import { ribbonBench, tidyTotem } from './amenities';
import { moonpetalCarousel } from './carousel';
import { coasterContent } from './coaster';
import { cloudHopper } from './dropTower';
import { entranceBlueprint } from './entrance';
import { genericRide } from './genericRide';
import { kiosk } from './kiosk';
import { litterEmitter } from './litter';
import { placeholderContent, placeholderProp } from './placeholder';
import { PROP_CONTENT } from './props';
import { confettiTree, lanternMaple, lollipopLamp, rippleFountain, sunburstFlowers } from './scenery';
import { buntingMast, harborLighthouse, jungleIdol, neonPylon, orbitGlobe, shellPlanter, tikiTorch } from './themedScenery';
import { auroraWheel } from './wheel';

/**
 * Catalog id → content. Every entry of BUILD_CATALOG except paths and coasters must be listed
 * (registry.test.ts enforces it); coasters resolve through `coasterContentFor`.
 *
 * Content agents never edit this file: each fills its own module, whose exports this file already
 * imports.
 */
const OBJECT_CONTENT: Readonly<Record<string, ObjectContent>> = {
  'petal-roundabout': genericRide,
  'comet-cups': genericRide,
  'cloud-hopper': cloudHopper,
  'aurora-wheel': auroraWheel,
  'moonpetal-carousel': moonpetalCarousel,
  'bumble-coach': genericRide,
  'harbor-swings': genericRide,
  'splash-rings': genericRide,
  'gale-spinner': genericRide,
  'thunder-drum': genericRide,
  // Phase 22 (profile-gated): the tiki is a generic ride, the stalls are kiosks, the maple has its own blueprint.
  'tiki-tumbler': genericRide,
  'picnic-pocket': kiosk,
  'fizz-foundry': kiosk,
  'glacier-scoop': kiosk,
  'lemon-light': kiosk,
  'waffle-windmill': kiosk,
  'snack-sprint': kiosk,
  'comfort-cabin': kiosk,
  'comfort-pavilion': kiosk,
  'cactus-cooler': kiosk,
  'cocoa-chalet': kiosk,
  'ribbon-bench': ribbonBench,
  'tidy-totem': tidyTotem,
  'lollipop-lamp': lollipopLamp,
  'confetti-tree': confettiTree,
  'sunburst-flowers': sunburstFlowers,
  'ripple-fountain': rippleFountain,
  'lantern-maple': lanternMaple,
  // Phase 16: three flat rides on the generic builder, two kiosk stalls and the themed scenery (themedScenery.ts).
  'puddle-jumpers': genericRide,
  'rocket-pendulum': genericRide,
  'temple-trek': genericRide,
  'pretzel-pram': kiosk,
  'coconut-cove': kiosk,
  'bunting-mast': buntingMast,
  'shell-planter': shellPlanter,
  'harbor-lighthouse': harborLighthouse,
  'tiki-torch': tikiTorch,
  'jungle-idol': jungleIdol,
  'neon-pylon': neonPylon,
  'orbit-globe': orbitGlobe,
  // Phase 29: souvenir stalls and the warm drink barrow are kiosks with their own ridge icons.
  'brolly-booth': kiosk,
  'hat-hutch': kiosk,
  'balloon-bouquet': kiosk,
  'plushie-parlour': kiosk,
  'glow-cart': kiosk,
  'bean-barrow': kiosk,
};

const FALLBACK = placeholderContent();

export const REGISTERED_CONTENT_IDS: readonly string[] = Object.keys(OBJECT_CONTENT);

/** Content for a placed, non-coaster object; unknown ids get a footprint block. */
export const contentFor = (definitionId: string): ObjectContent => OBJECT_CONTENT[definitionId] ?? FALLBACK;

export const coasterContentFor = (): CoasterContent => coasterContent;

/** Phase 24: a map prop's content (every PROP_KINDS id is registered: props.test.ts); unknown ids get the stone-block stand-in. */
export const propContentFor = (kind: PropKindId): PropContent => PROP_CONTENT[kind] ?? placeholderProp;

export const litterContent = (): LitterEmitter => litterEmitter;

export { entranceBlueprint };
