# Evolved wars

An Evolved war is a HELLDIVERS 2-style Galactic War played in HELLDIVERS (2015): the HELLDIVERS 2 galaxy, planets that change hands, supply lines, liberation and defense campaigns, operations and Major Orders. The server keeps the war (`server/src/evolved.rs`); every player runs the [Evolved War Engine](https://github.com/Alomare/HD1-EvolvedWarEngine) mod, which draws the galaxy map in the game, turns a picked mission into a HELLDIVERS planet, and reports the result.

## The map

`data/galaxy-hd2.json`, built by `tools/build_galaxy.py` from the HELLDIVERS 2 planet list (names, positions, sectors and supply lines, read once from the community API at helldivers2.dev):

| Field | What it holds |
|---|---|
| `planets[]` | `id` (0-272, the number every part uses), `hd2` (the HELLDIVERS 2 index), `name`, `sector`, `x`, `y` (Super Earth at 0, 0, y up, radius about 0.95), `biome`, `env` (HELLDIVERS environment: 0 desert, 1 forest, 2 snow, 3 lava, 4 city), `hazards`, `owner` at the start, `cell` (the convex Voronoi cell of the planet inside the galaxy rim) |
| `sectors[]` | `id`, `name`, `x`, `y` (the mean of the planets), `owner` at the start, `planets` |
| `links` | Supply lines, as pairs of planet ids. Every planet is reachable from Super Earth: planets the source left unlinked join the nearest group |
| `borders` | Sector border edges: `[x1, y1, x2, y2, sector_a, sector_b]` |
| `homes` | The home world of each enemy |

Factions: 0 Super Earth, 1 bugs, 2 cyborgs, 3 illuminates (the HELLDIVERS enemy index is faction minus 1). At the start the Cyborgs hold the left of the galaxy, the Bugs the right and the Illuminates the bottom; sectors past radius 0.56 in each wedge start enemy-held.

## Rules

| Thing | How it works | Setting (default) |
|---|---|---|
| Liberation campaign | On an enemy planet linked to a Super Earth planet. A won mission takes `0.6 + 0.08 x difficulty` units off the enemy hold; the whole hold is `liberation_missions` units. At 0 the planet turns to Super Earth | `liberation_missions` (10) |
| Regeneration | A planet under a liberation campaign regains this much each hour | `regen_per_hour` (1%) |
| Defense campaign | On a Super Earth planet linked to the attacker. Won missions fill `defense_missions` units before the deadline, or the planet falls | `defense_hours` (24), `defense_missions` (5) |
| Operations | Three per campaign, at the planet difficulty minus 2, at it, and plus 2 (defenses one higher). Difficulty grows with the distance from Super Earth; home worlds are 14. Two or three missions each, as HELLDIVERS sets by difficulty, one of them an extermination a third of the time from difficulty 4. Finishing all of them adds one unit, and a new operation takes the place of the finished one | |
| Director | Keeps the liberation campaigns open, spread over the enemies (Major Order targets first, home worlds last), sends each enemy to attack on a schedule, and issues a Major Order when none is active | `campaigns` (3), `attack_hours` (30), `order_hours` (72), `director` (on) |
| Major Orders | `liberate` (every planet held by the deadline), `defend` (no planet lost before it), `missions` (a number of won missions against one enemy or any) | |

The stock uploads the game sends (`complete_planets` and the event missions) move nothing in an Evolved war; the fronts the game reads stay as they started.

## API

The mod reaches the war through the Obsidian relay: `http://127.0.0.1:<relay>/<token>/evolved/<call>` goes to `/w/<id>/evolved/<call>`, with the Steam ID in `X-Commander-Player` when it is a hex string.

| Call | What it does |
|---|---|
| `GET /w/<id>/evolved/state` | The war: `galaxy`, `galaxy_version`, `owners` (273 factions), `campaigns` (each with `liberation` or `defense` in percent, `ends_in` in seconds, `regen_per_hour`, `per_mission`, and `operations` with `id`, `name`, `difficulty`, `lat`, `lon`, `seed`, `variant`, `shading`, `missions` of `{kind, random, tod, done}`), `orders`, `news` (newest first), `stats`, `settings`, and `war` (id, name, season, state, clock). 404 for a Vanilla war |
| `POST /w/<id>/evolved/report` | `{campaign, operation, mission (from 0), success, lobby, kills, deaths}`. Counted once per `lobby`, operation and mission; answers `{credited, reason?, liberation?, defense?, operation_complete?, planet_liberated?, planet_defended?}` |
| `GET /w/<id>/evolved/galaxy` | `data/galaxy-hd2.json` |

The admin view (`GET /api/wars/<id>`) has the same state in `evolved`. `POST /api/wars` takes `model: "evolved"` and an `evolved` settings object. Game Master actions go to `POST /api/wars/<id>/actions`:

| `action` | Fields |
|---|---|
| `evo_planet` | `planet`, `owner` (0-3). Ends any campaign on it |
| `evo_campaign` | `planet`, `kind` (`liberation` or `defense`; by default from the owner), `faction` (1-3, a defense), `hours` (a defense) |
| `evo_end_campaign` | `campaign`, `won` |
| `evo_order` | `kind` (`liberate`, `defend`, `missions`), `planets`, `faction`, `target`, `hours`, `brief` |
| `evo_cancel_order` | `order` |
| `evo_news` | `text` (1-400 characters) |
| `evo_settings` | `settings`: any of the settings above |

## From a mission to the hellpods

The mod builds a HELLDIVERS planet record from an operation: environment from the planet, variant, shading and seed from the operation, and each mission seed from the mission `kind`, `random` and `tod` the server rolled, the same way `DifficultySettings.modulate_seed` packs them. Every player builds the same missions. The record goes into the galaxy map screen as a pick made on that screen would, so the ship jumps to the planet, the hellpods open, and the squad follows the host through the stock countdown. See the mod `docs/design.md`.
