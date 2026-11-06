# Contributing to Bear War

Thanks for helping! A few rules keep the game open, legal and in sync across players.

## Ground rules

1. **No third-party or copyrighted assets.** Art is drawn procedurally in `src/render/art/*`, sounds are synthesized in `src/audio/audio.ts`. If you really need an external asset it must be CC0 / public domain and listed in the README's *Assets & licensing* section. Never use names, art, sounds or data from commercial games.
2. **Original names only.** New clans, bears, abilities and maps need original names.
3. **The simulation must stay deterministic** (see below). `npm test` enforces part of this.
4. Run `npm run typecheck && npm test` before opening a pull request. For gameplay changes also run a few AI games (`npm run simtest`) and, for balance changes, `node scripts/battle.ts`.

## Determinism rules for `src/game`

Every client runs the same simulation from the same commands (lockstep). Anything that can differ between machines will desync multiplayer games.

- No `Math.random()`: use `game.rng` (or a dedicated seeded `Rng`).
- No `Math.sin/cos/tan/atan/atan2/exp/log/pow/hypot/cbrt`: their last bits differ between browsers. Use `dsin`, `dcos`, `datan2`, `dist` from `src/game/math.ts`. (`+ - * /`, `Math.sqrt`, `Math.floor/round/abs/min/max` are exact and fine.)
- No `Date`, `performance.now()`, timers, DOM, or anything from `src/render`/`src/ui`.
- Iterate collections in a deterministic order (arrays by id/creation order; `Map`/`Set` insertion order is fine if insertions are deterministic). Sort comparators must break ties (usually by `id`).
- Commands arrive from the network: validate everything in `src/game/commands.ts` (ownership, types, ranges). New command fields also need adding to `sanitizeCommand` in `src/net/room.ts`, which drops unknown fields before relaying.
- Any change under `src/game` changes the simulation fingerprint, so servers turn away clients built from other code. You don't need to do anything for that. Bump `PROTOCOL_VERSION` in `src/net/protocol.ts` only when the wire messages change.

## Adding content

- **Units/structures:** add a definition to `src/game/data/<clan>.ts`. Data validation (`validateData`) runs at startup and in tests. Add art to `src/render/art/<clan>.ts` (shared bear bodies live in `bear.ts`; check it in `/gallery.html`), regenerate `docs/UNITS.md` with `node scripts/gen-docs.ts`. Unique behaviour goes in `src/game/systems/*`.
- **Abilities:** define in `src/game/data/abilities.ts`, implement in `src/game/systems/abilities.ts`, optionally teach the AI in `src/game/ai/ai.ts` (`micro`).
- **Maps:** write a builder function in `src/game/map/maps.ts` using the symmetric DSL (`setElev`, `addRamp`, `addRock`, `addWater`, `base`, …) and iterate with `node scripts/mapview.ts <id>` until there are no warnings. Tests check every map.
- **AI:** clan strategies (openings, compositions, production) live in `src/game/ai/plans.ts`.

## Code style

TypeScript, ES modules with explicit `.ts` import extensions (Node runs the server and scripts directly). Keep the simulation free of allocations in hot loops where practical, it has to run on phones.
