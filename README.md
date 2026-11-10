# Obsidian Commander

Custom Galactic Wars for HELLDIVERS (2015), hosted from Obsidian's COMMANDER tab. A war runs on this PC or on the local network, the game plays it through Obsidian's relay, and the war screens let a Game Master run the fronts: enemy pushes, defenses, home world attacks, the clock and the season.

Milestone 1 (in progress): local and LAN **Vanilla Wars**, the game's own campaign model with rules of its own. Milestone 2: **Evolved Wars** (planets, supply lines, Major Orders) with a companion mod.

## Parts

| Folder | What it is |
|---|---|
| [server/](server/) | `commander-server`, Rust: holds the wars, answers the game's war API, runs the Vanilla rules, serves the admin API and the war screens, LAN listener and announcements |
| [ui/](ui/) | The war screens (Vite, React, TypeScript): war list, Create War, the galaxy overview drawn from the game's own map, Game Master commands, feed, statistics, history. `npm run dev` then `?mock=1` runs it with a fake server |
| [data/warfront.json](data/warfront.json) | The game's war map: regions as cells of its polar grid, and its colours |
| [tools/pack.py](tools/pack.py) | Builds the package ZIP Obsidian installs, into `internal/builds/` |
| [tools/e2e.py](tools/e2e.py) | Checks a package end to end with no game: server, game requests, Obsidian's relay, GM actions, LAN, screenshots |
| [probe/](probe/) | The in-game probes of 2026-11-04 and 2026-11-09 |

Obsidian's side (the tab, the relay, war saves, the loader's war mode) is in the ObsidianLauncher repo, `core/src/commander`, `app/src/commander` and `loader/src/war.lua`.

## Docs

- [docs/spec-m1.md](docs/spec-m1.md): the contract between Obsidian, the server and the war screens
- [docs/plans/](docs/plans/): the plans for the interface and for internet play
- [docs/findings.md](docs/findings.md), [docs/protocol.md](docs/protocol.md), [docs/probe.md](docs/probe.md): the game's war API and the first probes

## Build and test

```
cd server && cargo test            # rules and the server over HTTP
cd ui && npm run build             # the war screens
python tools/pack.py               # both, then the package ZIP
python tools/e2e.py --obsidian <ObsidianLauncher checkout>
python -m unittest discover -s probe/tests
```

MIT License. A fan project, not made or endorsed by Arrowhead Game Studios or Sony.
