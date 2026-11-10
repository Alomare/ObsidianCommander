# commander-server

The Obsidian Commander server: hosts custom Galactic Wars for HELLDIVERS 1, answers the war API the game calls, runs the Vanilla rules, and serves the admin API and the interface. The contract is [docs/spec-m1.md](../docs/spec-m1.md), sections 2 to 5.

## Run

```
cargo build --release
target/release/commander-server --data <dir> --port <port> --token <admin token> [--ui <dir>]
```

| Flag | Meaning |
|---|---|
| `--data <dir>` | where wars and logs live (required) |
| `--port <port>` | loopback port, `127.0.0.1` only; `0` lets the system choose (required) |
| `--token <token>` | admin token: `X-Commander-Token` header or `?token=` (required) |
| `--ui <dir>` | the interface folder; default `ui/` beside the exe |
| `--lan-port <port>` | first port tried for the LAN listener; default 17494, then the next 19 |
| `--keep-running` | don't exit when stdin closes (for running it by hand with no parent) |
| `--version` | prints the version and protocol |

When listening it prints `COMMANDER READY port=<port> version=<version> protocol=1`. It exits when stdin closes, so start it with a pipe for stdin (Obsidian does) or pass `--keep-running`.

## Data

```
<data>/logs/server.log          one line per start, war change, GM action and game write
<data>/wars/<id>/war.json       the war: fronts, events, settings, members, indexes (rewritten atomically)
<data>/wars/<id>/feed.jsonl     feed entries, one per line, appended
<data>/wars/<id>/history.jsonl  snapshots, one per line, appended
```

The war clock (`war_time`) is stored with the war: no time passes while the server is closed, and one tick never counts more than 60 seconds.

## Routes

- `POST /w/<id>/1.0/`: the war API the game calls (form-encoded `action=...`). Player id from `X-Commander-Player` (`local` when missing), name from `X-Commander-Name` (percent-encoded if not ASCII).
- `/api/...`: the admin API (spec section 5). `GET /api/wars/<id>/feed?after=&limit=` answers `{entries, last_id}`; `GET /api/wars/<id>/history?from=` answers `{snapshots: [{season, time, war_time, data: [{points, points_taken, status}]}]}`.
- Anything else under `GET`: files from the interface folder, with `index.html` for paths without an extension.
- The LAN listener (`0.0.0.0`, only while a war is open to LAN) answers only the game API and read-only calls of LAN wars, `/` and `/assets/*`. Discovery broadcasts go to UDP 17493 every 3 seconds.

## Tests

```
cargo test
cargo clippy --all-targets
```

Rules tests live in `src/rules.rs` (no I/O, fixed dice and a fake clock). `tests/server.rs` starts the server on port 0 and drives it over HTTP.
