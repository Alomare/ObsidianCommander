# HD1 war API: wire format

What the client sends and reads, from the lifted `CampaignManager` (build 6001293, `ObsidianLauncher/internal/research/lifted/lua/managers/campaign_manager.lua`) and the official responses in [fixtures/](../fixtures/). Line numbers are in that file unless another file is named. **V** seen in real traffic, **H** read in the bytecode, **L** to confirm live.

## Transport

- One URL for everything. On PC the release build uses `https://api.helldiversgame.com/1.0/`; `Boot.arguments.backend_url` overrides it (`:188`). Requests go to `self.url` as it is at send time.
- `POST`, `Content-Type: application/x-www-form-urlencoded;charset=UTF-8`, body `action=<name>&...`. JSON values are `Sjson.encode_json` then `Http.uri_escape`d. (H)
- Writes also carry a `sign` header: a function of the body string (`up_r0(body)`). The official server presumably checks it. A custom server can ignore it. (H)
- Every response is JSON: `time` (server unix time) and `error_code` (0 = OK), plus `error_message` when not 0. Error 3 is "Missing or invalid arguments". (V)
- Client checks (`fn_16`, `:247-270`): code < 0 is an internal error, a code other than 200 fails, then the body must decode with `Sjson.decode_sjson`, then `error_code` must be 0. Any failure sets `status = "offline"` and the retry timer: 10 s after a network error, 600 s after a server answer. (H)
- Status polls every 60 s after a success (`update_timer`). (H)
- HTTP client: `libcurl.dll` 7.44.0 on Schannel. (V)

## Auth

Writes first get a ticket (`begin_get_authentication`), then send `auth` = JSON `{data, online_id, issuer_id, platform}` (`get_auth_blob`, `:322-360`). On Steam: `data` is the Steam session ticket, `online_id` is `Steam.user_id()` (hex), `issuer_id` is 256. Without a ticket a write is skipped and retried later (`update_timer = 10 s`). (H)

A custom server must not keep or forward `data`. The probe server logs only the size and the keys.

## Reads

| Action | Params | Response fields read | Fixture |
|---|---|---|---|
| `get_campaign_status` | | `time`, `campaign_status[3]`, `defend_event`, `attack_events[]`, `statistics[3]` (kept from the cache when missing) | V |
| `get_campaign_status` | `season` | `campaign_status` (season status, for trophies) | V |
| `get_snapshots` | `season`, `start`, `end` | `introduction_order[3]`, `points_max[3]`, `snapshots[] {season, time, data}`, where **`data` is a JSON string** of three `{points, points_taken, status}`; `defend_events[]`, `attack_events[]`. The `time` of the first snapshot becomes `season_start_info` | V (without start and end) |
| `get_defend_event_by_id` | `event_id` | `defend_event` | H |
| `get_attack_event_by_id` | `event_id` | `attack_event` | H |
| `get_season_statistics` | `season` | `statistics` | V |
| `get_provinggrounds` | | `trials[] {enemy, trial_seed, mission_seed, unlocked}` | V |
| `get_leaderboards` | `count`, `season`, `network`, `users` (JSON) | `leaderboards`, `user_leaderboards` | H |
| `get_leaderboards_provinggrounds` | same | same | H |
| `get_top_of_leaderboard_provinggrounds` | `season`, `network` | `experts` | H |
| `get_usernames` | `count`, `network` | `usernames[]` (hex Steam IDs) | V |
| `get_available_entitlements` | | `entitlements[] {name, available}`. Changes only which store entries the armory lists | V |

`campaign_status[i]` is positional: index 1 is bugs, 2 cyborgs, 3 illuminates (`enemy + 1`). Fields: `season`, `points`, `points_taken`, `points_max`, `status` (`active`, `defeated`, `hidden`), `introduction_order`. The current season is `campaign_status[1].season` (`get_current_season`). The region is `clamp(floor(points / (points_max / 10)) + 1, 1, 10)`.

