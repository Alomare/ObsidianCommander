-- Commander probe. Points the Galactic War at a local test server and writes what the game does with
-- the answers to logs/cmdprobe.log. Inert unless logs/cmdprobe.cfg exists, which probe/run.py writes and
-- removes. Commands come through logs/cmdprobe.cmd, answered in logs/cmdprobe.ack (probe/drive.py).
--
-- cmdprobe.cfg, one key=value per line:
--   url=http://127.0.0.1:17491/1.0/   where the war requests go
--   isolate_save=1                     use the save cmdprobe_<steam id> in the local saves folder, no
--                                      Steam Cloud and no backup, so the real save never sees this war
--   block_telemetry=1                  drop the analytics events (they go to another host)
local LOGS = os.getenv("APPDATA") .. "\\Arrowhead\\Helldivers\\ObsidianLauncher\\logs\\"
local LOG, CMD, ACK, CFG = LOGS .. "cmdprobe.log", LOGS .. "cmdprobe.cmd", LOGS .. "cmdprobe.ack", LOGS .. "cmdprobe.cfg"

local function g(name) return rawget(_G, name) end

local function log(...)
	local parts = {}
	for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
	local f = io.open(LOG, "a")
	if f then
		f:write(os.date("%H:%M:%S "), table.concat(parts, " "), "\n")
		f:close()
	end
end

local function read_config()
	local f = io.open(CFG, "r")
	if not f then return nil end
	local cfg = {}
	for line in f:lines() do
		local k, v = string.match(line, "^%s*([%w_]+)%s*=%s*(.-)%s*$")
		if k then cfg[k] = v end
	end
	f:close()
	return cfg
end

local cfg = read_config()
if not cfg or not cfg.url or cfg.url == "" then
	return
end
do
	local f = io.open(LOG, "w")
	if f then f:close() end
end
local URL = cfg.url
local ISOLATE = cfg.isolate_save ~= "0"
local BLOCK_TELEMETRY = cfg.block_telemetry ~= "0"
-- A fresh save skips boot camp: always with the probe save, and on request (a new war Sandbox).
local NO_TUTORIAL = ISOLATE or cfg.no_tutorial == "1"
log("PROBE loading url=" .. URL .. " isolate_save=" .. tostring(ISOLATE) .. " block_telemetry=" .. tostring(BLOCK_TELEMETRY))

