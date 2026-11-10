-- Offline check of the probe mod with stand-ins for the loader and the game.
-- luajit probe/tests/test_mod.lua <path to probe/mod/main.lua> <scratch folder>
local MAIN, TMP = arg[1], arg[2]
assert(MAIN and TMP, "usage: luajit test_mod.lua <main.lua> <scratch folder>")

local LOGS = TMP .. "\\Arrowhead\\Helldivers\\ObsidianLauncher\\logs\\"
os.execute('mkdir "' .. LOGS .. '" 2>nul')
local real_getenv = os.getenv
os.getenv = function(k) if k == "APPDATA" then return TMP end return real_getenv(k) end

local function read(path)
	local f = io.open(path, "r")
	if not f then return nil end
	local s = f:read("*a")
	f:close()
	return s
end
local function write(path, s)
	local f = assert(io.open(path, "w"))
	f:write(s)
	f:close()
end

local failures = 0
local function check(cond, what)
	if cond then print("ok   " .. what) else failures = failures + 1; print("FAIL " .. what) end
end

-- Loader stand-in: hooks wrap the table method, as obsidian.hook does for a client mod.
local frames = {}
local function install(target, method, fn)
	local t = rawget(_G, target)
	local original = t[method]
	t[method] = function(...) return fn(original, ...) end
