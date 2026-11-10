# Commander: opening a war to friends over the internet

## What has to cross the internet

Only the war data. Gameplay already works over the internet through Steam: friends join each other in lobbies and Steam carries the game traffic, as it does today. Commander doesn't touch that.

The war data is small: the map state every 60 seconds, a report after each mission, orders and news. That's a few kilobytes a minute per player. The only problem to solve is reaching the war server, which runs inside Obsidian on the host PC, a home PC behind a router.

## What it looks like

**Host**
1. On the war page, a switch: **Open to Friends**.
2. Obsidian shows an **invite link** with a Copy button. The host sends it however they like (Discord, Steam chat).
3. A **Members** list shows the Steam name of each friend, online or last seen, and whether the link is direct or relayed, with **Kick** and **Ban**.
4. A choice: anyone with the link joins, or **the host approves each request** (the default).
5. The war runs while Obsidian is open on the host PC. An option keeps it running in the background, in the tray, after the window closes.

**Friend**
1. Clicks the link (Obsidian opens) or pastes it into **Join** in Commander.
2. Sees the war page: name, host, model, the mods it installs or switches off, and how progress starts.
3. **Join**: Steam sign-in the first time, then waits for approval from the host.
4. Obsidian sets up the mods, save and matchmaking pool for the war. **Play.**
5. In the game, the host and friends find each other through the war lobby pool, or with Steam invites as usual.

**When the host is offline**
- Friends can still open the game. The war map shows the last known state, marked as offline in Commander.
- Missions they play still count. Results wait locally in Obsidian and go to the host when the host is back. The server counts each mission once.
- The war clock pauses while the host is offline, unless the host keeps it running in the background or moves it to a server (below). Otherwise a defense could be lost while nobody could play.

## How it works

```
Friend PC                                                Host PC
helldivers.exe ──► Obsidian relay ══ encrypted link ══► Obsidian ──► war server
   (loopback only)                (direct, or through                (inside Obsidian)
                                   a relay server)
```

- **The game only talks to the PC it runs on**, as now. On the friend PC, the Obsidian relay carries the war data to the host. The Steam login ticket never leaves that PC.
- **The link is peer to peer**, with the iroh library (Rust, QUIC). Each Obsidian gets a key pair. The invite link holds the host public key and a join secret.
- **Connecting:** Obsidian on the friend PC first tries to reach the host PC directly, punching through both routers. Nobody opens a port.
- **When the direct route fails**, the link goes through a **relay server** that forwards the encrypted bytes and can't read them. This is common with strict routers, office networks and some mobile connections.
- **Nobody can pretend to be the host:** the link pins the host key, so a connection to anyone else fails.
- **Identity:** Steam sign-in (OpenID, from Obsidian) tells the host who each friend is. The host server then issues that friend a member key, and kicks and bans go by Steam ID.

### Relay servers

- n0, the maker of iroh, runs free public relays but says they're for development and testing: the limits aren't published and there's no uptime promise ([n0 public relays](https://docs.iroh.computer/iroh-services/relays/public), [rate limiting](https://docs.iroh.computer/relays/rate-limiting)).
- For a release, Obsidian should run **a dedicated relay**: the open-source iroh relay on a small server, about 5 EUR a month. The paid shared relays from n0 are the other option ([dedicated infrastructure](https://docs.iroh.computer/deployment/dedicated-infrastructure)).
- War traffic is so small that bandwidth costs nothing worth counting.
- Hosts can also point Obsidian at a self-hosted relay.

### Privacy

- A direct link shows the host and each friend the internet address of the other. Steam peer-to-peer traffic from the game itself probably does the same already (not checked).
- A **Relay only** option hides the addresses, at the cost of a little delay. Nobody would notice on war data.
- Before approval, someone with the link reaches only the join request, not the war.

## Other ways to open a war

| Way | For | Setup |
|---|---|---|
| **LAN** | Friends on the same network | None. Obsidian finds the war on the local network |
| **Invite link** (above) | Friends over the internet, host plays too | None |
| **Always-on server** | A community war that runs day and night | The same server program on a rented server or a home server (Docker). Joined by address and invite. HTTPS with a real certificate |
| Port forwarding, Tailscale, playit.gg | People who already use them | Documented, not built in |

**Move to a server:** a war started at home can be exported and loaded on a server later. Members keep the places they had, and the invite link points to the new address.

## Limits and unknowns

- **How often the direct route works** isn't published. The relay covers the failures, so a war still connects, just through a relay more often.
- **Firewall prompt:** Windows may ask once whether Obsidian can use the network when the host opens a war (M, needs a check).
- **Networks that block UDP** (some schools and offices): the iroh relay also works over HTTPS, so these should still connect through it (M).
- **Nothing here is built.** The probes proved the game side: a mod sends custom requests to a loopback address, and the game itself only talks to loopback. The relay, the link and the sign-in are all new.
- **Testing:** the link can be tested between the notebook and the main PC with no game running, because it's only war data. The full flow needs two Steam accounts, one per player.

## Decisions for you

1. Is approval by the host the default, with "anyone with the link" as an option?
2. When the host is offline: should the war clock pause (recommended), or keep running?
3. Should Obsidian run a dedicated relay server (about 5 EUR a month), or rely on the paid relays from n0?

## Decided (the user, 2026-11-09)

1. Host approval is the default; "anyone with the link" is an option.
2. The war clock pauses while the host is offline.
3. No paid services: the player population doesn't justify running one yet. Small steps: milestone 1 is local and LAN Vanilla wars, milestone 2 local and LAN Evolved wars with the companion mod. Internet play (and the relay server question) waits.
