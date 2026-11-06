# Architecture

Bear War is a single TypeScript codebase: a deterministic simulation (`src/game`) plus a browser client (rendering, UI, audio, networking) and a tiny Node relay server.

```
            ┌──────────── browser ────────────────────────────────┐
 input ───▶ │ ui/Input → ui/Controller ──Command──▶ net/Session    │
            │                                       │  (Local or   │
            │                                       │   Net)       │
            │            game/Game.step(commands) ◀─┘              │
            │                 │ events                             │
            │  render/Renderer, render/Effects, audio/AudioEngine  │
            └────────────────────────────────────────────────────┘
                     ▲ turns            │ commands
                     │                  ▼
                 server/index.ts + net/Room (turn clock, lobby)
```

## Simulation (`src/game`)

- **Fixed timestep**: 20 ticks per game second (`TICK_RATE`). The renderer interpolates positions between ticks (`px/py → x/y`).
- **Entities** (`entity.ts`) are plain objects for units, structures and resources. `Game.entities` is kept in creation order, so iteration order is deterministic everywhere.
- **Tick order** (`Game.step`): apply commands → AI → structures (production, construction, cubs, regen, timers) → units (orders, targeting, firing) → movement & collision → projectiles → area effects → cleanup → vision (every 4 ticks) → honeycomb (every 5) → victory check.
- **Commands** (`types.ts`, `commands.ts`) are high-level player intents ("smart" right-click, train, build, ability…). They're the only input to the simulation and the only thing sent over the network. All validation happens inside the simulation.
- **Determinism**: only exactly-specified floating point operations are used (`+ - * / sqrt`). Trigonometry uses polynomial implementations in `math.ts`. Randomness comes from a seeded PRNG. `Game.hash()` summarises the state for desync detection.

### Pathfinding and movement

- The walk grid (`grid.ts`) uses 16 px cells (2×2 per tile) with a **clearance map** (Euclidean distance transform to the nearest obstacle), so big bears avoid gaps they don't fit through and still fit down diagonal ramps.
- **Weighted A\*** (octile, 8-way, no corner cutting), followed by line-of-sight **string pulling** for natural any-angle paths. If the goal is unreachable, the unit walks to the closest reachable point.
- **Path sharing**: units heading to the same region reuse a recent path when they can see onto it, and a per-tick node budget prevents frame spikes when 200 units are ordered at once.
- **Local movement**: units steer toward waypoints, then a pairwise separation pass pushes overlapping units apart. Idle units yield to moving ones, units holding position stand firm, and bigger units push harder. Mining workers phase through other units. Groups use "magic box" formations and stop when they bump into an arrived group-mate.

### Combat, vision and clan mechanics

- Weapons have damage, bonus vs. attributes (light / armored / bio / mech / massive / structure), multi-hit, splash rings, bounces, slows, line hits, units-only targeting and anchor zones. Armor reduces each hit (minimum 0.5); shields absorb first and regenerate after 10 s out of combat.
- **Fog of war** is computed per team at tile resolution. Ground units can't see onto higher elevation, so high ground matters. Detection is a separate grid that reveals hidden units.
- **Modes** (`base` in the data, `mode` on abilities): a Kodiak bracing, a Sapper digging in or a Hoverbear anchoring switches its def over a few seconds. Modes share selection groups and command cards. Burrowed modes are hidden and other units walk over them.
- **Honey Horde**: cubs (3 per Hive, more with Royal Jelly), cocoons, honeycomb that grows and recedes, building-on-honeycomb rules, healing over time, unit growth (Scrapper to Buzzbomb, Stinger to Bombardier or Burrower), timed Wild Cubs.
- **Starborn**: Star Totem glow fields, called-down construction, aurora shields, Moonlight Haste, travelling effects (spirits, snowballs) that follow a path and resolve when they expire.
- **Ironpaw**: hardhats that stay to construct (and resume construction), repair, burning buildings, lock-on damage over time.
- **Area effects** (`systems/abilities.ts`) cover Big Sniff, Bee Cloud, Sting Swarm, Starfall, Pollen Cloud, Hornet Bomb, Scalding Honey, Spirit Walk and the Star Snowball.
- **Transports and bunkers** (`systems/cargo.ts`): a carried unit stays in the entity list with `inside` set (like a worker inside a refinery), so it still counts for supply, but nothing can see, hit or collide with it, and it follows its carrier's position. Units walk to a transport while an idle transport flies to meet them. Transports drop one unit every few ticks at the nearest walkable point. A destroyed transport kills its cargo; a destroyed bunker lets its units out. Units in a bunker pick targets and fire from its walls with bonus range.

