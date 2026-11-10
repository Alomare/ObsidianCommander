# The probe

The smallest live check before any war logic exists. It answers open questions 1-4 of [findings.md](findings.md#open-questions-for-live-runs-on-the-main-pc), part of 6, and gives the first look at 5 and 7.

**Status: five runs on the notebook, 2026-11-04 and -05 (`probe/runs/`, gitignored): one scenario tour and four mission runs. Results below.**

## Results of the first run

Plain HTTP, no mission played, a fresh isolated save, about 2.5 minutes from launch to kill.

| Question | Result | Evidence |
|---|---|---|
| 1. Redirect before the first poll | **Yes.** `set_environment` ran at the ship load (`URL game chose https://api.helldiversgame.com/1.0/, probe sets http://127.0.0.1:17491/1.0/`), before any request. All 22 requests reached the probe and none reached the official server | `cmdprobe.log`, `requests.jsonl` |
| 2. Plain HTTP on a custom port | **Yes.** Every callback got code 200. The client says `User-Agent: bitsquid/1.00`. `--tls` isn't needed | `CALLBACK ... code=200` |
| 3. What draws | **The full custom status draws**: three fronts at the custom points, the defend event marker (the warning icon on Sistema Ross), and War Statistics summed from the server's `statistics` (3,489 kills = 1162+1163+1164, 33 deaths, "3 Helldivers online" = the sum of `players`). **`minimal` (status only) also draws**, with the regions moved and the event gone. The statistics stay from the cache | `war-custom.png`, `war-minimal.png` |
| Error answer | `status` goes `offline` and the map keeps the last good state, with no message on screen | `war-error.png` |
| 4. Write acks | Not reached in this run; closed by the mission runs below | |
| 5. Season isolation | `get_current_season()` returns the server's 1162, and the leaderboard request carries `season=1162`. Lobby filtering wasn't tried (needs a second player) | `state` ack, `requests.jsonl` |
| 6. Isolated save | `SaveManager.setup("steam", "helldivers_save")` was turned into `default cmdprobe_<id>` and the backup skipped. **The real local and Steam Cloud saves stayed byte-identical.** No probe file was written either: nothing in this short run triggers a save (no upload, no mission, no return to the title screen), so the disk side is still untested | `end` output |
| 7. Season change from the server | **1162 → 162 (`replay`) made the game play the Galactic Campaign recap and then switch to `season_end` state on its own.** The run killed the game there | `war-replay.png`, `STATE season_end` |

Other things seen:

- A fresh save opens the war screen with the Galactic Campaign tutorial box ("Esta é uma representação..."). `no_tutorial` skipped boot camp; `tutorial_finished` reads **nil**, not false, on a fresh save (fixed in the mod since).
- Reads carry no `sign` header. `get_snapshots` is first sent with only `season`; the recap then sends `season` and `start` (the time of the last recap shown).
- `get_leaderboards` sends the player's Steam ID in `users`. `get_usernames` is asked every 30 s on the ship.
- The replay answers used season 161 snapshots for a season 162 status, so the recap said "Guerra: 161". That is the probe's fixture choice, not a game fact.

What this means for the design:

- **Switching wars is a season change** unless each war has its own save, because `campaign_cache` lives in the save. With per-war saves, each war's cache travels with it and the game sees no change. That makes per-war saves required, not just a safety choice.
- An orchestrator can end a season on purpose by bumping `season`. The game then runs its own recap and season-end screens. Worth a dedicated run to see the season-end flow through.
- The official server's numbers are not needed for the map to work: `campaign_status` alone is enough.

## Mission runs (2026-11-04 and -05, `python probe/run.py all --mission`)

Each run opens the war screen once (which rolls the planets), then the probe's `campaign_mission <front>` picks the easiest open planet, marks its other missions done, and starts the last one the way the drop pods do (`current_planet`, `get_mission_seed`, then the `mission_start` transition with `is_training` false). `win` ends it, `ready` hurries the end screens, and the run waits for the uploads on the ship.

| Run | Front | What happened | Learned |
|---|---|---|---|
| 2 (`20261104-233241`) | bugs | `win` refused, the Helldiver died twice, mission lost | A lost mission uploads statistics (`successful_missions: 0`), acked and the queue emptied. **The probe save was written to disk** (`saves/cmdprobe_<id>.sav`, `_user.sav`, each with an `.old`) and the real saves stayed identical. Question 6 is closed |
| 3 (`20261104-234701`) | bugs | `win` refused again, with the reason logged: `needs_session`, while `lobby_host == peer` and `is_host` true | **Obsidian API keeps shared-game calls (`win`, `effects`) for session mods.** The probe is a client mod on purpose, because session scope turns on the loader's upload block |
| 4 (`20261104-235824`) | bugs | Won (direct calls after the refusal), end screens done in 9 s, back on the ship | `upload_statistics` and `upload_leaderboard_statistics`, both acked, queues emptied. **No planet was reported**: the defend event on the bugs front put the planets in region 3, and mission end only reports when that matches the points' region (5) |
| 5 (`20261105-000736`) | cyborgs | Won, all three writes | `complete_planets` came in: question 4 is closed. **Its `enemy` is 1-based** (2 for this cyborg planet), so the probe server credited the wrong front until fixed |

Request shapes are in [protocol.md](protocol.md#writes). Every run ended with `real saves identical`.

What the mission runs mean for the design:

- **The companion mod can't be a plain session mod** while the loader blocks uploads for session content (`loader/src/backend_block.lua`). Custom-war missions have to upload to the custom server. The loader needs a "custom war active" state: the URL points at the relay, uploads are allowed because they can only reach the relay, and shared-game API calls are open to the war's companion mod. An expansion-like scope is the closest fit.
- **The orchestrator must count enemies from 1 in `complete_planets`** and from 0 everywhere else.
- **A defend event freezes normal planet reporting on its front.** The orchestrator's event design has to account for it: during an event, that front advances only through event missions.

Not covered yet: event missions (`complete_defend_mission`, `complete_attack_mission`), Proving Grounds uploads, lobby isolation with a second player, leaving the season-end flow, and the `broken` scenario.

## Parts

| File | What it does |
|---|---|
| `probe/server.py` | Answers the war API on 127.0.0.1:17491 (`--tls` for HTTPS with a throwaway self-signed certificate). Writes every request to `requests.jsonl`, with the Steam ticket replaced by its size and keys. `/admin/scenario?name=` switches scenarios mid-run |
| `probe/scenarios.py` | `custom` (season 1162, points 45000/12000/78000, a live defend event against the bugs in region 3; completed planets add 1000 per difficulty level), `minimal` (status only, other points), `replay` (the official captures), `error` (code 3), `broken` (no status; only with `--broken`) |
| `probe/mod/` | Mod `obsidian.cmdprobe`, client scope (so the loader's upload block stays off). **Inert without `logs/cmdprobe.cfg`.** Mission commands: `campaign_mission <front>`, `win` (API first, the same game calls directly when the API refuses), `god`, `ready`. With it: post-hook on `CampaignManager.set_environment` sets the probe URL (and a frame check puts it back if something resets it); `SaveManager.setup` goes to a local `cmdprobe_<steam id>` save with no Steam Cloud and no backup; `no_tutorial` and `tutorial_finished` for that fresh save; telemetry dropped; every war callback's HTTP code and size logged; `STATE`, `STATUS`, `POLL` lines in `logs/cmdprobe.log`; commands `poll`, `menu <name>`, `close`, `menus`, `state`, `cache`, `save` |
| `probe/drive.py` | Helldivers Arcade's game driver, renamed to the probe's files |
| `probe/run.py` | `begin`: records the real saves' hashes, purges the real library, deploys API, Patches (four skips on) and the probe into `internal/probe-data`. `play`: server, config, launch, then for each scenario a poll, the state, the war screen (`menu campaign`) and a screenshot. `end`: purge, redeploy the real library if one was deployed, compare the real saves |

Run: `python probe/run.py all` (add `--tls` if a plain HTTP run never gets a `POLL`). Output: `probe/runs/<time>/` with `requests.jsonl`, `cmdprobe.log`, `loader.log` and the shots.

## What each result means

| Seen | Answers |
|---|---|
| A `get_campaign_status` line in `requests.jsonl` and `URL ... probe sets` in the log | 1: the redirect lands before the first poll |
| `CALLBACK update_status_callback code=200` and `POLL season=1162` | 2: plain HTTP works. If instead the code is negative and nothing arrives, rerun with `--tls` |
| `war-custom.png` shows the custom points and the defend event | 3: a full status draws. `war-minimal.png`: the smallest status draws. `war-error.png`: the offline path |
| `SAVE setup asked steam helldivers_save, probe uses default cmdprobe_...`, and `real saves identical` from `end` | 6: the per-war save holds, at least in one session |
| `current_season=1162` from `state`, then `replay` going to 162 | first look at 5 and at what a season change does (7) |
| A write in `requests.jsonl` | 4, live: only if a mission is played during the run. The default run plays none |

## Safety

- The mod does nothing unless the run script wrote `cmdprobe.cfg`, and `run.py` deletes that file at the end of `play` and in `end`.
- The real save isn't loaded or written: the probe uses its own file in `%APPDATA%\Arrowhead\Helldivers\saves\`. `end` checks the real files' hashes, local and Steam Cloud.
- No request goes to `api.helldiversgame.com` while the probe is deployed, and none to the analytics host.
- The server listens on 127.0.0.1 only.
- Season 1162 keeps the run's lobby out of the official matchmaking pool.

## Milestone 1 in the game (2026-11-09, `probe/war_run.py`)

A Vanilla war hosted by `obsidian commander serve` (package 0.1.0, ObsidianLauncher branch `commander`), selected with `obsidian commander play`, played solo on the notebook. Run folder `probe/runs/war-20261109-203529`.

| Check | Result |
|---|---|
| The war line reaches the loader | **V.** `war: byvije through the relay`, the war's pool tag `7c09c894f883`, the Sandbox save `helldivers_sandbox_ba425f1d` |
| The game's war requests go to the relay | **V.** `set_environment` redirected before the first poll; status online with the war's season 1990 and points |
| Region names for the map | **V.** 66 names written in the game's language (`commander-names.txt`) |
| A GM push and a defense from the admin API reach the game | **V.** After one poll: bugs 9,997 to 39,994 points, the cyborgs' defend event active |
| A mission credits the war | **V.** A won illuminate planet: `complete_planets` and statistics through the relay, the front from 9,994 to 10,658 (a region liberated), the player listed by Steam ID |
| The real saves | **V.** Byte-identical before and after |

Found and fixed: fronts started on a region's edge (10,000 points), so pressure crossed it at once and logged three "region lost" entries in every new war; they now start mid-region (15,000). The game's reads carry no player, which listed a phantom "local" member; only identified players are members now.

Seen: opening a war to LAN starts a listener on all networks, and Windows Firewall asks once per server path. The end-to-end script's temporary server copies each ask again; the prompt can be cancelled (the loopback side doesn't need it). The prompt covered this run's war map screenshots, so the map was confirmed through the game's own status lines, not by picture.

## HD2-model probes (2026-11-09, solo)

Two passes of `probe/run.py play --hd2` and `--event`, runs `probe/runs/20261109-174130` and `-180455`. The question was whether a mod can replace the war's client side: draw its own war, launch its own planets, report its own results. Commands are in `probe/mod/main.lua` under "HD2-model probes".

| Hypothesis | Result | Evidence |
|---|---|---|
| A mod makes its own HTTP calls to a custom route | **V.** `Http.create_request("POST", <relay>/commander/report)` with a JSON body; the callback gets `(request, 200, body)` and `Sjson.decode_sjson` reads the answer. Twice, no error | `cmdprobe.log` HTTP lines, `requests.jsonl` |
| Our own planets survive the game's rerolls | **V.** Three planets renamed to invented keys (`cmdwar_planet_1..3`) stayed in place through two region changes: the post-hook on `generate_planets` put them back each time | `PLANETS` lines |
| Custom planet names show in the game's own UI | **V.** The ship banner read "ORBITANDO KEPLER PRIME" and the loading screen "KEPLER PRIME", from `obsidian.game_text` | `stuck.png`, `loadout.png` |
| Globe tinted per region | **V.** All 33 region meshes took our colours over the game's every frame, cleanly | `war-tint.png` |
| Globe hidden | **V.** `Unit.set_unit_visibility(warfront_unit, false)` leaves the starfield, the home world labels and the region markers. Shown again cleanly | `war-hidden.png` |
| Stock war screen muted, our panel drawn | **V, with a gap.** `obsidian.ui.mute("campaign")` and a canvas drew a Major Order panel and liberation bars over the war screen, and the region markers went. Still drawn: the friends and online counts, the heroes table, a faint war statistics header. Those need extra `ui.scope` entries | `war-overlay.png` |
| A custom planet launched the players' way | **V.** `current_planet` set, the pods opened, the Helldiver seated through the pod's own `interact` command, then the game's countdown, its mission briefing (biome, enemy, difficulty from the planet), drop zone, loadout, and the mission. The first try was ignored while a ship dialogue was open: close dialogues first | `retry.png`, `after-brief.png`, `loadout.png` |
| Mission end readable for a custom report | **V.** `StateMissionEnd.on_enter` gave `planet=cmdwar_planet_1 completed=true`, objectives, time, players, extracted, deaths | `MISSIONEND` lines |
| What the stock upload says about a custom planet | `complete_planets` sent `{enemy 2, difficulty 4, success 0.7}` with **no planet name**. So the stock route can't say which planet was played, and the mod's own report is needed | `requests.jsonl` |
| Defend event mission on the stock path | **V.** Built as `setup_event_planets` does, won, and `complete_defend_mission {event_id 9001, difficulty 1}` reached the server. A lost event mission sends nothing | run `-180455` |
| The stock UI shows an event timer | **V, correcting the code reading.** The ship shows "DEFENDER TIBÉRIA" with a bar and a 1:48:01 countdown from the event's `end_time`. One defense with a timer is stock | `stuck.png` |
| Lobby member data size | **V for the sender.** Set and read back at 200, 1000, 2000, 4000 and 8000 characters. Whether peers receive 8000 is untested (needs a second player) | `LOBBY` lines |
| Lobby room data through `NetworkGlobal.lobby:set_data` | Refused (`table index is nil`): the room wrapper only takes its own known keys. Member data is the channel | `LOBBY` lines |

Housekeeping found by the runs: the real save was not written by the probe. The Steam Cloud files' timestamps (11:04, 13:51) predate the run, so the "changed" warning came from Steam syncing at launch. `run.py end` left the probe's patch deployed once, and it was purged and the real library redeployed by hand. `end` should verify the purge.
