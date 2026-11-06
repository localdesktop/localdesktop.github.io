export type RaceId = 'ironpaw' | 'horde' | 'starborn';
export type Attr = 'light' | 'armored' | 'bio' | 'mech' | 'massive' | 'structure' | 'psionic';
export type TargetFilter = 'ground' | 'air' | 'both';
export type DefKind = 'unit' | 'building' | 'mineral' | 'geyser' | 'cub' | 'cocoon';

export interface Cost {
  m: number;
  g: number;
}

export interface SplashDef {
  /** radii in tiles, inner to outer */
  r: number[];
  /** damage fraction for each ring */
  pct: number[];
  /** also damages the attacker's own/allied units */
  friendly?: boolean;
}

export interface WeaponDef {
  name: string;
  dmg: number;
  /** hits per attack, armor applies to each (e.g. 8x2) */
  hits?: number;
  /** bonus damage against attributes */
  bonus?: Partial<Record<Attr, number>>;
  /** seconds between attacks */
  cd: number;
  /** tiles, edge-to-edge */
  range: number;
  minRange?: number;
  targets: TargetFilter;
  /** upgrade line that increases this weapon's damage */
  upg?: string;
  upgDmg?: number;
  upgBonus?: number;
  /** projectile visual; undefined = instant hit */
  proj?: string;
  /** projectile speed in tiles per second */
  projSpeed?: number;
  splash?: SplashDef;
  /** bounce to additional targets (Hornet glaive) */
  bounce?: { n: number; falloff: number; range: number };
  melee?: boolean;
  slow?: { pct: number; dur: number };
  /** the attacker dies when it attacks (Buzzbomb) */
  suicide?: boolean;
  /** can't attack structures (Sapper) */
  unitsOnly?: boolean;
  /** only hits targets within this radius (tiles) of the anchor point (Hoverbear) */
  zone?: number;
  /** hits everything along a line of this half-width in tiles (Burrower) */
  line?: number;
  /** visual + audio effect id */
  fx: string;
}

export interface EntityDef {
  id: string;
  name: string;
  race: RaceId | 'neutral';
  kind: DefKind;
  desc: string;
  cost: Cost;
  /** build / train time in seconds */
  time: number;
  supply?: number;
  provides?: number;
  hp: number;
  shields?: number;
  armor: number;
  energy?: number;
  startEnergy?: number;
  /** tiles per second */
  speed?: number;
  /** collision radius in world px (units) */
  radius?: number;
  /** footprint in tiles (buildings & resources) */
  size?: [number, number];
  air?: boolean;
  /** sight range in tiles */
  sight: number;
  attrs: Attr[];
  weapons?: WeaponDef[];
  abilities?: string[];
  /** units this building trains (for cub-producers: units its cubs can morph into) */
  produces?: string[];
  researches?: string[];
  /** building morphs available (Hive -> Royal Hive) */
  morphs?: string[];
  /** unit morphs available (Scrapper -> Buzzbomb) */
  unitMorphs?: string[];
  /** tech requirements: building ids that must exist (completed) */
  requires?: string[];
  /** counts as this building id for requirements (Royal Hive counts as Hive) */
  counts?: string[];
  worker?: boolean;
  depot?: boolean;
  refinery?: boolean;
  townHall?: boolean;
  detector?: number;
  cloaked?: boolean;
  powerRadius?: number;
  needsPower?: boolean;
  combRadius?: number;
  needsComb?: boolean;
  spawnsCubs?: boolean;
  /** units created per production (Scrappers come in pairs) */
  count?: number;
  /** hp regenerated per second (in addition to race regen) */
  regen?: number;
  /** transports & bunkers: cargo capacity in slots */
  cargo?: number;
  /** cargo slots this unit takes up (unset: can't be carried) */
  cargoSize?: number;
  /** only biological units may enter (Bunker) */
  cargoBio?: boolean;
  /** research needed before this unit can carry cargo (Bumblebear) */
  cargoReq?: string;
  /** units inside fire out of this structure with this much bonus range (tiles) */
  bunker?: number;
  /** upgrade line that adds armor */
  armorUpg?: string;
  /** morph source for unit morphs */
  morphFrom?: string;
  /** alternate mode of this unit id (Kodiak braced) */
  base?: string;
  /** other units walk over it */
  burrowed?: boolean;
  /** only the turret layer aims (Kodiak) */
  turret?: boolean;
  /** timed life in seconds */
  lifetime?: number;
  /** energy per second while in this mode, back to `base` at 0 */
  drain?: number;
  /** target priority for auto-acquire (higher = preferred) */
  priority?: number;
  /** render scale tweak / art variant id */
  art?: string;
  /** cannot be selected/attacked directly (internal) */
  hidden?: boolean;
  /** build menu page: 1 = basic, 2 = advanced */
  buildPage?: 1 | 2;
  /** sort order within menus */
  order?: number;
}

export interface ResearchDef {
  id: string;
  name: string;
  race: RaceId;
  desc: string;
  /** one entry per level */
  costs: Cost[];
  times: number[];
  /** extra building requirements per level */
  reqs?: string[][];
  /** icon id */
  icon: string;
}

export type AbilityTarget = 'none' | 'point' | 'unit' | 'ally' | 'own-building' | 'enemy';

export interface AbilityDef {
  id: string;
  name: string;
  desc: string;
  target: AbilityTarget;
  energy?: number;
  hpCost?: number;
  cooldown?: number; // seconds
  range?: number; // tiles (cast range)
  radius?: number; // tiles (effect radius)
  duration?: number; // seconds
  requires?: string; // research id
  /** building tech requirements */
  needs?: string[];
  autocast?: boolean;
  icon: string;
  /** passive abilities are listed for info only */
  passive?: boolean;
  /** switch to def `to` over `time` seconds */
  mode?: { to: string; time: number };
}

export interface RaceDef {
  id: RaceId;
  name: string;
  desc: string;
  worker: string;
  townHall: string;
  supplyUnit: string; // building (or unit) that provides supply
  refinery: string;
  /** construction style */
  build: 'construct' | 'settle' | 'summon';
  color: string;
}
