# Commander milestone 1: local and LAN Vanilla wars

The contract between the three parts built for milestone 1. Where this file and the code disagree, fix one of them; don't let them drift.

- **Obsidian** (ObsidianLauncher repo): the COMMANDER tab, installing the package, LAN join, the relay, war saves, the loader's war mode.
- **Commander server** (`server/`, Rust, one binary `commander-server.exe`): holds wars, answers the game's war API, runs the Vanilla rules, serves the admin API and the interface.
- **Commander interface** (`ui/`, Vite + React + TypeScript): built into static files the server serves. Obsidian shows it in the tab in an iframe.

Background: [findings.md](findings.md), [protocol.md](protocol.md) (the game's wire format, with real requests), [probe.md](probe.md) (the in-game probes). The probe server (`probe/server.py`, `probe/scenarios.py`) is a working Python reference for the game side.

## 1. Package

A ZIP with this layout, made by `tools/pack.py` (to write):

```
commander.json          {"name": "Obsidian Commander", "version": "0.1.0", "protocol": 1,
                         "server": "commander-server.exe", "ui": "ui"}
commander-server.exe
ui/                     the built interface (index.html, assets/)
LICENSE, THIRD-PARTY-NOTICES.txt
```

`protocol` is the version of this contract. Obsidian refuses a package whose protocol it doesn't know.

## 2. Server process

```
commander-server.exe --data <dir> --port <port> --token <admin token> [--ui <dir>]
```

- `--data`: where wars live (`<dir>/wars/<id>/war.json`, written atomically: temp file, then rename).
- `--port`: the loopback port. The server binds `127.0.0.1:<port>` only. Port 0 lets the OS choose.
- `--token`: the admin token. Every admin call carries it in the `X-Commander-Token` header, or `?token=` in the interface's URL (the interface reads it once and then sends the header).
- `--ui`: the interface folder. Default: `ui/` beside the exe.
- When listening, it prints one line to stdout: `COMMANDER READY port=<port> version=<version> protocol=1`. Obsidian waits for it.
- It exits when stdin closes, so it never outlives Obsidian.
- Logs go to `<data>/logs/server.log`.

### LAN listener

Opening a war to LAN starts a second listener on `0.0.0.0:<lan port>` (default 17494, the next free one if taken). On it, only two things answer:

- the game API of wars open to LAN: `/w/<id>/1.0/`;
- the read-only interface and read-only API of those wars: `GET /`, `GET /assets/*`, `GET /api/wars/<id>`, `GET /api/wars/<id>/feed`, `GET /api/wars/<id>/history`, `GET /api/info` (lists only LAN wars).

Everything else answers 404 on the LAN listener. The listener closes when no war is open to LAN.

### LAN discovery

While a war is open to LAN, the server sends a UDP broadcast to `255.255.255.255:17493` every 3 seconds:

```json
{"commander": 1, "war": "<id>", "name": "...", "model": "vanilla", "season": 1042,
 "port": 17494, "host": "<computer name>", "players": 3, "version": "0.1.0"}
```

Obsidian listens on 17493 while its Join screen is open. The address comes from the packet's source.

## 3. The game's war API

`POST /w/<war id>/1.0/`, form-encoded `action=...`, exactly as [protocol.md](protocol.md). The relay in Obsidian forwards the game's request here and adds:

- `X-Commander-Player`: the player's Steam ID (hex, from the `online_id` in `auth`);
- `X-Commander-Name`: the player's name when known (may be missing).

The relay removes `auth.data` (the Steam ticket) and the `sign` header before forwarding. The server must work without them.

Every answer is JSON with `time` (server unix time) and `error_code` (0). Unknown actions answer `error_code` 3 with `error_message` "Missing or invalid arguments". Answer every read action from section 3.1 of the probe's list, even the ones with no real data (empty lists), so the game never goes offline over a missing field.

| Action | Answer |
|---|---|
| `get_campaign_status` | `campaign_status[3]` (bugs, cyborgs, illuminates: `season`, `points`, `points_taken`, `points_max`, `status`, `introduction_order`), `defend_event` (or none), `attack_events[]`, `statistics[3]` |
| `get_campaign_status` with `season` | that season's status rows |
| `get_snapshots` | `introduction_order[3]`, `points_max[3]`, `snapshots[] {season, time, data}` where **`data` is a JSON string** of three `{points, points_taken, status}`, `defend_events[]`, `attack_events[]`. Honour `start` and `end` |
| `get_defend_event_by_id`, `get_attack_event_by_id` | the event |
| `get_season_statistics` | `statistics` |
| `get_provinggrounds` | `trials[]`: three entries `{enemy, trial_seed, mission_seed, unlocked}`, seeds from the war's seed |
| `get_leaderboards`, `get_leaderboards_provinggrounds` | empty `leaderboards`, `user_leaderboards` |
| `get_top_of_leaderboard_provinggrounds` | empty `experts` |
| `get_usernames` | `usernames[]`: the war's members' Steam IDs |
| `get_available_entitlements` | an empty `entitlements` list (store listings only; never unlock paid content) |
| `upload_statistics` (`statistics` JSON) | add to the war's statistics; ack `uploaded_statistics` = highest `index` |
| `upload_statistics` with `c` | ack only (the game's tamper report; ignore it) |
| `upload_leaderboard_statistics`, `upload_leaderboard_provinggrounds_statistics` | ack the highest `index` |
| `complete_planets` (`planets` JSON) | credit the fronts (**`enemy` is 1-based here**), ack `completed_planets` = highest index, and include the new `campaign_status` |
| `complete_defend_mission` (`event_id`, `difficulty`) | credit the event, answer the full status |
| `complete_attack_mission` (`event_id`, `difficulty`) | credit the event, answer the full status |

A planet completion and a defend mission count once per player and index: keep the highest index acknowledged per player and kind, and ignore entries at or under it. A lost mission uploads statistics only.

## 4. Vanilla rules

A Vanilla war copies the shape of HD1's Galactic Campaign with rules of our own, since Arrowhead's are not public. Every number is a war setting with these defaults, changeable from the interface.

**Fronts.** Three fronts, `enemy` 0 bugs, 1 cyborgs, 2 illuminates. `points` from 0 to `points_max` (default 100000). The front's region is `clamp(floor(points / (points_max / 10)) + 1, 1, 10)`, as the game computes it. Region 1 touches Super Earth, region 10 touches the enemy home world. `status` is `active`, `defeated` or `hidden`. `introduction_order` 0, 1, 2 (a war may start with fronts `hidden` and introduce them later).

**Start.** Each active front starts at `start_points` (default 15000, the middle of region 2, so enemy pressure doesn't cross a region edge at once). The season number is 1000 + a random number up to 8999, fixed at creation.

**Clock.** The war advances in real time while the server runs and the clock isn't paused. While the server is closed, no time passes: on start, the server resumes from where it stopped (it stores `war_time`, the seconds the war has run, and advances it by the real seconds between ticks, capped at 60 per tick). Speed multiplier: 1 (settings allow 0.5 to 10). The tick runs every 5 seconds.

**Enemy pressure.** Each active front loses `pressure_per_hour` points (default 600) per war hour, unless an event runs on that front.

**Planets.** `complete_planets` adds `difficulty * success * planet_value` to the planet's front (`planet_value` default 250), capped at `points_max`.

**Defend events.** At most one at a time (the game shows one). The war director starts one with `defend_chance_per_hour` (default 0.08) on a random active front, in the front's current region, lasting `defend_duration` (default 4 h), with `points_max` = `defend_points` (default 3000) and `points` 0. Each `complete_defend_mission` adds `difficulty * defend_mission_value` (default 150). At `points >= points_max` the event is `success` and the front gains `defend_reward` (default 3000). At `end_time` without it, it's `fail` and the front loses one region's worth of points (`points_max / 10`).

**Super Earth defense.** When a front reaches 0 points, a defend event starts in region 0 (Super Earth), lasting `defend_duration`. Success puts the front back to `points_max / 10`. Fail ends the season as **lost**.

**Attack event.** When a front reaches `points_max`, an attack event on its home world starts (region 11, `players_at_start` = members seen in the last 24 h, `max_event_id`), lasting `attack_duration` (default 6 h), `points_max` = `attack_points` (default 5000). Each `complete_attack_mission` adds `difficulty * attack_mission_value` (default 150). Success: the front becomes `defeated`. Fail: the front drops to `points_max * 0.8`.

**Season end.** All active fronts `defeated`: the season is **won**. Super Earth lost: **lost**. Either way the war records the result and stops. The GM starts a new season from the interface (season + 1, fronts reset to `start_points`). The game plays its own recap and season-end screens when it sees the new season.

**Snapshots.** Every war hour and on every status change, keep `{time, data}` for `get_snapshots` and the interface's history.

**Feed.** Every change (mission credited, region liberated or lost, event started or ended, GM action, member seen for the first time) adds a feed entry `{id, time, war_time, kind, front, region, event_id, player, value, text_key}`. `text_key` is a stable key such as `region_lost`; the interface turns it into words.

## 5. Admin API

JSON over HTTP on the loopback listener. Every call needs the admin token, except the read-only ones on the LAN listener (section 2).

| Call | Does |
|---|---|
| `GET /api/info` | `{version, protocol, wars: [summary]}` |
| `POST /api/wars` | create: `{name, model: "vanilla", settings?}`. Answers the war |
| `GET /api/wars/<id>` | the full war (below) |
| `PATCH /api/wars/<id>` | change `name` or any `settings` field |
| `DELETE /api/wars/<id>` | delete the war's folder |
| `POST /api/wars/<id>/actions` | one GM action (below). Answers the war |
| `GET /api/wars/<id>/feed?after=<id>&limit=<n>` | feed entries, newest last |
| `GET /api/wars/<id>/history?from=<time>` | snapshots, for charts |
| `POST /api/wars/<id>/lan` | `{open: true|false}`. Answers `{open, port}` |
| `GET /api/wars/<id>/export` | the war as one JSON file |
| `POST /api/wars/import` | a war from that file (new id) |

**A war:**

```json
{
  "id": "k3x9q2", "name": "...", "model": "vanilla", "season": 1042, "created": 1794258000,
  "state": "running | paused | won | lost",
  "war_time": 18234.5, "speed": 1,
  "fronts": [{"enemy": 0, "points": 23000, "points_max": 100000, "points_taken": 0, "status": "active",
              "introduction_order": 0, "region": 3, "pressure_per_hour": 600}],
  "defend_event": {"event_id": 7, "enemy": 0, "region": 3, "points": 900, "points_max": 3000,
                   "start_time": 1794258000, "end_time": 1794272400, "status": "active"},
  "attack_events": [],
  "statistics": [{"enemy": 0, "missions": 12, "successful_missions": 9, "kills": 3100, "deaths": 22,
                  "shots": 0, "hits": 0, "accidentals": 3, "players": 2, "completed_planets": 4}],
  "members": [{"player": "110000100000001", "name": "...", "first_seen": 0, "last_seen": 0, "missions": 3}],
  "settings": {"points_max": 100000, "start_points": 15000, "pressure_per_hour": 600, "planet_value": 250,
               "defend_chance_per_hour": 0.08, "defend_duration": 14400, "defend_points": 3000,
               "defend_mission_value": 150, "defend_reward": 3000, "attack_duration": 21600,
               "attack_points": 5000, "attack_mission_value": 150, "director": true},
  "lan": {"open": false, "port": null},
  "server_time": 1794258123
}
```

**GM actions** (`POST /api/wars/<id>/actions`), `{"action": "...", ...}`:

| Action | Fields | Does |
|---|---|---|
| `set_points` | `front`, `points` | sets a front's points |
| `push` | `front`, `regions` (negative: the enemy pushes) | moves a front by whole regions |
| `set_status` | `front`, `status` | `active`, `defeated` or `hidden` (introduces or removes a front) |
| `start_defend` | `front`, `region` (0 = Super Earth), `duration`, `points_max` | starts a defense; refused while one runs |
| `start_attack` | `front`, `duration`, `points_max` | starts the attack on the home world |
| `set_event` | `event_id`, `points` | sets an event's progress |
| `end_event` | `event_id`, `result` (`success` or `fail`) | ends an event now, with its consequences |
| `pause`, `resume` | | the clock |
| `set_speed` | `speed` | 0.5 to 10 |
| `end_season` | `result` (`won` or `lost`) | ends the season now |
| `new_season` | | season + 1, fronts reset |

Each action adds a feed entry with `player: "gm"`.

## 6. The interface inside Obsidian

Obsidian opens the interface in an iframe: `http://127.0.0.1:<port>/?token=<admin token>` for wars hosted on this PC, `http://<host>:<lan port>/?war=<id>` read-only for a LAN war joined from another PC.

Messages with `window.postMessage`. The interface only acts on messages from its parent; Obsidian only acts on messages from the iframe's window and checks every field.

**Obsidian to the interface:**

| Message | Fields |
|---|---|
| `obsidian:hello` | `theme` (`dark` or `light`), `lang`, `names` (game text keys to words in the player's language: `region_bugs_01` ... `region_illuminates_hq`, `region_superearth_01`, `city_*`; may be empty), `playing` (the war id Obsidian has selected, or null), `game_running` |
| `obsidian:state` | `playing`, `game_running` (sent when they change) |

**The interface to Obsidian:**

| Message | Fields | Obsidian does |
|---|---|---|
| `commander:play` | `war`, `name` | selects that war for play: creates its Sandbox save on first use, selects it, then starts the game |
| `commander:select` | `war`, `name` | selects that war for play without starting the game |
| `commander:official` | | goes back to the official war |
| `commander:ready` | | the interface loaded; Obsidian answers with `obsidian:hello` |

Region names: the loader writes them in the player's language when the game first starts in war mode. Until then `names` is empty and the interface uses its own labels.

## 7. Obsidian's war mode (for reference)

- A war Obsidian plays is `{id, name, address}`: the address is `http://127.0.0.1:<port>/w/<id>/1.0/` for a local war, `http://<host>:<lan port>/w/<id>/1.0/` for a LAN one.
- Selecting a war: its Sandbox save is selected, and the settings file gets `war <id> <relay url> <pool tag>`. The relay URL is `http://127.0.0.1:<relay port>/<launch token>/1.0/`.
- The loader then points the game at the relay, blocks telemetry and the feedback upload, keeps the war's own pool, and allows uploads, which can only reach the relay. Without a selected Sandbox, the loader refuses war mode and the game stays on the official war.
- The relay forwards to the war's address, strips the Steam ticket, and adds the player headers.
