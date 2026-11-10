# Commander UX: check of the proposed flow

Short answer: the flow is right and doable. Four changes make it safer and easier to join.

## The flow, with changes

### 1. Commander tab, package download

Doable. Obsidian already downloads and updates mods from GitHub releases, so a separate repo with its own releases fits.

**Change: split what downloads from what stays in Obsidian.**
- **The downloaded package:** the war server, Commander's screens (a web bundle shown inside the tab and styled with Obsidian's colours), and the Evolved War Engine mod.
- **What stays in Obsidian:** the tab itself, the relay, Steam sign-in, and every safety guard. The guards are the per-war save, the separate matchmaking pool, the block on uploads to Arrowhead, and the telemetry block. A Commander update can then never weaken one.
- **Package checks:** releases are signed, and Obsidian checks the signature and the protocol version before running one.

### 2. Create or Join

**Change: joining shouldn't need the package.** A player who only joins needs the relay (in Obsidian) and the war's mods. The server only matters to someone hosting. So Join works from a bare Obsidian, and Create offers the download.

**How joining could look:**
1. Two ways in: an invite code (pasted, or an `obsidian://war/...` link that opens the app), or a server address.
2. A war page shows:
   - the name, the host and the model (Vanilla or Evolved);
   - players online, the day of the war, and the rules;
   - what joining changes: mods to install, mods switched off, and how progress starts (fresh, a copy of the official save, or a preset).
3. **Join:** Steam sign-in the first time, then Obsidian builds a war profile (mods and options), a separate save and the war's pool.
4. **Play.** Home shows which war is active, and going back to the official war is one click.

### 3a. Vanilla War

Doable, and the easiest of the two: **no companion mod at all**. The game draws it as it is, which the probes proved.
- **Uses only the game's own data:** points, regions, three fronts, defend and attack events, Super Earth defenses, and season wins and losses.
- **Server's job:** a tick loop running pushes and events, plus a GM console.
- **Compromise: an approximation of the official war.** Arrowhead's server rules aren't public, so the preset is tuned from the captured snapshot history, not copied.
- **Not tested yet:** leaving the end-of-season screens.
- **Still needs Obsidian:** every player runs Obsidian, because the redirect lives in the loader.

### 3b. Evolved War

Doable as a layer over the game. The probes proved the client side solo (see `docs/probe.md`, "HD2-model probes").

**Change: name the limits in the UI**, so "not constrained to HD2" stays within reach:
- **In reach:**
  - per-planet liberation, sectors, supply lines and Major Orders;
  - defenses with timers, invasions, and a war director;
  - planet modifiers, plus whatever the Obsidian API can drive in a mission (enemy mixes, difficulty, environment presets, rewards, XP);
  - community votes and news.
- **Subfactions:** named sets of those mission modifiers (which enemies, how many, which hazards). Each modifier needs its own in-game check before it ships.
- **Not in reach:** new enemies, biomes, factions or mission types, and more than three fronts.

**Ideas past HD2's template:**
- Supply lines that change which stratagems or reinforcements a front has.
- Planet modifiers that carry over to the neighbouring planets.
- Proving Grounds trials as war events with a front-wide reward.
- Defenses that a squad can extend by finishing side missions on nearby planets.

**Evolved War Engine:** an every-player mod, installed as one of the war's requirements. It needs the loader's new "custom war" scope, which allows shared-game calls and uploads that can only reach the relay.

## Mod lists

The War Browser and the Mod Store are dropped for now (2026-11-09).

### Mod Ban and Require lists

Doable. Most of the mechanism exists: Expansion requirements, profiles, and the lobby handshake that checks every player's mods.
- **Require:** Obsidian installs the listed mods on join. A rule can name a mod ID, a version range, or a scope.
- **Ban:** Obsidian switches the listed mods off in the war profile. Rules can name mods ("no Trainer") or scopes ("no session mods except these"), or the war can be allow-list only.
- **Enforcement, in three layers:**
  1. Obsidian applies the lists before launch.
  2. The relay sends the war server the list of deployed mods and their hashes when the player logs in, and the server refuses a mismatch.
  3. In a lobby, the war's own pool keeps other wars out, and Obsidian's handshake compares every player's mods.
- **Limit:** a modified Obsidian could lie in all three. Same as the cheating limit: it stops honest mistakes and casual cheating, not a determined cheater.

## Decisions for you

1. Joining without the Commander package, with the package only for hosting? (Recommended.)
2. Keep "Evolved War Engine" as the mod's name?
3. Internet play: see `COMMANDER-INTERNET.md`.

## Decided (the user, 2026-11-09)

- Joining works without the package; the package is for hosting.
- The War Browser and the Mod Store are dropped for now.
- No mod ban or require lists yet: no custom war is open to the public.
- The in-app galactic war overview is optional but on by default, mirrors the game's map, and takes actions such as enemy pushes on sectors.