The Commander server adds `shown_season` to each row: the war season as people see it, from 1. The game reads only the fields it knows. In war mode the Obsidian loader takes `season - shown_season` as the offset and prints the war season in the two game texts with `#SEASON` (the recap date and the season end statistics title), while the game season still goes to the lobby, the requests and the save.

Events: `{season, event_id, start_time, end_time, region, enemy, points_max, points, status}`, where status is `active`, `success` or `fail`. Attack events add `players_at_start` and `max_event_id`. The client adds `event_type`.

## Writes

Each queue entry the client sends has an `index`. The server answers with the highest index it took. The client stores it in `backend_<kind>_index_<platform>` and drops queue entries with `index <=` that value (`StateMenu.*_registered`, `state_menu.lua:2299-2378`). A missing field keeps the stored index. (V, probe runs 2-5: indexes stored, queues emptied)

Real requests, from probe runs 4 and 5 (one solo mission each, won):

```
upload_statistics              statistics=[{"index":4,"enemy":1,"season":1162,"missions":1,"successful_missions":1,
                                            "mission_difficulty":1,"players":1,"kills":0,"deaths":0,"shots":0,"hits":0,"accidentals":0}]
upload_leaderboard_statistics  statistics=[{"index":2,"enemy":1,"season":1162,"planets":1,"score":1,"player_xp":105,"playtime":19}]
complete_planets               planets=[{"index":1,"enemy":2,"season":1162,"difficulty":4,"success":0.700004995}]
```

- **`complete_planets` counts enemies from 1** (the `enemy` field of each planet: 1 bugs, 2 cyborgs, 3 illuminates). Everything else counts from 0. The run 5 mission was a cyborg one: statistics said `enemy: 1`, the planet said `enemy: 2`. (V)
- `difficulty` is the sum of (mission difficulty + 1) over the missions on the planet, and `success` is a fraction, not a flag (`state_mission_end.lua:245-301`). (V, H for the formula)
- A planet is only reported when all missions on the planet are completed, the planet isn't a boss, the status is online, and `current_region` on the planets equals `calculate_region(points, points_max)`. While a defend event runs on a front, the war screen puts the planets of that front in the event region, so those completions are usually not reported (run 4). Event missions report through `complete_defend_mission` instead. (V)
- A lost mission still uploads statistics (`successful_missions: 0`, run 2) but sends no leaderboard row and no planet. (V)
- Writes carry a 40-character `sign` header; reads carry none. `auth.data` was 300 characters. (V)

| Action | Params | Ack field | Also read |
|---|---|---|---|
| `complete_planets` | `auth`, `planets` (JSON) | `completed_planets` | `time`, `campaign_status` (replaces the cache) |
| `upload_statistics` | `auth`, `statistics` (JSON) | `uploaded_statistics` | |
| `upload_statistics` | `auth`, `c` (random number) | | the tamper report (`feedback`, `:938`) |
| `upload_leaderboard_statistics` | `auth`, `statistics` (JSON) | `uploaded_leaderboard_statistics` | |
| `upload_leaderboard_provinggrounds_statistics` | `auth`, `statistics` (JSON) | `uploaded_leaderboard_provinggrounds_statistics` | |
| `complete_defend_mission` | `event_id`, `difficulty`, `auth` | | the full status (goes through `update_status_callback`) |
| `complete_attack_mission` | `event_id`, `difficulty`, `auth` | | the full status |

Not seen yet: `complete_defend_mission`, `complete_attack_mission`, `upload_leaderboard_provinggrounds_statistics`, and the `feedback` form of `upload_statistics`.

## Matchmaking

Lobby room data carries `campaign_season` and `build_game_hash` (`GameSettings.room_data_values`). The browser adds a filter `campaign_season EQUAL CampaignManager:get_current_season()` (`#54ca95ed20705469.lua:1905`), and room listing skips rooms with a different season (`:1882`). A war with a separate season number therefore has a separate pool. (H, L live)