end
local function fresh_world()
	frames = {}
	_G.obsidian = {
		hook = install,
		on_frame = function(fn) frames[#frames + 1] = fn end,
		import = function() return {
			ui = { open = function(name) return name == "campaign", nil end, close = function() return true end, menus = function() return { "campaign", "main" } end },
			game = { in_mission = function() return _G.IN_MISSION == true end, on_ship = function() return _G.IN_MISSION ~= true end,
				my_unit = function() return "unit" end, master = function() return { current_state = { name = "CharacterStateIdle" } } end },
			mission = { win = function()
				if _G.WIN_REFUSE then return false, _G.WIN_REFUSE end
				_G.WON = true return true
			end }, effects = { set = function() return true end },
		} end,
	}
	_G.IN_MISSION, _G.WON, _G.LAUNCHED = false, false, nil
	table.clone = function(t) local c = {} for k, v in pairs(t) do c[k] = type(v) == "table" and table.clone(v) or v end return c end
	math.create_weak_unique_identifier = function() return "gid" end
	_G.UserManager = { get_name = function() return "Tester" end, get_user_id = function() return "u1" end }
	_G.Application = { platform = function() return "win32" end }
	local player_go = { values = {}, exists = function() return true end, owned = function() return true end }
	function player_go.set(self, k, v) self.values[k] = v end
	_G.PLAYER_GO = player_go
	local menu = {
		players = { { player_go = player_go } },
		mission_manager = {
			set_mission_completed = function() _G.DIRECT_COMPLETED = true end,
			set_extraction_done = function() _G.DIRECT_EXTRACTED = true end,
		},
		state_machine = { change_state = function(_, name, params) _G.LAUNCHED = { name = name, params = params } end },
		get_active_players = function() return { 1 } end,
		get_reserved_slots = function() return {} end,
		get_mission_seed = function()
			local p = SaveManager:get("current_planet")
			for _, m in ipairs(p.missions) do if not m.completed then return m.seed end end
		end,
	}
	_G.CampaignManager = { cache = {}, status = nil }
	function CampaignManager.set_environment(self) self.url = "https://api.helldiversgame.com/1.0/" end
	function CampaignManager.set_update_timer(self, t) self.update_timer = t end
	function CampaignManager.get_current_season(self) return self.cache.status[1].season end
	function CampaignManager.update_status_callback(self, job, ok, code, body, err) self.status = code == 200 and "online" or "offline" end
	_G.SaveManager = { data = {} }
	function SaveManager.setup(self, system, name) self.system, self.name = system, name end
	function SaveManager.set_backup_system(self, system, name) self.backup = { system, name } end
	function SaveManager.get(self, k) return self.data[k] end
	function SaveManager.set(self, k, v) self.data[k] = v end
	_G.TelemetryWwsgaManager = { sent = 0 }
	function TelemetryWwsgaManager.queue_event(self) self.sent = self.sent + 1 end
	_G.Steam = { user_id = function() return "110000100000000" end }
	function SaveManager.user_get(self, k) return self.data["user." .. k] end
	_G.MenuScreenCampaign = { generate_planets = function() end, update = function() end }
	_G.StateMissionEnd = { on_enter = function() end }
	_G.STATE_NAME = "menu"
	_G.Boot = { arguments = {}, state_machine = { get_current_state = function() return menu end, get_current_state_name = function() return _G.STATE_NAME end } }
end
local function run_frames(n)
	for _ = 1, n do for _, fn in ipairs(frames) do fn() end end
end

-- 1. No config: the mod does nothing at all.
os.remove(LOGS .. "cmdprobe.cfg")
fresh_world()
dofile(MAIN)
CampaignManager:set_environment()
check(CampaignManager.url == "https://api.helldiversgame.com/1.0/", "no config leaves the official url")
check(#frames == 0, "no config adds no frame callback")
SaveManager:setup("steam", "helldivers_save")
check(SaveManager.system == "steam" and SaveManager.name == "helldivers_save", "no config leaves the save alone")

-- 2. With a config.
write(LOGS .. "cmdprobe.cfg", "url=http://127.0.0.1:17491/1.0/\nisolate_save=1\nblock_telemetry=1\n")
fresh_world()
dofile(MAIN)
CampaignManager:set_environment()
check(CampaignManager.url == "http://127.0.0.1:17491/1.0/", "set_environment ends on the probe url")
SaveManager:setup("steam", "helldivers_save")
check(SaveManager.system == "default" and SaveManager.name == "cmdprobe_110000100000000", "save goes to the local probe file")
SaveManager:set_backup_system("default", "helldivers_steam_110000100000000")
check(SaveManager.backup == nil, "the backup into the real file is skipped")
TelemetryWwsgaManager:queue_event()
check(TelemetryWwsgaManager.sent == 0, "telemetry dropped")

CampaignManager.url = "https://api.helldiversgame.com/1.0/"
run_frames(30)
check(CampaignManager.url == "http://127.0.0.1:17491/1.0/", "a url reset is undone on the next check")
check(Boot.arguments.no_tutorial == true, "fresh save skips boot camp")
check(SaveManager.data.tutorial_finished == true, "fresh save marks the tutorial done")

CampaignManager:update_status_callback({}, true, 200, "{}", nil)
CampaignManager.cache = { last_update = 5, status = { { season = 1162, points = 45000, points_max = 100000, status = "active" } } }
run_frames(15)
local log = read(LOGS .. "cmdprobe.log") or ""
check(log:find("CALLBACK update_status_callback code=200", 1, true) ~= nil, "callbacks are logged")
check(log:find("STATUS online", 1, true) ~= nil, "status change logged")
check(log:find("POLL season=1162", 1, true) ~= nil, "poll logged with the season")

write(LOGS .. "cmdprobe.cmd", "poll\n")
run_frames(30)
check(CampaignManager.update_timer == 0, "poll command zeroes the timer")
check((read(LOGS .. "cmdprobe.ack") or ""):find("poll true", 1, true) ~= nil, "command acknowledged")
write(LOGS .. "cmdprobe.cmd", "menu campaign\n")
run_frames(30)
check((read(LOGS .. "cmdprobe.ack") or ""):find("menu campaign true", 1, true) ~= nil, "menu command opens the war screen")
write(LOGS .. "cmdprobe.cmd", "state\n")
run_frames(30)
check((read(LOGS .. "cmdprobe.ack") or ""):find("current_season=1162", 1, true) ~= nil, "state command reports the season")

-- The campaign mission: easiest open planet, the other missions done, a non-training launch.
SaveManager.data.available_planets = { { current_region = 5, planets = {
	{ name = "planet_10", difficulty = 4, reward = "xp_boost_1", missions = { { seed = 11 }, { seed = 12 } } },
	{ name = "planet_11", difficulty = 1, reward = "xp_boost_1", missions = { { seed = 21, num_research_samples = 3 }, { seed = 22 }, { seed = 23, num_research_samples = 4 } } },
	{ name = "planet_12", difficulty = 0, boss = true, missions = { { seed = 31 } } },
} } }
write(LOGS .. "cmdprobe.cmd", "campaign_mission 1\n")
run_frames(30)
local launched = _G.LAUNCHED
check(launched and launched.name == "transition" and launched.params.wanted_state == "mission_start", "campaign mission goes to mission_start")
check(launched and launched.params.is_training == false and launched.params.mission_seed == 23, "the open mission of the easiest non-boss planet, not training")
check(launched and launched.params.planet_name == "planet_11" and launched.params.planet_region == 5 and launched.params.num_research_samples == 4, "planet, region and samples passed on")
local p = SaveManager.data.available_planets[1].planets[2]
check(p.missions[1].completed and p.missions[2].completed and not p.missions[3].completed, "the other missions of the planet are marked done")
check(SaveManager.data.current_planet.selected_mission_index == 3, "current_planet points at the last mission")

_G.IN_MISSION = true
run_frames(15)
check((read(LOGS .. "cmdprobe.log") or ""):find("MISSION READY", 1, true) ~= nil, "mission ready logged")
write(LOGS .. "cmdprobe.cmd", "win\n")
run_frames(30)
check(_G.WON == true, "win goes through the API")
_G.WIN_REFUSE = "needs_session"
write(LOGS .. "cmdprobe.cmd", "win\n")
run_frames(30)
check(_G.DIRECT_COMPLETED and _G.DIRECT_EXTRACTED and _G.PLAYER_GO.values.has_extracted == true, "a refused win falls back to the direct calls")
check((read(LOGS .. "cmdprobe.ack") or ""):find("direct after needs_session", 1, true) ~= nil, "the fallback says why")
_G.WIN_REFUSE = nil
_G.IN_MISSION, _G.STATE_NAME = false, "mission_end"
run_frames(15)
_G.STATE_NAME = "menu"
run_frames(15)
check((read(LOGS .. "cmdprobe.log") or ""):find("SHIP AGAIN", 1, true) ~= nil, "back on the ship logged")
write(LOGS .. "cmdprobe.cmd", "save\n")
run_frames(30)
check((read(LOGS .. "cmdprobe.log") or ""):find("user.backend_mission_stats_index_win32=", 1, true) ~= nil, "save dump includes the acknowledged indexes")

os.remove(LOGS .. "cmdprobe.cfg")
print(failures == 0 and "all passed" or (failures .. " failed"))
os.exit(failures == 0 and 0 or 1)
