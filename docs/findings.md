# Commander: custom Galactic Wars for HD1

Research of 2026-11-04, for the community request (a COMMANDER tab after MODS in Obsidian). Paths like `lifted/...` and `campaign.md` are in `ObsidianLauncher/internal/research/` (`lifted/` and `api/campaign.md`). The wire format is in [protocol.md](protocol.md); the first live check is in [probe.md](probe.md). The probe ran once in the game on 2026-11-04; its results are in [probe.md](probe.md#results-of-the-first-run) and marked below. Confidence: **V** checked against real data or the shipped files, **H** read in lifted code, **M** inferred, **L** needs a live run.

Real responses from the official server sit in [fixtures/official-2026-11-04/](../fixtures/official-2026-11-04/). The usernames response was left out because it lists Steam IDs.

## Verdict

It can be built, and the game makes it easier than expected. The game already supports a different backend, the war protocol is small and plain, and the lobby browser already keeps different wars apart. The hard parts are not the redirect. They are three other things:

1. keeping custom-war progress out of the real save;
2. letting friends join over the internet without exposing the game's insecure HTTP client;
3. most "custom war" content (planets, missions, rewards, XP) is generated **on the client**, not by the server. A server alone can only move points and events. Everything else needs a companion mod that every player runs.

## What the game gives us

| Finding | Where | Conf |
|---|---|---|
| The backend URL comes from one place, `CampaignManager.set_environment`, and the game already reads a `-backend_url` launch argument | `lifted/lua/managers/campaign_manager.lua:188-207` | H |
| Each request is a form-encoded `POST action=...` to one URL, and each response is JSON with `time` and `error_code` (0 = OK, 3 = "Missing or invalid arguments") | same file, `:321`, `:565-743`; fixtures | V |
| 22 action shapes in total: 12 reads (`get_campaign_status`, `get_snapshots`, `get_provinggrounds`, leaderboards, events by id, season statistics, usernames, entitlements) and 7 writes (`upload_statistics`, `upload_leaderboard_*`, `complete_planets`, `complete_defend_mission`, `complete_attack_mission`) | grep of `action=` in `lifted/` | H |
| Status is polled every 60 s. A failure leaves the game in an offline mode that retries (10 s, or 600 s after a server error). A dead local server fails safe | `campaign_manager.lua:240-270`, campaign.md 3.1 | H |
| The official server is still live: season 162, three fronts, 147 players online, 1,346 unique this season. Season 161 lasted 47.7 days with 28,803 unique players | fixtures | V |
| The game's war requests go through the engine's HTTP client (`libcurl.dll` 7.44.0). Commander never depends on how that client treats a remote server: the game only ever talks to the relay on loopback | `binaries/x64/libcurl.dll` | V |
| Planets, missions, environments and rewards are rolled locally from the region (`generate_planets`, `math.random`), and hosts send them to peers by RPC. The server only sends war points, statuses, events, statistics and Proving Grounds seeds | campaign.md 3.2 | H |
| The lobby browser filters by `campaign_season` EQUAL to the player's current season, and room listing drops a room whose season differs. **A custom war with its own season number gets its own matchmaking pool for free** | `#54ca95ed20705469.lua:1882`, `:1905`, `:2250`, `:2302` | H |
| Gameplay networking is Steam lobbies and Steam P2P, separate from the war API. Internet co-op already works. Only the war API needs to be reachable | `#dfe09cb05b745bfa.lua` (`init_steam_client`) | H |
| Every write carries `auth` = the player's Steam session ticket plus `online_id` | `campaign_manager.lua:330-370` | H |
| The save file name can be switched (`Boot.arguments.save_file`, or hook `SaveManager.setup`) | campaign.md 0.7 | H, L live |

## Architecture

```
helldivers.exe ──http://127.0.0.1:<port>/1.0/──► Obsidian relay (loopback only)
   ▲ loader: URL redirect,                         │ validates, strips the Steam ticket,
   │ per-war save, season isolation                │ signs with the war member key
   │                                               ▼
   └── companion mod (Obsidian API) ◄── war rules ── Commander orchestrator
                                                   (local sidecar, LAN, or remote dedicated)
```

1. **Redirect in the loader, not by DNS or the hosts file.** Post-hook `CampaignManager.set_environment` and set `self.url` to the local relay while a war is selected. Without a war selected, nothing changes and the official server stays the default. No admin rights, nothing system-wide, and no one else's traffic is touched. The `-backend_url` argument is the fallback, but Obsidian launches through `steam://rungameid`, and Steam warns about arguments passed that way.
2. **The game only ever talks to loopback.** Since the game sends a Steam ticket with every write, it never contacts a remote war directly. The relay (Rust, in Obsidian) receives the game's requests and then:
   - checks every action and field against a schema, so a hostile server can't feed the game's `Sjson` parser oversized or malformed data;
   - **drops the Steam ticket**, so a war host never receives a ticket that could be replayed against the official API, and swaps in the war's member key;
   - carries the traffic to the war over a verified, encrypted link (see Internet play);
   - serves the last known state and queues uploads while the war host is offline.
3. **The orchestrator** is the "server", a single Rust binary from the new repo. It holds war state in SQLite, runs a tick loop (counterattacks, event scheduling, season end), answers the 22 actions, and exposes an admin API to the tab. The same binary runs headless (`--dedicated`) on a VPS or home server for always-on community wars, like a Minecraft server.
4. **The companion mod** (an `every_player` session mod that requires the Obsidian API) applies the parts the server can't reach. It reads a data-only `obsidian_gm` block that the orchestrator adds to `get_campaign_status`, then applies it through API calls: planet tables, environments, enemy mixes, mission seeds, reward tables, XP and sample rates, enemy caps, environment recipes. It never receives Lua code from the network.

## What a war can change

| Layer | Examples | Needs the companion mod |
|---|---|---|
| Orchestrator only | Points and `points_max` per front, statuses (`active`/`defeated`/`hidden`), front introduction order, season length and end, defend and attack events (region, timing, size), statistics, recap history (`get_snapshots`), Proving Grounds trial and mission seeds, leaderboards, a GM console ("start a defend event on the bugs front, region 5, 48 h"), scripted timelines | No. The stock game reads these |
| Companion mod | Custom planets and biomes per region, remixed missions and objectives, rewards, XP curves and unlock pacing, enemy mixes and limits, environment presets, modifiers per event | Yes, on every player |
| Required mods | A war lists mods by ID and hash, and Obsidian offers to install them on join, like a modpack | Yes. Reuses `obsidian_every` |

"Every parameter exposed" is realistic for the first layer. For the second it means whatever the Obsidian API can drive safely. The 64-enemy limit (`MAX_SAFE`) and the DLC-by-ownership rule still apply.

## Compromises

- **No cheat-proofing.** Without Arrowhead's publisher key, the host can't verify Steam tickets. Identity is the member key Obsidian issues at invite, with a kick and ban list. A custom war is only as fair as its members. Say so in the UI.
- **The official war's logic is unknown.** The server code is not public. A "Classic" preset can be tuned from snapshot history (50 snapshots, 69 defend and 6 attack events per season in the captures) and from how `points_max` scales with players, but it is an approximation, not a copy.
- **Custom wars never count toward the official one, and official progress doesn't carry into them** unless the war allows a one-way copy at start. Options: start fresh, copy the official save once, or a preset loadout.
- **Every player needs Obsidian and the companion mod.** A vanilla friend can't join a custom war. Season isolation already blocks the join, but the message should explain why.
- **The loader needs a "custom war" state** (found in the mission runs). Today a session mod turns on the upload block, and Obsidian API refuses shared-game calls to client mods (`needs_session`). A companion mod needs both shared-game calls and uploads (to the custom server). While a war is selected, uploads can only reach the relay, so the block's purpose is already served. The scope rules have to say that, probably as an expansion-like scope tied to the war.
- **Defend events freeze normal planet reporting on their front**: mission end only reports a planet whose region matches the points' region, and an event moves the front's planets to the event region. War rules have to work with that, not against it.
- **Separate save per war.** It costs a slot in the save logic and a choice about Steam Cloud. Recommendation: keep custom saves local (`SaveSystem`) and back them up with Obsidian, not Steam Cloud.
- **Two UI codebases.** If the tab UI ships with Obsidian, every Commander feature needs an Obsidian release, which defeats the separate repo. So the Commander repo ships its admin UI as a static bundle that the tab hosts and themes with Obsidian's tokens. The tab shell, install and update, and all game-side guards stay in Obsidian.

## Safety measures (non-negotiable)

1. Nothing from a custom war ever reaches `api.helldiversgame.com`. Redirect plus a separate save covers the six upload routes. Route 7 (`feedback`) and route 8 (telemetry to `helldivers.api.wwsga.me`) go through other paths, so block them while a war is active.
2. Switching back to the official war switches the save back **before** the first poll, so a queued custom-war result can't be sent to the official server (same leak as campaign.md 0.2).
3. The relay listens on 127.0.0.1 only, on a random port, with a per-launch token in the path.
4. No DNS, hosts-file or certificate tricks: Commander changes only the game's own war URL, and only to loopback.
5. DLC stays gated by ownership. `available_entitlements` only changes store listings, and a war may not unlock paid content.
6. Public wording: "custom wars", never "replacing the official server". The official war is alive, and the mod should look like a side mode, not a rival. Non-commercial, no game files redistributed.

## Internet play, in order of preference

| Option | Setup for players | Notes |
|---|---|---|
| **Solo** (default) | None | Orchestrator on loopback |
| **LAN** | None | Orchestrator binds to the LAN; discovery by broadcast, or an invite code holding the address |
| **Invite code, peer to peer** | None | Encrypted P2P link between relays with NAT hole punching and relay fallback, so nobody opens a port. Candidate: iroh (Rust; a node ID becomes the invite code). Compromise: hard NATs go through a public relay, and self-hosting one is optional |
| **Dedicated** | The host runs the headless binary or a Docker image | HTTPS with a real certificate (Let's Encrypt, or behind Cloudflare), joined by URL and invite key. Best for persistent community wars |
| Port forwarding, Tailscale, playit.gg | Manual | Documented, not built in |

Gameplay never goes through any of these. It stays on Steam P2P. Each player's relay talks to the war host, so a war carries on between sessions, and every player's uploads land in the same war.

## Repo split

- **New repo** (in ProjectObsidian, MIT like the Kit): orchestrator crate and binary, admin UI bundle, companion mod, protocol spec, response fixtures (the captures), contract tests per action, Docker image. Released on its own channel with signed artifacts. Obsidian downloads it as a sidecar and checks the signature.
- **Obsidian keeps**: the COMMANDER tab shell, sidecar install and update, the relay, the loader redirect, the save switch, season isolation, and the telemetry and feedback blocks. A Commander update can never weaken a guard.
- **Protocol version** in both directions. Obsidian refuses a sidecar or a war it doesn't understand.

## Open questions for live runs

1. Does a post-hook on `set_environment` land before the first poll, so the first request goes to the relay? **Yes (V, probe run 1).**
2. Does the engine's `Http` accept `http://127.0.0.1:<port>/`? **Yes (V).** HTTPS wasn't needed.
3. What is the smallest `get_campaign_status` that draws the war map? **`time`, `error_code` and `campaign_status` alone draw it (V).** A missing `campaign_status` (`broken`) isn't tried yet.
4. What does each write's callback read from the response? **The highest queue `index` accepted, and the client drops entries up to it (V, mission runs 2-5).** All three common writes were seen. `complete_planets` counts enemies from 1, unlike the rest of the protocol ([protocol.md](protocol.md#writes)).
5. Does a custom season number isolate the lobby browser and the join check, and is the save happy with it? Boot walks `lifetime_stats.seasons` (`#37048…:677`), so stay in a modest range (e.g. 1000-9999), far above the official 162.
6. Does a per-war save file work, with Steam Cloud on and off? **Yes, with Cloud on (V):** setup is redirected, the game writes `saves/cmdprobe_<id>.sav` and `_user.sav` (each with an `.old`) after a mission, and the real local and Cloud saves stayed byte-identical through five runs. Cloud off is untested. Per-war saves turn out to be required: switching wars is otherwise a season change (see 7).
7. Does a season end pushed by the server run the season-end flow and come back cleanly (campaign.md 9.22)? **It runs (V):** a season change played the recap and entered `season_end` by itself. Coming back is untested.
8. Two PCs on the same custom war: planets sync, both uploads count once per mission (dedupe by mission seed), events show on both.

## Build order

1. **Probe.** Built in [probe/](../probe/), see [probe.md](probe.md): a test mod points the URL at a local stub that serves scenarios and logs every request. Five runs: 1-4 and 6 answered, 7 in part. Event missions, Proving Grounds, lobby isolation and the season-end exit are still open.
2. **Isolation.** Relay, per-war save, season isolation, telemetry and feedback blocks. Answers 5-6.
3. **Orchestrator core.** State, tick loop, events, persistence, admin API, a "Classic" preset, sidecar packaging.
4. **Tab.** War list (official, local wars, joined wars), create from a template, live console, member list.
5. **Companion mod.** Planets, missions, rewards and progression through the Obsidian API, plus a host-only in-game GM panel.
6. **Internet.** Invite codes (P2P), then dedicated mode and Docker.
7. **Sharing.** War templates as files, scripted timelines, required-mod lists.

Translations wait until right before the first public release, as usual.