### AI (`src/game/ai`)

The computer opponent runs inside the simulation on every client, so AI games need no extra network traffic. Each think cycle (every 8-40 ticks depending on difficulty) it:

1. Observes what its team can see. It remembers enemy structures and gauges enemy air/light/armored counts.
2. Runs the economy: assigns idle workers, balances gas, trains workers up to a saturation target, and resumes abandoned construction.
3. Keeps supply ahead of demand.
4. Executes a clan-specific **opening build order** (`plans.ts`) that tolerates failures, then macros: more production, expansions (ranked by ground distance), extra refineries, detection when hidden units appear, and upgrades.
5. Produces units by filling the most under-represented slot of a counter-weighted **composition**.
6. Controls the army through gather → attack → retreat/defend states. It re-targets the nearest known enemy structure and sweeps base locations when nothing is known.
7. Micros on Normal and above: bracing, digging in, anchoring, hibernating, Lock On, Honey Rush, Starfall/Sting Swarm/Star Snowball/Scalding Honey on clusters, Bee Cloud, Pollen Cloud, Yank, Hornet Bomb, Shield Bubble, the Grand Cannon, Sunlance, Big Sniff versus hidden units. It also grows Buzzbombs, Bombardiers and Burrowers.

## Client

- **Renderer** (`render/`): Canvas 2D.
  - Terrain is hill-shaded per pixel from a smoothed elevation field and cached in 256 px chunks (with honeycomb overlays).
  - Sprites are drawn procedurally once per (type, team colour, animation frame) and then blitted with rotation.
  - Fog is a 1-pixel-per-tile alpha texture scaled up with smoothing.
  - Particles use cached glow sprites.
- **UI** (`ui/`): a DOM HUD (resources, minimap, selection panel, 4×3 command card, control groups) driven by `Controller`, which turns intents into commands. `Input` handles mouse, keyboard and touch gestures.
- **Audio** (`audio/`): every sound is a small Web Audio graph (oscillators, filtered noise, envelopes), positioned by stereo pan and distance from the camera, with per-sound rate limiting. Music is a generative ambient chord progression.

## Networking

- `LocalSession` (offline) steps the game in real time and applies the local player's commands on the next tick. It supports pause and speed changes.
- `NetSession` (online) only advances through **turns** received from the server. A turn is 2 ticks (100 ms) and carries every player's commands. It catches up smoothly after stalls, acks progress every 5 turns, and sends a state hash every 50 turns. A watchdog keeps it ticking when the browser stops delivering animation frames (background tab, app switch).
- `Room` (`net/room.ts`, pure TS) runs lobbies and the **turn clock**:
  - Emits turns on a fixed schedule and pauses the game when a client falls more than 3 s behind.
  - Drops clients after 45 s of waiting.
  - Injects `leave` commands on disconnect and compares hashes to detect desyncs.
- **Reconnection**: each player gets a secret token at game start. An unexpected disconnect isn't treated as leaving: the room pauses as for any lagging player, the client retries for up to 40 s, and on `rejoin` the room sends every turn since the client's last executed turn. The client still holds its simulation state, so it simply resumes.
- **Replays** (`net/replay.ts`) are the setup plus the command log. `ReplaySession` re-simulates them with full vision and speed control.
- `server/index.ts` hosts rooms over WebSocket (`ws`) with rate limiting and heartbeats, and serves the built client.
- **Version check**: Vite bakes a fingerprint of `src/game` into the client (`__SIM_HASH__`, from `server/simhash.ts`); the server computes the same fingerprint at startup and refuses clients whose simulation differs. Development builds report `dev` and are always accepted.
- **Untrusted input**: the room rebuilds every command from known fields before relaying it (at most 64 per player per turn). It keeps only the last two minutes of turns for reconnects and rate-limits rejoins. The simulation validates every command again (ownership, targets, costs, tech).

## Offline / PWA

`vite.config.ts` contains a small plugin that emits `sw.js` with a precache list of every build artifact. The service worker serves the app shell network-first (so updates arrive) and assets cache-first, so the game runs fully offline after the first load and can be installed to the home screen (`public/manifest.webmanifest`).
