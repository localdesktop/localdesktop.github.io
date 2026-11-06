import type { EntityDef } from './data/types.ts';
import { TILE } from './constants.ts';

export type Order =
  | { t: 'move'; x: number; y: number; target: number }
  | { t: 'amove'; x: number; y: number }
  | { t: 'attack'; target: number }
  | { t: 'patrol'; x: number; y: number; x2: number; y2: number }
  | { t: 'hold' }
  | { t: 'gather'; target: number }
  | { t: 'return' }
  | { t: 'build'; def: string; tx: number; ty: number }
  | { t: 'construct'; target: number }
  | { t: 'repair'; target: number }
  | { t: 'ability'; ab: string; x: number; y: number; target: number }
  /** board the transport or bunker `target` */
  | { t: 'load'; target: number }
  /** transport: fly to unit `target` and pick it up */
  | { t: 'pickup'; target: number }
  /** transport: fly to (x,y) and drop all cargo */
  | { t: 'unload'; x: number; y: number };

export type QueueKind = 'unit' | 'research' | 'morph';

export interface QueueItem {
  kind: QueueKind;
  id: string;
  /** research level being researched */
  level: number;
  progress: number;
  total: number;
  started: boolean;
  cost: { m: number; g: number };
}

export interface Rally {
  x: number;
  y: number;
  target: number;
}

export class Entity {
  id: number;
  def: EntityDef;
  owner: number;
  x: number;
  y: number;
  px: number;
  py: number;
  angle = 0;
  turret = 0;
  r: number;
  hp: number;
  shields: number;
  energy: number;
  alive = true;
  air: boolean;
  isBuilding: boolean;
  isResource: boolean;
  /** footprint (tiles), for buildings & resources */
  tx = 0;
  ty = 0;
  tw = 0;
  th = 0;

  // ----- structures
  built = true;
  progress = 0;
  builder = 0;
  queue: QueueItem[] = [];
  rally: Rally | null = null;
  powered = true;
  cubT = 0;
  cubs: number[] = [];
  jellyT = 0;
  hasteT = 0;
  burnAcc = 0;
  /** hive structure grown from a forager (refund the forager on cancel) */
  fromWorker = false;

  // ----- resources
  amount = 0;
  occupiedBy = 0;
  /** refinery <-> geyser link */
  link = 0;

  // ----- units
  orders: Order[] = [];
  /** order sub-state, reset whenever the current order changes */
  ost = 0;
  path: number[] | null = null;
  pathI = 0;
  pathGoalX = 0;
  pathGoalY = 0;
  pathVer = 0;
  repathT = 0;
  groupN = 1;
  stuckT = 0;
  lastProgressX = 0;
  lastProgressY = 0;
  vx = 0;
  vy = 0;
  wantMove = false;
  target = 0;
  cds: number[] = [0, 0];
  holdPos = false;
  group = 0;
  arrived = false;
  /** worker cargo */
  carry = 0;
  carryKind = 0;
  /** assigned resource (mineral or refinery) */
  res = 0;
  mineT = 0;
  inside = false;
  /** carried unit: the transport or bunker it is in */
  carrier = 0;
  /** transports & bunkers: ids of the units inside */
  cargo: number[] = [];
  /** ticks until the next unit can be dropped */
  dropT = 0;
  lastHit = -100000;
  lastAttackTick = -100000;
  rushT = 0;
  slowT = 0;
  slowPct = 0;
  bubble = 0;
  bubbleT = 0;
  /** cub/cocoon: owning hive */
  hive = 0;
  morphTo: string | null = null;
  morphT = 0;
  morphTotal = 0;
  morphCost: { m: number; g: number } | null = null;
  /** ticks until each cooldown ability can be used again */
  cooldowns: Record<string, number> = {};
  lockT = 0;
  lockTarget = 0;
  /** timed life left (ticks); 0 = lives forever */
  lifeT = 0;
  /** anchor zone centre (Hoverbear) */
  zoneX = 0;
  zoneY = 0;
  /** ticks left inside a Pollen Cloud */
  blindT = 0;
  channelT = 0;
  wanderT = 0;
  kills = 0;
  spawnTick = 0;
  /** ticks this entity has been idle (for UI idle-worker button and AI) */
  idleT = 0;
  autocast = true;

  constructor(id: number, def: EntityDef, owner: number, x: number, y: number) {
    this.id = id;
    this.def = def;
    this.owner = owner;
    this.x = x;
    this.y = y;
    this.px = x;
    this.py = y;
    this.air = !!def.air;
    this.isBuilding = def.kind === 'building';
    this.isResource = def.kind === 'mineral' || def.kind === 'geyser';
    if (def.size) {
      this.tw = def.size[0];
      this.th = def.size[1];
      this.r = (Math.min(this.tw, this.th) * TILE) / 2;
    } else {
      this.r = def.radius ?? 8;
    }
    this.hp = def.hp;
    this.shields = def.shields ?? 0;
    this.energy = def.startEnergy ?? 0;
    this.angle = 1.5707963267948966; // face "down" (towards the camera)
  }

  get isUnit(): boolean {
    return !this.isBuilding && !this.isResource;
  }
  get order(): Order | undefined {
    return this.orders[0];
  }
  /** footprint rect in world px */
  get x0(): number {
    return this.tx * TILE;
  }
  get y0(): number {
    return this.ty * TILE;
  }
  get x1(): number {
    return (this.tx + this.tw) * TILE;
  }
  get y1(): number {
    return (this.ty + this.th) * TILE;
  }
}
