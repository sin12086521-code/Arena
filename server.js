const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const DURATION = 120;
const MAX_PLAYERS = 8;

app.use(express.static(path.join(__dirname, "public")));

function question() {
  const op = ["+", "-", "×"][Math.floor(Math.random() * 3)];
  let a = Math.floor(Math.random() * 40) + 10;
  let b = Math.floor(Math.random() * 20) + 2;
  if (op === "-" && b > a) [a, b] = [b, a];
  return { text: `${a} ${op} ${b}`, answer: op === "+" ? a + b : op === "-" ? a - b : a * b };
}

function snapshot(r) {
  return {
    code: r.code,
    state: r.state,
    host: r.hostName,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready, score: p.score })),
    spectators: r.spectators.size,
    maxPlayers: MAX_PLAYERS
  };
}

function update(r) {
  io.to(r.code).emit("room:update", snapshot(r));
  broadcastRooms();
}

function broadcastRooms() {
  const list = [...rooms.values()]
    .filter(r => r.state === "waiting" || r.state === "playing")
    .map(r => ({
      code: r.code,
      host: r.hostName,
      state: r.state,
      count: r.players.size,
      maxPlayers: MAX_PLAYERS,
      spectators: r.spectators.size
    }));
  io.emit("rooms:list", list);
}

function next(r) {
  r.q = question();
  r.qno++;
  r.answered.clear();
  io.to(r.code).emit("game:question", { no: r.qno, text: r.q.text });
}

function finish(r) {
  if (r.state !== "playing") return;
  r.state = "finished";
  clearTimeout(r.timer);
  const ps = [...r.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score }));
  const high = ps.length ? Math.max(...ps.map(p => p.score)) : 0;
  const winners = ps.filter(p => p.score === high);
  io.to(r.code).emit("game:finished", {
    players: ps.sort((a, b) => b.score - a.score),
    winner: winners.length === 1 ? winners[0].id : null
  });
  update(r);
  setTimeout(() => {
    const current = rooms.get(r.code);
    if (current === r && r.state === "finished" && r.players.size === 0 && r.spectators.size === 0) rooms.delete(r.code);
    broadcastRooms();
  }, 30000);
}

function start(r) {
  if (r.state !== "waiting" || r.players.size < 2) return;
  r.state = "playing";
  r.endsAt = Date.now() + DURATION * 1000;
  for (const p of r.players.values()) {
    p.score = 0;
    p.ready = false;
  }
  io.to(r.code).emit("game:start", { seconds: DURATION, startsAt: Date.now() });
  next(r);
  r.timer = setTimeout(() => finish(r), DURATION * 1000);
  update(r);
}

function joinPlayer(socket, r, name, cb) {
  const p = {
    id: socket.id,
    name: String(name || "Player").trim().slice(0, 12) || "Player",
    ready: false,
    score: 0
  };
  r.players.set(socket.id, p);
  socket.join(r.code);
  socket.data.code = r.code;
  socket.data.role = "player";
  cb?.({ ok: true, code: r.code, playerId: socket.id });
  update(r);
}

io.on("connection", socket => {
  socket.on("rooms:get", () => broadcastRooms());

  socket.on("room:create", ({ name }, cb) => {
    let code;
    do {
      code = Math.random().toString(36).slice(2, 7).toUpperCase();
    } while (rooms.has(code));
    const r = {
      code,
      hostId: socket.id,
      hostName: String(name || "Player").trim().slice(0, 12) || "Player",
      players: new Map(),
      spectators: new Set(),
      state: "waiting",
      q: null,
      qno: 0,
      answered: new Set(),
      timer: null,
      endsAt: 0
    };
    rooms.set(code, r);
    joinPlayer(socket, r, name, cb);
  });

  socket.on("room:join", ({ name, code }, cb) => {
    const r = rooms.get(String(code || "").trim().toUpperCase());
    if (!r) return cb?.({ error: "방을 찾을 수 없습니다." });
    if (r.state !== "waiting") return cb?.({ error: "이미 시작된 경기입니다. 관전 목록을 이용해 주세요." });
    if (r.players.size >= MAX_PLAYERS) return cb?.({ error: "방이 가득 찼습니다. (최대 8명)" });
    joinPlayer(socket, r, name, cb);
  });

  socket.on("room:spectate", ({ code }, cb) => {
    const r = rooms.get(String(code || "").trim().toUpperCase());
    if (!r || r.state !== "playing") return cb?.({ error: "관전할 수 있는 진행 중인 경기가 없습니다." });
    r.spectators.add(socket.id);
    socket.join(r.code);
    socket.data.code = r.code;
    socket.data.role = "spectator";
    cb?.({
      ok: true,
      code: r.code,
      room: snapshot(r),
      question: r.q ? { no: r.qno, text: r.q.text } : null,
      remaining: Math.max(0, (r.endsAt - Date.now()) / 1000)
    });
    update(r);
  });

  socket.on("player:ready", () => {
    const r = rooms.get(socket.data.code);
    const p = r?.players.get(socket.id);
    if (!r || !p || r.state !== "waiting" || r.players.size < 2) return;
    p.ready = true;
    update(r);
    if ([...r.players.values()].every(player => player.ready)) start(r);
  });

  socket.on("answer:submit", ({ value }, cb) => {
    const r = rooms.get(socket.data.code);
    const p = r?.players.get(socket.id);
    if (!r || !p || r.state !== "playing") return cb?.({ status: "inactive" });
    if (Date.now() >= r.endsAt) {
      finish(r);
      return cb?.({ status: "finished" });
    }
    if (r.answered.has(socket.id)) return cb?.({ status: "wait" });
    if (Number(value) !== r.q.answer) return cb?.({ status: "wrong" });
    r.answered.add(socket.id);
    p.score++;
    io.to(r.code).emit("game:point", { playerId: socket.id, name: p.name, score: p.score });
    next(r);
    cb?.({ status: "correct" });
    update(r);
  });

  socket.on("disconnect", () => {
    const r = rooms.get(socket.data.code);
    if (!r) return;
    if (socket.data.role === "spectator") {
      r.spectators.delete(socket.id);
    } else {
      r.players.delete(socket.id);
      r.answered.delete(socket.id);
      if (r.hostId === socket.id) {
        const nextHost = r.players.values().next().value;
        r.hostId = nextHost?.id || null;
        r.hostName = nextHost?.name || r.hostName;
      }
      if (r.state === "playing" && r.players.size === 0) finish(r);
    }
    if (r.players.size === 0 && r.spectators.size === 0) {
      clearTimeout(r.timer);
      rooms.delete(r.code);
      broadcastRooms();
    } else {
      update(r);
    }
  });
});

server.listen(PORT, () => console.log(`Mental Arena listening on ${PORT}`));