-- A compact dump for tables, depth-limited, keys sorted so two dumps compare.
local function dump(v, depth, seen)
	depth, seen = depth or 0, seen or {}
	local kind = type(v)
	if kind == "string" then return string.format("%q", v) end
	if kind ~= "table" then return tostring(v) end
	if seen[v] then return "<cycle>" end
	if depth > 5 then return "{...}" end
	seen[v] = true
	local keys = {}
	for k in pairs(v) do keys[#keys + 1] = k end
	table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
	local out = {}
	for _, k in ipairs(keys) do out[#out + 1] = tostring(k) .. "=" .. dump(v[k], depth + 1, seen) end
	seen[v] = nil
	return "{" .. table.concat(out, ",") .. "}"
end

-- 1. The redirect. go_online calls set_environment only while url is nil, and every request reads
-- self.url, so the post-hook covers the first poll and the frame check below covers a later reset.
obsidian.hook("CampaignManager", "set_environment", function(original, self, ...)
	local r = { original(self, ...) }
	log("URL game chose " .. tostring(self.url) .. ", probe sets " .. URL)
	self.url = URL
	return unpack(r)
end)

-- 2. A separate save. The Steam Cloud path calls setup("steam", "helldivers_save") and then a
-- backup into helldivers_steam_<id>; both are turned to a local file that only this probe uses.
if ISOLATE then
	obsidian.hook("SaveManager", "setup", function(original, self, system, name, ...)
		local steam = g("Steam")
		local ok, id = pcall(function() return steam.user_id() end)
		local probe_name = "cmdprobe_" .. tostring(ok and id or "unknown")
		log("SAVE setup asked " .. tostring(system) .. " " .. tostring(name) .. ", probe uses default " .. probe_name)
		return original(self, "default", probe_name, ...)
	end)
	obsidian.hook("SaveManager", "set_backup_system", function(_, _, system, name)
		log("SAVE backup " .. tostring(system) .. " " .. tostring(name) .. " skipped")
	end)
end

-- 3. Analytics go to helldivers.api.wwsga.me, not the war server.
if BLOCK_TELEMETRY then
	obsidian.hook("TelemetryWwsgaManager", "queue_event", function() end)
end

-- 4. Every answer the war code gets: HTTP code, size, error text. The game builds these callbacks
-- with callback(self, name), which looks the method up at call time, so a table hook sees them.
local CALLBACKS = {
	"update_status_callback", "completed_planets_callback", "upload_statistics_callback",
	"leaderboard_stats_callback", "leaderboard_provinggrounds_stats_callback",
	"request_season_status_callback", "request_provinggrounds_callback", "request_leaderboards_callback",
	"request_defend_event_by_id_callback", "request_attack_event_by_id_callback",
	"get_season_statistics_callback", "get_available_entitlements_callback", "get_usernames_callback",
}
for _, name in ipairs(CALLBACKS) do
	obsidian.hook("CampaignManager", name, function(original, self, job, a2, code, body, err, ...)
		local r = { original(self, job, a2, code, body, err, ...) }
		log("CALLBACK " .. name .. " code=" .. tostring(code) .. " bytes=" .. tostring(type(body) == "string" and #body or nil)
			.. " err=" .. tostring(err) .. " status_after=" .. tostring(self.status))
		return unpack(r)
	end)
end

local api = obsidian.import("obsidian.api")

local function state()
	local boot = g("Boot")
	local sm = type(boot) == "table" and boot.state_machine
	if not sm then return nil, nil end
	return sm:get_current_state(), sm:get_current_state_name()
end

local function war_line(cm)
	local cache = cm.cache or {}
	local status = cache.status
	local parts = {}
	if type(status) == "table" then
		for i = 1, 3 do
			local s = status[i]
			if type(s) == "table" then
				parts[#parts + 1] = string.format("%d:%s/%s %s", i - 1, tostring(s.points), tostring(s.points_max), tostring(s.status))
			end
		end
	end
	local ev = cache.defend_event
	return "season=" .. tostring(type(status) == "table" and status[1] and status[1].season)
		.. " fronts=[" .. table.concat(parts, " ") .. "]"
		.. " defend=" .. tostring(type(ev) == "table" and (tostring(ev.event_id) .. ":" .. tostring(ev.status)) or nil)
		.. " last_update=" .. tostring(cache.last_update)
end

local COMMANDS = {}

-- Asks for a status now instead of waiting for the 60 s timer.
function COMMANDS.poll()
	local cm = g("CampaignManager")
	cm:set_update_timer(0)
	return "timer 0"
end

function COMMANDS.menu(name)
	local ok, why = api.ui.open(name)
	return tostring(ok) .. " " .. tostring(why)
end

function COMMANDS.close()
	return tostring(api.ui.close())
end

function COMMANDS.menus()
	return table.concat(api.ui.menus(), " ")
end

function COMMANDS.state()
	local cm = g("CampaignManager")
	local _, name = state()
	local season_ok, season = pcall(cm.get_current_season, cm)
	return "state=" .. tostring(name) .. " url=" .. tostring(cm.url) .. " status=" .. tostring(cm.status)
		.. " current_season=" .. tostring(season_ok and season or ("error " .. tostring(season))) .. " " .. war_line(cm)
end

function COMMANDS.cache()
	local cm = g("CampaignManager")
	log("CACHE " .. dump(cm.cache))
	return "dumped"
end

-- The save keys a fresh probe save starts with, where the planets stand, and the upload queues with
-- the indexes the server acknowledged.
function COMMANDS.save()
	local sm = g("SaveManager")
	local keys = { "tutorial_finished", "current_planet", "campaign_progress", "season_start_info",
		"mission_stats", "mission_stats_to_upload", "completed_planets" }
	local out = {}
	for _, k in ipairs(keys) do
		local ok, v = pcall(sm.get, sm, k)
		out[#out + 1] = k .. "=" .. (ok and dump(v) or "error")
	end
	local um = g("UserManager")
	local uid_ok, uid = pcall(um.get_user_id, um)
	local platform_ok, platform = pcall(function() return g("Application").platform() end)
	local user_keys = { "leaderboard_stats", "leaderboard_stats_to_upload", "player_xp", "research_samples" }
	if platform_ok then
		for _, kind in ipairs({ "planet", "mission_stats", "leaderboard_stats", "leaderboard_provinggrounds_stats" }) do
			user_keys[#user_keys + 1] = "backend_" .. kind .. "_index_" .. tostring(platform)
		end
	end
	for _, k in ipairs(user_keys) do
		local ok, v = pcall(sm.user_get, sm, k, uid_ok and uid or nil)
		out[#out + 1] = "user." .. k .. "=" .. (ok and dump(v) or "error")
	end
	log("SAVEKEYS " .. table.concat(out, " "))
	return "dumped"
end

-- A real campaign mission on the easiest planet of a front (1 bugs, 2 cyborgs, 3 illuminates), with
-- the other missions of that planet marked done so finishing this one completes the planet. The war
-- screen must have been opened once, since it rolls the planets. Done the way the ship does it: the
-- planet goes into current_planet, get_mission_seed picks the open mission, then the same transition
-- the drop pods start, with is_training false.
function COMMANDS.campaign_mission(rest)
	local enemy = tonumber(rest) or 1
	local sm, menu = g("SaveManager"), state()
	if not (api.game.on_ship() and type(menu) == "table" and menu.state_machine) then return "not on ship" end
	local available = sm:get("available_planets")
	local front = type(available) == "table" and available[enemy]
	if type(front) ~= "table" or type(front.planets) ~= "table" or #front.planets == 0 then return "no planets rolled for front " .. enemy end
	local best, best_index
	for i, p in ipairs(front.planets) do
		if not p.boss and not p.completed and type(p.missions) == "table" and #p.missions > 0
			and (not best or (p.difficulty or 99) < (best.difficulty or 99)) then
			best, best_index = p, i
		end
	end
	if not best then return "no open planet" end
	local last = #best.missions
	for k = 1, last - 1 do best.missions[k].completed = true end
	best.missions[last].completed = false
	sm:set("available_planets", available)
	local planet = table.clone(best)
	planet.region = front.current_region
	planet.selected_mission_index = last
	sm:set("selected_trial", nil)
	sm:set("next_mission_seed", nil)
	sm:set("current_planet", planet)
	local seed = menu:get_mission_seed()
	local mission = planet.missions[last]
	local lobby = g("NetworkGlobal") and g("NetworkGlobal").lobby
	local params = {
		wanted_state = "mission_start", mission_seed = seed, num_research_samples = mission.num_research_samples,
		planet_name = planet.name, planet_region = planet.region, planet_reward = planet.reward, is_last_mission = true,
		is_training = false, active_players = menu:get_active_players(),
		reserved_slots = type(menu.get_reserved_slots) == "function" and menu:get_reserved_slots() or {},
		game_id = math.create_weak_unique_identifier(), host_name = g("UserManager"):get_name(),
		initial_host = lobby and lobby.lobby_host and lobby:lobby_host() or nil,
	}
	log("MISSION setup front=" .. enemy .. " planet=" .. tostring(planet.name) .. " index=" .. best_index
		.. " difficulty=" .. tostring(planet.difficulty) .. " region=" .. tostring(planet.region) .. " missions=" .. last
		.. " seed=" .. tostring(seed) .. " reward=" .. tostring(planet.reward))
	sm:set("dropzone_position", nil)
	menu.state_machine:change_state("transition", params)
	return "launching " .. tostring(planet.name)
end

-- Obsidian API first. In the 2026-11-04 runs it refused with needs_session: the probe is a client mod,
-- and the API keeps shared-game calls for session mods, while a session mod would turn on the loader
-- upload block this probe is here to get past. So on a refusal it does what win does, directly: mark
-- the local players extracted and complete the mission. The reason and the host view are logged.
function COMMANDS.win()
	local ok, why = api.mission.win()
	local lobby = g("NetworkGlobal") and g("NetworkGlobal").lobby
	local host_ok, host = pcall(function() return lobby and lobby:lobby_host() end)
	local peer_ok, peer = pcall(function() return g("Network").peer_id() end)
	local is_ok, is_host = pcall(function() return lobby and lobby:is_host() end)
	log("WIN api=" .. tostring(ok) .. " why=" .. tostring(why) .. " lobby=" .. tostring(lobby ~= nil)
		.. " lobby_host=" .. tostring(host_ok and host or "error") .. " peer=" .. tostring(peer_ok and peer or "error")
		.. " is_host=" .. tostring(is_ok and is_host or "error"))
	if ok then return "api" end
	if why == "not_in_mission" then return "refused " .. tostring(why) end
	local st = state()
	for _, p in ipairs(st.players or {}) do
		if p.player_go:exists() and p.player_go:owned() then p.player_go:set("has_extracted", true) end
	end
	st.mission_manager:set_mission_completed()
	st.mission_manager:set_extraction_done()
	return "direct after " .. tostring(why)
end

function COMMANDS.god()
	return tostring(api.effects.set("god", true))
end

-- Marks every local player ready on the mission end screens, as pressing continue does.
function COMMANDS.ready()
	local st, name = state()
	if name ~= "mission_end" or type(st) ~= "table" or type(st.players) ~= "table" then return "not at mission end (" .. tostring(name) .. ")" end
	local n = 0
	for _, p in ipairs(st.players) do
		if p.player_go and p.player_go:exists() and p.player_go:owned() then
			for _, key in ipairs({ "is_ready", "is_ready_planet", "is_ready_genocide" }) do pcall(p.player_go.set, p.player_go, key, true) end
			n = n + 1
		end
	end
	local sub = type(st.current_state) == "table" and st.current_state.name
	return "ready " .. n .. " in " .. tostring(sub)
end

-- ===== HD2-model probes (2026-11-09) =====

-- A. The mod HTTP to a custom route: the same call shapes as CampaignManager.begin_update_status.
local BASE = string.gsub(URL, "/1%.0/?$", "")
function COMMANDS.http(rest)
	local http, sjson = g("Http"), g("Sjson")
	local body = sjson.encode_json({ kind = "mission_report", planet = "cmdwar_planet_1", success = true, kills = 42, note = rest })
	local req = http.create_request("POST", BASE .. "/commander/report", function(...)
		local n, parts = select("#", ...), {}
		for i = 1, n do
			local v = select(i, ...)
			parts[#parts + 1] = type(v) == "string" and string.format("%q", string.sub(v, 1, 300)) or tostring(v)
		end
		log("HTTP callback args=" .. n .. " " .. table.concat(parts, " "))
		for i = 1, n do
			local v = select(i, ...)
			if type(v) == "string" and string.sub(v, 1, 1) == "{" then
				local ok, t = pcall(sjson.decode_sjson, v)
				log("HTTP decoded ok=" .. tostring(ok) .. " " .. dump(t))
			end
		end
	end)
	req:add_header("Content-Type", "application/json")
	req:set_body(body)
	req:send()
	return "sent " .. #body .. " bytes to " .. BASE .. "/commander/report"
end

-- A2. One request with a given method (2026-11-11, Evolved war): `httpm <METHOD> <url>`. POST goes
-- with a JSON body, as the game sends; the answer code and the start of the body go to the log.
function COMMANDS.httpm(rest)
	local method, url = string.match(rest or "", "^(%S+)%s+(%S+)$")
	if not method then return "usage: httpm <METHOD> <url>" end
	local req = g("Http").create_request(method, url, function(_, code, body)
		log("HTTPM " .. method .. " " .. url .. " -> " .. tostring(code) .. " " .. string.sub(tostring(body), 1, 100))
	end)
	if not req then return "no request for " .. method end
	if method == "POST" then
		req:add_header("Content-Type", "application/json")
		req:set_body("{}")
	end
	req:send()
	return "sent " .. method .. " " .. url
end

-- B. Custom persistent planets. Takes the rolled planets of a front, renames the first three to
-- invented keys with custom words, marks them scanned, and keeps copies; a post-hook on
-- generate_planets puts the copies back after every reroll.
local CUSTOM = {}
local CUSTOM_NAMES = { "Kepler Prime", "Vandalon IV", "Ursa Station" }
local reapplied = 0
local function apply_custom()
	local sm = g("SaveManager")
	local available = sm:get("available_planets")
	if type(available) ~= "table" then return false end
	local changed = false
	for front, list in pairs(CUSTOM) do
		local f = available[front]
		if type(f) == "table" and type(f.planets) == "table" then
			for i, p in ipairs(list) do
				local cur = f.planets[i]
				if not cur or cur.name ~= p.name or cur.seed ~= p.seed then
					f.planets[i] = table.clone(p)
					changed = true
				end
			end
		end
	end
	if changed then
		sm:set("available_planets", available)
		reapplied = reapplied + 1
	end
	return changed
end
obsidian.hook("MenuScreenCampaign", "generate_planets", function(original, self, ...)
	local r = { original(self, ...) }
	if next(CUSTOM) then
		local before = {}
		local av = g("SaveManager"):get("available_planets")
		for front in pairs(CUSTOM) do
			local f = av and av[front]
			before[#before + 1] = front .. ":" .. tostring(f and f.planets and f.planets[1] and f.planets[1].name) .. "/r" .. tostring(f and f.current_region)
		end
		local changed = apply_custom()
		log("PLANETS generate_planets ran, first planet before reapply " .. table.concat(before, " ") .. ", reapplied=" .. tostring(changed))
	end
	return unpack(r)
end)
function COMMANDS.custom_planets(rest)
	local front = tonumber(rest) or 2
	local sm = g("SaveManager")
	local available = sm:get("available_planets")
	local f = type(available) == "table" and available[front]
	if type(f) ~= "table" or type(f.planets) ~= "table" or #f.planets < 3 then return "no planets rolled for front " .. front end
	CUSTOM[front] = {}
	for i = 1, 3 do
		local p = f.planets[i]
		p.name = "cmdwar_planet_" .. i
		p.is_scanned = true
		obsidian.game_text(p.name, CUSTOM_NAMES[i])
		CUSTOM[front][i] = table.clone(p)
	end
	sm:set("available_planets", available)
	local out = {}
	for i, p in ipairs(CUSTOM[front]) do
		out[#out + 1] = p.name .. " d" .. tostring(p.difficulty) .. " env" .. tostring(p.environment) .. " seed" .. tostring(p.seed) .. " m" .. #p.missions
	end
	log("PLANETS custom front " .. front .. " region " .. tostring(f.current_region) .. ": " .. table.concat(out, ", "))
	return "custom " .. #out
end
function COMMANDS.planets(rest)
	local av = g("SaveManager"):get("available_planets")
	local out = {}
	for front = 1, 3 do
		local f = av and av[front]
		local names = {}
		for _, p in ipairs(f and f.planets or {}) do names[#names + 1] = tostring(p.name) end
		out[#out + 1] = front .. "(r" .. tostring(f and f.current_region) .. "):" .. table.concat(names, ",")
	end
	log("PLANETS now " .. table.concat(out, " | ") .. " reapplied=" .. reapplied)
	return "listed"
end

-- C. The globe: the custom colours on every region mesh after the stock ones, or the whole globe hidden.
local TINT, HIDE = false, nil
local PALETTE = {
	{ { 250, 60, 200, 255 }, { 200, 20, 80, 160 } },  -- held: blue
	{ { 250, 255, 220, 40 }, { 220, 140, 110, 10 } }, -- contested: amber
	{ { 250, 255, 60, 60 }, { 200, 110, 20, 20 } },   -- enemy: red
}
local tinted_frames = 0
obsidian.hook("MenuScreenCampaign", "update", function(original, self, ...)
	local r = { original(self, ...) }
	local unit = self.warfront_unit
	if unit and HIDE ~= nil then
		pcall(g("Unit").set_unit_visibility, unit, not HIDE)
		if HIDE == false then HIDE = nil end
	end
	if TINT and unit then
		local Unit_, Mesh_, Material_, ColorAux_ = g("Unit"), g("Mesh"), g("Material"), g("ColorAux")
		local n = 0
		for fi, race in ipairs(g("DifficultySettings").enemy_lookup) do
			for ri, region in ipairs(g("CampaignSettings").warfront_info.warfronts[race]) do
				local pick = PALETTE[((ri + fi) % 3) + 1]
				local mesh = Unit_.mesh(unit, region.mesh)
				Material_.set_color(Mesh_.material(mesh, "m_border"), "diffuse_tint", ColorAux_.from_table(pick[1]))
				Material_.set_color(Mesh_.material(mesh, "m_fill"), "diffuse_tint", ColorAux_.from_table(pick[2]))
				n = n + 1
			end
		end
		tinted_frames = tinted_frames + 1
		if tinted_frames == 1 then log("GLOBE tinted " .. n .. " region meshes") end
	end
	return unpack(r)
end)
function COMMANDS.tint(rest)
	TINT = rest ~= "off"
	tinted_frames = 0
	return "tint " .. tostring(TINT)
end
function COMMANDS.globe(rest)
	HIDE = rest == "hide"
	return "hide " .. tostring(HIDE)
end

-- D. The campaign screen muted, with the custom war panel drawn over it.
local OVERLAY = false
local ui = obsidian.ui
local overlay_frames = 0
if ui then
	ui.on("campaign", {
		draw = function(kit, data, dt)
			if not OVERLAY then return end
			overlay_frames = overlay_frames + 1
			kit:panel{ 40, 380, 420, 300, cut = 16, corners = "tr bl", fill = "#101418e0", line = "#ffc433" }
			kit:text("MAJOR ORDER", 60, 640, { font = "heading", size = 32, tracking = 2 })
			kit:text("Liberate Kepler Prime before the timer ends", 60, 605, { font = "body", size = 18 })
			kit:text("Kepler Prime", 60, 560, { font = "body_large", size = 22 })
			kit:bar(60, 530, 380, 16, 0.42, "#3cc8ff", "#303030")
			kit:text("42.0% liberated   -1.5%/h   23:41:07", 60, 505, { font = "body", size = 18 })
			kit:text("Vandalon IV   DEFEND", 60, 465, { font = "body_large", size = 22, color = "#ff5040" })
			kit:bar(60, 435, 380, 16, 0.7, "#ff5040", "#303030")
			if overlay_frames == 1 then log("OVERLAY first frame on " .. tostring(ui.current().screen) .. " sub " .. tostring(ui.current().sub)) end
		end,
	})
end
function COMMANDS.overlay(rest)
	if not ui then return "no obsidian.ui" end
	OVERLAY = rest ~= "off"
	overlay_frames = 0
	local cur = ui.current()
	local ok, why
	if rest == "mute" then ok, why = ui.mute("campaign") elseif rest == "unmute" or rest == "off" then ok, why = ui.unmute("campaign") end
	return "overlay " .. tostring(OVERLAY) .. " mute " .. tostring(ok) .. " " .. tostring(why) .. " screen " .. tostring(cur and cur.screen)
end

-- E. How much a lobby carries: member data (what api.lobby.share uses) and the host lobby data.
function COMMANDS.lobby(rest)
	local lobby = g("NetworkGlobal") and g("NetworkGlobal").lobby
	if not lobby then return "no lobby" end
	local me = g("Network").peer_id()
	local out = {}
	for _, size in ipairs({ 200, 1000, 2000, 4000, 8000 }) do
		local value = string.rep("x", size - 8) .. string.format("%08d", size)
		local ok, err = pcall(lobby.set_member_data, lobby, "cmdwar_m", value)
		local rok, back = pcall(lobby.member_data, lobby, me, "cmdwar_m")
		out[#out + 1] = "member" .. size .. "=" .. tostring(ok) .. "/" .. (rok and type(back) == "string" and #back or tostring(back))
		log("LOBBY member " .. size .. " set=" .. tostring(ok) .. " " .. tostring(err) .. " read=" .. tostring(rok) .. " len=" .. tostring(rok and type(back) == "string" and #back or back))
	end
	pcall(lobby.set_member_data, lobby, "cmdwar_m", "")
	local engine = lobby.lobby
	for _, size in ipairs({ 200, 1000, 4000 }) do
		local value = string.rep("y", size)
		local ok, err = pcall(lobby.set_data, lobby, "cmdwar_l", value)
		local rok, back = pcall(function() return engine:data("cmdwar_l") end)
		out[#out + 1] = "lobby" .. size .. "=" .. tostring(ok) .. "/" .. (rok and type(back) == "string" and #back or tostring(back))
		log("LOBBY data " .. size .. " set=" .. tostring(ok) .. " " .. tostring(err) .. " read=" .. tostring(rok) .. " len=" .. tostring(rok and type(back) == "string" and #back or back))
	end
	pcall(lobby.set_data, lobby, "cmdwar_l", nil)
	return table.concat(out, " ")
end

-- F. Launch a custom planet the way players do: current_planet set, pods opened, the Helldiver seated
-- through the pod interact command, then the game countdown and drop.
function COMMANDS.pod_launch(rest)
	local front = tonumber(rest) or 2
	local list = CUSTOM[front]
	if not list then return "no custom planets on front " .. front end
	local sm, menu = g("SaveManager"), state()
	if not (api.game.on_ship() and type(menu) == "table") then return "not on ship" end
	apply_custom()
	local available = sm:get("available_planets")
	local f = available[front]
	local p = f.planets[1]
	local last = #p.missions
	for k = 1, last - 1 do p.missions[k].completed = true end
	p.missions[last].completed = false
	sm:set("available_planets", available)
	CUSTOM[front][1] = table.clone(p)
	local planet = table.clone(p)
	planet.region = f.current_region
	planet.selected_mission_index = last
	sm:set("selected_trial", nil)
	sm:set("next_mission_seed", nil)
	sm:set("current_planet", planet)
	local EntityAux_ = g("EntityAux")
	pcall(menu.enable_pods, menu)
	local unit = api.game.my_unit()
	local pods = menu.entity_manager:get_master_entities("drop_pod")
	local seated, why = false, "no pod"
	for pod in pairs(pods) do
		if EntityAux_.has_component_master(pod, "seat") then
			local st = EntityAux_.state_master(pod, "seat")
			local actor
			for a in pairs(st.actor_to_seat or {}) do actor = a break end
			if actor then
				EntityAux_.queue_command_master(pod, "seat", "interact", { actor = actor, interactor = unit })
				seated, why = true, "actor " .. tostring(actor)
				break
			end
			why = "seat with no actors"
		end
	end
	log("POD launch planet=" .. tostring(planet.name) .. " seated=" .. tostring(seated) .. " " .. why .. " menu_state=" .. tostring(menu.menu_state))
	return "pod " .. tostring(seated) .. " " .. why
end
function COMMANDS.menu_state()
	local menu = state()
	if type(menu) ~= "table" then return "no state" end
	local ok, n = pcall(menu.get_occupied_drop_pod_count, menu)
	return "menu_state=" .. tostring(menu.menu_state) .. " pods=" .. tostring(ok and n or n) .. " countdown=" .. tostring(menu.countdown_timer)
end

-- G. A defend event mission on the stock path, built as MenuScreenCampaignPlanet.setup_event_planets does.
function COMMANDS.event_mission()
	local cm, sm, menu = g("CampaignManager"), g("SaveManager"), state()
	if not (api.game.on_ship() and type(menu) == "table" and menu.state_machine) then return "not on ship" end
	local ev = cm:get_active_defend_event()
	if not ev then return "no active defend event" end
	local DS, CS = g("DifficultySettings"), g("CampaignSettings")
	local race = DS.enemy_lookup[ev.enemy + 1]
	local info = CS.get_region_info(race, ev.region)
	if not (info and info.defend_info) then return "no defend_info for region " .. tostring(ev.region) end
	local d = info.defend_info
	local difficulty = 1
	local missions = { { completed = false, seed = DS.modulate_seed_for_planet(d[3], d[1], d[2], ev.enemy, DS.get_mission_type_value("mission"), difficulty, math.random(0, 2147483646)), num_research_samples = 0 } }
	local planet = { is_scanned = true, position = 17, region = ev.region, name = info.city_name, difficulty = difficulty,
		environment = d[1], environment_variant = d[2], shading_environment = d[3], enemy = ev.enemy,
		defend_event = ev.event_id, seed = d[4], missions = missions, selected_mission_index = 1 }
	sm:set("selected_trial", nil)
	sm:set("next_mission_seed", nil)
	sm:set("current_planet", planet)
	local seed = menu:get_mission_seed()
	local lobby = g("NetworkGlobal") and g("NetworkGlobal").lobby
	local params = {
		wanted_state = "mission_start", mission_seed = seed, num_research_samples = 0,
		planet_name = planet.name, planet_region = planet.region, planet_reward = planet.reward, is_last_mission = true,
		is_training = false, active_players = menu:get_active_players(),
		reserved_slots = type(menu.get_reserved_slots) == "function" and menu:get_reserved_slots() or {},
		game_id = math.create_weak_unique_identifier(), host_name = g("UserManager"):get_name(),
		initial_host = lobby and lobby.lobby_host and lobby:lobby_host() or nil,
	}
	log("EVENT mission event=" .. tostring(ev.event_id) .. " city=" .. tostring(planet.name) .. " region=" .. tostring(ev.region) .. " seed=" .. tostring(seed))
	sm:set("dropzone_position", nil)
	menu.state_machine:change_state("transition", params)
	return "launching event " .. tostring(ev.event_id)
end

-- H. What mission end hands a mod, for a custom report.
obsidian.hook("StateMissionEnd", "on_enter", function(original, self, params, ...)
	local p = type(params) == "table" and params or {}
	log("MISSIONEND planet=" .. tostring(p.planet_name) .. " completed=" .. tostring(p.mission_completed) .. " seed=" .. tostring(p.mission_seed)
		.. " objectives=" .. tostring(p.objectives_complete_count) .. "/" .. tostring(p.objective_count) .. " time=" .. tostring(p.mission_time)
		.. " players=" .. tostring(p.total_players) .. " extracted=" .. tostring(p.extracted_players) .. " deaths=" .. tostring(p.total_deaths))
	return original(self, params, ...)
end)

local frames, last_state, last_status, last_update, last_url = 0, nil, nil, nil, nil
local tutorial_done = false
local in_mission, playable = false, false
local mission_count = 0

obsidian.on_frame(function()
	frames = frames + 1
	local boot = g("Boot")
	if NO_TUTORIAL and type(boot) == "table" and type(boot.arguments) == "table" then
		-- A fresh save would start boot camp; the menu reads this before choosing it.
		boot.arguments.no_tutorial = true
	end
	if frames % 15 ~= 0 then return end

	local _, name = state()
	if name ~= last_state then
		last_state = name
		log("STATE " .. tostring(name) .. " frame " .. frames)
		if name == "menu" and in_mission then
			in_mission = false
			log("SHIP AGAIN after a mission")
		end
	end
	local now_in_mission = api and api.game.in_mission()
	if now_in_mission and not in_mission then
		in_mission, playable = true, false
		log("MISSION entered, state " .. tostring(name))
	end
	-- Ready once the Helldiver is out of the drop cutscene, as the dev tour checks it.
	if now_in_mission and not playable then
		local ok, ready = pcall(function()
			local unit = api.game.my_unit()
			local character = unit and api.game.master(unit, "character")
			return character and character.current_state and character.current_state.name ~= "CharacterStateCutscene"
		end)
		if ok and ready then
			playable = true
			mission_count = mission_count + 1
			log("MISSION READY #" .. mission_count)
		end
	end

	if NO_TUTORIAL and not tutorial_done then
		local sm = g("SaveManager")
		-- A fresh save reads nil here, not false (seen in the 2026-11-04 run). Before the load the getter
		-- may throw; that only means "try again later".
		local ok, finished = pcall(function() return sm:get("tutorial_finished") end)
		if ok and finished ~= true and type(sm.data) == "table" then
			pcall(function() sm:set("tutorial_finished", true) end)
			log("SAVE fresh probe save: tutorial_finished was " .. tostring(finished) .. ", set")
			tutorial_done = true
		elseif ok and finished == true then
			tutorial_done = true
		end
	end

	local cm = g("CampaignManager")
	if type(cm) == "table" then
		if cm.url ~= last_url then
			last_url = cm.url
			log("URL now " .. tostring(cm.url))
		end
		if cm.url and cm.url ~= URL then
			cm.url = URL
			log("URL reset to probe")
		end
		if cm.status ~= last_status then
			last_status = cm.status
			log("STATUS " .. tostring(cm.status) .. " " .. war_line(cm))
		end
		local lu = type(cm.cache) == "table" and cm.cache.last_update
		if lu ~= last_update then
			last_update = lu
			log("POLL " .. war_line(cm))
		end
	end

	if frames % 30 ~= 0 then return end
	local f = io.open(CMD, "r")
	if not f then return end
	local line = f:read("*l")
	f:close()
	os.remove(CMD)
	if not line or line == "" then return end
	local verb, rest = string.match(line, "^(%S+)%s*(.*)$")
	local fn = COMMANDS[verb]
	local ok, res = false, "unknown command"
	if fn then ok, res = pcall(fn, rest) end
	log("CMD " .. line .. " -> " .. tostring(ok) .. " " .. tostring(res))
	local a = io.open(ACK, "w")
	if a then
		a:write(line, " ", tostring(ok), " ", tostring(res), "\n")
		a:close()
	end
end)

log("PROBE ready")
