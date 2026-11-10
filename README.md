# Obsidian Commander

Custom Galactic Wars for HELLDIVERS (2015), hosted from the COMMANDER tab in Obsidian. A war runs on the same PC as the game or on another PC on the local network, and the game connects to it through the Obsidian relay. On the war screens, a Game Master runs the fronts: enemy pushes, defenses, home world attacks, the war clock and the season.

Milestone 1 (in progress): **Vanilla Wars**, local or over LAN. They keep the campaign model built into the game, and the host sets the rules. Milestone 2: **Evolved Wars**, with planets, supply lines and Major Orders, through a companion mod.

## Parts

| Folder | What it is |
|---|---|
| [server/](server/) | `commander-server`, in Rust. Holds the wars, answers the war API the game calls, runs the Vanilla rules, serves the admin API and the war screens, and runs the LAN listener and announcements |
| [ui/](ui/) | The war screens (Vite, React, TypeScript): war list, **Create War**, the galaxy map drawn from the in-game map, Game Master commands, feed, players, and statistics with the front progress chart. `npm run dev` with `?mock=1` runs them against a fake server |
| [data/warfront.json](data/warfront.json) | The in-game war map: regions as cells on a polar grid, and the map colours |
| [tools/pack.py](tools/pack.py) | Builds the package ZIP that Obsidian installs, in `internal/builds/` |
| [tools/e2e.py](tools/e2e.py) | Checks a package end to end without the game: server, game requests, the Obsidian relay, GM actions, LAN and screenshots |
| [probe/](probe/) | The in-game probes of 2026-11-04 and 2026-11-09 |

The Obsidian side (the tab, the relay, war saves and the war mode in the loader) is in the ObsidianLauncher repo: `core/src/commander`, `app/src/commander` and `loader/src/war.lua`.

## Docs

- [docs/spec-m1.md](docs/spec-m1.md): the contract between Obsidian, the server and the war screens
- [docs/plans/](docs/plans/): the plans for the interface and for internet play
- [docs/findings.md](docs/findings.md), [docs/protocol.md](docs/protocol.md), [docs/probe.md](docs/probe.md): the war API the game calls, and the first probes

## Removing Commander

**Remove All Commander Data**, in the package menu on the COMMANDER tab, removes the package, the hosted and joined wars, the server data and the region names file. Removing the war saves and the Windows Firewall rules is optional, and Windows asks for administrator permission before the rules go. The war server stops first, and the next launch plays the official war. From the command line: `obsidian commander wipe --saves --firewall`.

## Build and test

```
cd server && cargo test            # rules and the server over HTTP
cd ui && npm run build             # the war screens
python tools/pack.py               # both, then the package ZIP
python tools/e2e.py --obsidian <ObsidianLauncher checkout>
python -m unittest discover -s probe/tests
```

MIT License. A fan project, not made or endorsed by Arrowhead Game Studios or Sony.
