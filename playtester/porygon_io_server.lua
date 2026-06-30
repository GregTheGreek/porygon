-- porygon_io_server.lua  (v2)
-- mGBA Lua command server: game state + input + screenshot + savestate + reset
-- over TCP, with NO emulator source changes.
--
-- Load once via mGBA scripting console:
--   dofile("/abs/path/porygon_io_server.lua")
-- Re-running dofile UPGRADES in place (no duplicate callbacks, no port conflict).
--
-- Protocol: newline-terminated request -> newline-terminated reply.
--   PING                 -> PONG
--   STATE                -> {"x":..,"y":..,"facing":..,"map_group":..,"map_num":..,"active":0|1}
--   READ8  0xADDR        -> decimal
--   READ16 0xADDR        -> decimal
--   TAP KEY FRAMES       -> OK    (KEY in A,B,SELECT,START,RIGHT,LEFT,UP,DOWN,R,L)
--   HOLD MASK FRAMES     -> OK    (raw GBA bitmask)
--   RELEASE              -> OK
--   SHOT /abs/path.png   -> OK    (paths MUST be absolute)
--   SAVE /abs/path.ss    -> OK
--   LOAD /abs/path.ss    -> OK
--   RESET                -> OK    (emu:reset -> back to boot/title)
--   SETOBJ 0xADDR        -> OK    (override gObjectEvents[0] base for this build)
--   EVAL <lua>           -> OK <result> | ERR <msg>   (dev escape hatch)

porygon = porygon or {}
local P = porygon

P.PORT = P.PORT or 8888
P.OBJ = P.OBJ or 0x02006620        -- gObjectEvents[0]; override per-build with SETOBJ
P.clients = P.clients or {}
P.nextId = P.nextId or 1
P.hold = P.hold or nil

local OFF_MAPNUM, OFF_MAPGROUP = 0x09, 0x0A
local OFF_X, OFF_Y, OFF_FACING = 0x10, 0x12, 0x18
local OFF_ACTIVE = 0x00            -- bit0 of the first u32 is `active`

local KEYS = {
  A=1, B=2, SELECT=4, START=8, RIGHT=16, LEFT=32, UP=64, DOWN=128, R=256, L=512,
}

local function read_state()
  local x = emu:read16(P.OBJ + OFF_X)
  local y = emu:read16(P.OBJ + OFF_Y)
  local facing = emu:read16(P.OBJ + OFF_FACING) & 0xF
  local mapNum = emu:read8(P.OBJ + OFF_MAPNUM)
  local mapGroup = emu:read8(P.OBJ + OFF_MAPGROUP)
  local active = emu:read8(P.OBJ + OFF_ACTIVE) & 0x1
  return string.format(
    '{"x":%d,"y":%d,"facing":%d,"map_group":%d,"map_num":%d,"active":%d}',
    x, y, facing, mapGroup, mapNum, active)
end

-- Dispatched through P so re-dofile redefinitions take effect on the live callback.
P.on_frame = function()
  local h = P.hold
  if h then
    if h.frames > 0 then
      emu:setKeys(h.mask)
      h.frames = h.frames - 1
    else
      emu:setKeys(0)
      P.hold = nil
    end
  end
end

P.handle = function(line)
  local cmd, rest = line:match("^(%S+)%s*(.*)$")
  if not cmd then return "ERR empty" end
  cmd = cmd:upper()

  if cmd == "PING" then return "PONG"
  elseif cmd == "STATE" then return read_state()
  elseif cmd == "READ8" then
    local a = tonumber(rest); if not a then return "ERR addr" end
    return tostring(emu:read8(a))
  elseif cmd == "READ16" then
    local a = tonumber(rest); if not a then return "ERR addr" end
    return tostring(emu:read16(a))
  elseif cmd == "TAP" then
    local key, frames = rest:match("^(%S+)%s+(%d+)$")
    local mask = key and KEYS[key:upper()]
    if not mask then return "ERR key" end
    P.hold = { mask = mask, frames = tonumber(frames) }
    return "OK"
  elseif cmd == "HOLD" then
    local mask, frames = rest:match("^(%d+)%s+(%d+)$")
    if not mask then return "ERR args" end
    P.hold = { mask = tonumber(mask), frames = tonumber(frames) }
    return "OK"
  elseif cmd == "RELEASE" then
    P.hold = nil; emu:setKeys(0); return "OK"
  elseif cmd == "SHOT" then
    if rest == "" then return "ERR path" end
    emu:screenshot(rest); return "OK"
  elseif cmd == "SAVE" then
    if rest == "" then return "ERR path" end
    emu:saveStateFile(rest); return "OK"
  elseif cmd == "LOAD" then
    if rest == "" then return "ERR path" end
    emu:loadStateFile(rest); return "OK"
  elseif cmd == "RESET" then
    emu:reset(); return "OK"
  elseif cmd == "SETOBJ" then
    local a = tonumber(rest); if not a then return "ERR addr" end
    P.OBJ = a; return "OK " .. string.format("0x%08X", a)
  elseif cmd == "EVAL" then
    local fn, err = load(rest)
    if not fn then return "ERR " .. tostring(err) end
    local ok, res = pcall(fn)
    if not ok then return "ERR " .. tostring(res) end
    return "OK " .. tostring(res)
  end
  return "ERR unknown " .. cmd
end

local function on_received(id)
  local sock = P.clients[id]
  if not sock then return end
  while true do
    local p, err = sock:receive(1024)
    if p then
      for ln in p:gmatch("[^\r\n]+") do
        sock:send(P.handle(ln) .. "\n")
      end
    else
      if err ~= socket.ERRORS.AGAIN then
        P.clients[id] = nil; sock:close()
      end
      return
    end
  end
end

local function on_accept()
  local sock, err = P.server:accept()
  if err then console:error("accept: " .. tostring(err)); return end
  local id = P.nextId; P.nextId = id + 1
  P.clients[id] = sock
  sock:add("received", function() on_received(id) end)
  sock:add("error", function() P.clients[id] = nil; sock:close() end)
  console:log("porygon-io: client " .. id .. " connected")
end

-- Register the frame hook exactly once; dispatch through P.on_frame.
if not P.frameHooked then
  callbacks:add("frame", function() if P.on_frame then P.on_frame() end end)
  P.frameHooked = true
end

-- (Re)bind the listening socket; close any prior one from an earlier dofile.
if P.server then pcall(function() P.server:close() end); P.server = nil end
local err
P.server, err = socket.bind(nil, P.PORT)
if err then
  console:error("porygon-io: bind failed: " .. tostring(err))
else
  P.server:listen()
  P.server:add("received", on_accept)
  console:log("porygon-io v2: listening on port " .. P.PORT)
end
