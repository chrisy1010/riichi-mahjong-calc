// Accounts, saved games and player stats — stored in Cloudflare D1 (SQLite).
// Tables are created automatically on the first request; no manual migration step.
//
// Privacy model: each player can see only their own stats and games.
// Usernames listed in the ADMINS variable (wrangler.jsonc) can export everything.

const enc = new TextEncoder();
const COOKIE = "rmj_s";
const SESSION_DAYS = 60;
const PBKDF2_ITER = 100_000;       // the maximum Workers allows
const CLAIM_DAYS = 7;              // "This is me" at a table stays valid this long
const USER_RE = /^[a-z0-9_]{3,20}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const RESULTS = new Set(["", "ron", "tsumo", "deal_in", "paid", "tenpai", "noten", "chombo"]);
const KINDS = new Set(["win", "draw", "chombo"]);
const DORA = new Set(["Dora", "Aka dora", "Ura dora"]);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const err = (msg, status = 400) => json({ error: msg }, status);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(saltHex.match(/../g), h => parseInt(h, 16));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}
function sameStr(a, b) { // constant-time compare
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------- schema ---------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display TEXT NOT NULL,
     salt TEXT NOT NULL, hash TEXT NOT NULL, iter INTEGER NOT NULL, created_at INTEGER NOT NULL,
     fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS claims(tid TEXT NOT NULL, user_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(tid, user_id))`,
  `CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY, tid TEXT, recorded_by INTEGER, started_at INTEGER, ended_at INTEGER NOT NULL,
     room TEXT, tour TEXT, rules TEXT, n_hands INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS games_ended ON games(ended_at)`,
  `CREATE TABLE IF NOT EXISTS game_players(game_id TEXT NOT NULL, seat INTEGER NOT NULL, user_id INTEGER, name TEXT NOT NULL,
     score INTEGER NOT NULL, rank INTEGER NOT NULL, points REAL NOT NULL, chombo INTEGER NOT NULL DEFAULT 0, warn INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'none', PRIMARY KEY(game_id, seat))`,
  `CREATE INDEX IF NOT EXISTS gp_user ON game_players(user_id, status)`,
  `CREATE TABLE IF NOT EXISTS hands(game_id TEXT NOT NULL, idx INTEGER NOT NULL, round TEXT, dealer INTEGER, honba INTEGER,
     kind TEXT NOT NULL, PRIMARY KEY(game_id, idx))`,
  `CREATE TABLE IF NOT EXISTS hand_seats(game_id TEXT NOT NULL, idx INTEGER NOT NULL, seat INTEGER NOT NULL, result TEXT NOT NULL DEFAULT '',
     riichi INTEGER NOT NULL DEFAULT 0, open INTEGER NOT NULL DEFAULT 0, delta INTEGER NOT NULL DEFAULT 0,
     han INTEGER, fu INTEGER, yakuman INTEGER NOT NULL DEFAULT 0, yaku TEXT, PRIMARY KEY(game_id, idx, seat))`,
  // Shared tournaments: one organizer, anyone with the code can view and add games. They never expire.
  `CREATE TABLE IF NOT EXISTS tours(code TEXT PRIMARY KEY, name TEXT NOT NULL, cfg TEXT NOT NULL, owner_id INTEGER NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tour_games(code TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, dur INTEGER, players TEXT NOT NULL,
     added_by INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY(code, id))`,
];
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) schemaReady = env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

/* ---------- sessions ---------- */
function getCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
function cookie(req, value, maxAge) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
async function currentUser(req, env) {
  const t = getCookie(req, COOKIE);
  if (!t || !/^[0-9a-f]{64}$/.test(t)) return null;
  const u = await env.DB.prepare(
    "SELECT u.id, u.username, u.display, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?"
  ).bind(await sha256(t)).first();
  return u && u.expires_at > Date.now() ? u : null;
}
async function newSession(req, env, userId) {
  const t = randHex(32), now = Date.now();
  await env.DB.prepare("INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(t), userId, now, now + SESSION_DAYS * 864e5).run();
  return cookie(req, t, SESSION_DAYS * 86400);
}
const isAdmin = (env, u) => !!u && String(env.ADMINS || "").toLowerCase().split(/[\s,]+/).filter(Boolean).includes(u.username);
const pubUser = (env, u) => u && { username: u.username, display: u.display, admin: isAdmin(env, u) };

async function readBody(req, max = 20_000) {
  const t = await req.text();
  if (t.length > max) throw new HttpError(413, "Request too large");
  try { return JSON.parse(t || "{}"); } catch { throw new HttpError(400, "Bad JSON"); }
}
function requireUser(u) { if (!u) throw new HttpError(401, "Please sign in"); return u; }

/* ---------- accounts ---------- */
const cleanUsername = s => String(s || "").trim().toLowerCase().replace(/^@/, "");
function checkPassword(p) { if (p.length < 6 || p.length > 200) throw new HttpError(400, "Password must be at least 6 characters"); }

async function register(req, env) {
  const b = await readBody(req);
  const username = cleanUsername(b.username), password = String(b.password || "");
  const display = String(b.display || "").trim().slice(0, 30) || username;
  if (!USER_RE.test(username)) return err("Usernames are 3–20 characters: letters, numbers or _");
  checkPassword(password);
  const salt = randHex(16), hash = await pbkdf2(password, salt, PBKDF2_ITER);
  let id;
  try {
    const r = await env.DB.prepare("INSERT INTO users(username, display, salt, hash, iter, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(username, display, salt, hash, PBKDF2_ITER, Date.now()).run();
    id = r.meta.last_row_id;
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message || e))) return err("That username is taken", 409);
    throw e;
  }
  return json({ user: pubUser(env, { username, display }) }, 200, { "set-cookie": await newSession(req, env, id) });
}

async function login(req, env) {
  const b = await readBody(req);
  const username = cleanUsername(b.username), password = String(b.password || "");
  const u = USER_RE.test(username) ? await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first() : null;
  if (!u) { await pbkdf2(password || "x", "00".repeat(16), PBKDF2_ITER); return err("Wrong username or password", 401); }
  if (u.locked_until > Date.now()) return err("Too many wrong tries — wait 10 minutes and try again", 429);
  const h = await pbkdf2(password, u.salt, u.iter);
  if (!sameStr(h, u.hash)) {
    const f = u.fails + 1, lock = f >= 8;
    await env.DB.prepare("UPDATE users SET fails = ?, locked_until = ? WHERE id = ?").bind(lock ? 0 : f, lock ? Date.now() + 10 * 60e3 : 0, u.id).run();
    return err("Wrong username or password", 401);
  }
  if (u.fails) await env.DB.prepare("UPDATE users SET fails = 0 WHERE id = ?").bind(u.id).run();
  return json({ user: pubUser(env, u) }, 200, { "set-cookie": await newSession(req, env, u.id) });
}

async function logout(req, env) {
  const t = getCookie(req, COOKIE);
  if (t && /^[0-9a-f]{64}$/.test(t)) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(await sha256(t)).run();
  return json({ ok: true }, 200, { "set-cookie": cookie(req, "", 0) });
}

async function setPassword(env, userId, password) {
  checkPassword(password);
  const salt = randHex(16), hash = await pbkdf2(password, salt, PBKDF2_ITER);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET salt = ?, hash = ?, iter = ?, fails = 0, locked_until = 0 WHERE id = ?").bind(salt, hash, PBKDF2_ITER, userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
  ]);
}

async function changePassword(req, env, me) {
  const b = await readBody(req);
  const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(me.id).first();
  if (!sameStr(await pbkdf2(String(b.current || ""), u.salt, u.iter), u.hash)) return err("Current password is wrong", 403);
  await setPassword(env, me.id, String(b.password || ""));
  return json({ ok: true }, 200, { "set-cookie": await newSession(req, env, me.id) });
}

async function updateProfile(req, env, me) {
  const b = await readBody(req);
  const display = String(b.display || "").trim().slice(0, 30);
  if (!display) return err("Display name can't be empty");
  await env.DB.prepare("UPDATE users SET display = ? WHERE id = ?").bind(display, me.id).run();
  return json({ user: pubUser(env, { ...me, display }) });
}

/* ---------- saving a finished game ---------- */
const int = (v, lo, hi) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, "Bad game data"); return n; };
const str = (v, max) => String(v == null ? "" : v).slice(0, max);

async function saveGame(req, env, me) {
  const g = await readBody(req, 400_000);
  if (!ID_RE.test(String(g.id || "")) || !Array.isArray(g.players) || g.players.length !== 4 || !Array.isArray(g.hands) || g.hands.length > 300)
    return err("Bad game data");
  const tid = ID_RE.test(String(g.tid || "")) ? g.tid : null;

  const players = g.players.map((p, seat) => ({
    seat, name: str(p.name, 40).trim() || "Player " + (seat + 1),
    score: int(p.score, -1e6, 1e6), rank: int(p.rank, 1, 4), points: Math.round(Number(p.pts) * 10) / 10 || 0,
    chombo: int(p.ch || 0, 0, 99), warn: int(p.warn || 0, 0, 99), u: p.u ? cleanUsername(p.u) : null,
  }));
  const hands = g.hands.map((h, idx) => {
    if (!h || !KINDS.has(h.kind) || !Array.isArray(h.seats) || h.seats.length !== 4) throw new HttpError(400, "Bad hand data");
    return {
      i: idx, r: str(h.r, 20), dealer: int(h.dealer, 0, 3), honba: int(h.honba || 0, 0, 99), kind: h.kind,
      seats: h.seats.map((s, seat) => {
        if (!RESULTS.has(s.res || "")) throw new HttpError(400, "Bad hand data");
        return {
          i: idx, s: seat, res: s.res || "", ri: s.ri ? 1 : 0, op: s.op ? 1 : 0, d: int(s.d || 0, -1e6, 1e6),
          han: s.han == null ? null : int(s.han, 0, 99), fu: s.fu == null ? null : int(s.fu, 0, 200),
          yk: int(s.yk || 0, 0, 6), yaku: s.yaku ? str(s.yaku, 400) : null,
        };
      }),
    };
  });

  const names = players.map(p => p.u).filter(Boolean);
  if (new Set(names).size !== names.length) return err("The same account is linked to two seats");
  let users = [];
  if (names.length) {
    users = (await env.DB.prepare("SELECT id, username FROM users WHERE username IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(names)).all()).results;
  }
  const byName = Object.fromEntries(users.map(u => [u.username, u.id]));
  let claimed = new Set();
  if (tid && users.length) {
    const rows = (await env.DB.prepare("SELECT user_id FROM claims WHERE tid = ? AND at > ?").bind(tid, Date.now() - CLAIM_DAYS * 864e5).all()).results;
    claimed = new Set(rows.map(r => r.user_id));
  }
  for (const p of players) {
    p.user_id = p.u && byName[p.u] ? byName[p.u] : null;
    // Linked by the person saving the game, or that player tapped "This is me" on their own phone → counts right away.
    // Anyone else → waits until that player confirms it in their stats.
    p.status = !p.user_id ? "none" : (me && p.user_id === me.id) || claimed.has(p.user_id) ? "confirmed" : "pending";
  }
  if (!me && !players.some(p => p.user_id)) return err("Sign in or link at least one player account to save stats", 400);

  const exists = await env.DB.prepare("SELECT 1 FROM games WHERE id = ?").bind(g.id).first();
  if (exists) return json({ ok: true, duplicate: true });

  const now = Date.now();
  const endedAt = Number.isFinite(+g.endedAt) ? Math.min(+g.endedAt, now + 6e4) : now;
  const startedAt = Number.isFinite(+g.startedAt) ? +g.startedAt : null;
  const seats = hands.flatMap(h => h.seats);
  try { await env.DB.batch([
    env.DB.prepare("INSERT INTO games(id, tid, recorded_by, started_at, ended_at, room, tour, rules, n_hands, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(g.id, tid, me ? me.id : null, startedAt, endedAt, g.room ? str(g.room, 10) : null, g.tour ? str(g.tour, 80) : null,
        g.rules ? str(JSON.stringify(g.rules), 2000) : null, hands.length, now),
    env.DB.prepare(`INSERT INTO game_players(game_id, seat, user_id, name, score, rank, points, chombo, warn, status)
      SELECT ?1, j.value->>'seat', j.value->>'user_id', j.value->>'name', j.value->>'score', j.value->>'rank', j.value->>'points',
             j.value->>'chombo', j.value->>'warn', j.value->>'status' FROM json_each(?2) j`).bind(g.id, JSON.stringify(players)),
    env.DB.prepare(`INSERT INTO hands(game_id, idx, round, dealer, honba, kind)
      SELECT ?1, j.value->>'i', j.value->>'r', j.value->>'dealer', j.value->>'honba', j.value->>'kind' FROM json_each(?2) j`)
      .bind(g.id, JSON.stringify(hands.map(({ seats, ...h }) => h))),
    env.DB.prepare(`INSERT INTO hand_seats(game_id, idx, seat, result, riichi, open, delta, han, fu, yakuman, yaku)
      SELECT ?1, j.value->>'i', j.value->>'s', j.value->>'res', j.value->>'ri', j.value->>'op', j.value->>'d',
             j.value->>'han', j.value->>'fu', j.value->>'yk', j.value->>'yaku' FROM json_each(?2) j`).bind(g.id, JSON.stringify(seats)),
  ]); } catch (e) {
    if (/UNIQUE|PRIMARY KEY/i.test(String(e && e.message || e))) return json({ ok: true, duplicate: true });
    throw e;
  }
  return json({ ok: true, seats: players.map(p => ({ u: p.user_id ? p.u : null, status: p.status })) });
}

async function claimTable(req, env, me) {
  const b = await readBody(req);
  if (!ID_RE.test(String(b.tid || ""))) return err("Bad table id");
  await env.DB.prepare("INSERT INTO claims(tid, user_id, at) VALUES (?, ?, ?) ON CONFLICT(tid, user_id) DO UPDATE SET at = excluded.at")
    .bind(b.tid, me.id, Date.now()).run();
  return json({ ok: true });
}

async function lookupUser(env, name) {
  const u = USER_RE.test(name) ? await env.DB.prepare("SELECT username, display FROM users WHERE username = ?").bind(name).first() : null;
  return u ? json(u) : err("No player with that username", 404);
}

/* ---------- stats ---------- */
const WIN = "hs.result IN ('ron','tsumo')";
async function myStats(env, me) {
  const DB = env.DB, uid = me.id;
  const [place, hand, yakuRows, series, recent, pending] = await DB.batch([
    DB.prepare(`SELECT COUNT(*) games, AVG(rank) avg_rank, SUM(rank=1) r1, SUM(rank=2) r2, SUM(rank=3) r3, SUM(rank=4) r4,
        ROUND(SUM(points),1) points, AVG(score) avg_score, MAX(score) best_score, MIN(score) worst_score,
        SUM(score < 0) busted, SUM(chombo) chombo, SUM(warn) warn
      FROM game_players WHERE user_id = ? AND status = 'confirmed'`).bind(uid),
    DB.prepare(`SELECT COUNT(*) hands, SUM(${WIN}) wins, SUM(hs.result='tsumo') tsumo, SUM(hs.result='deal_in') deal_ins,
        SUM(hs.riichi) riichi, SUM(hs.riichi AND ${WIN}) riichi_wins, SUM(hs.riichi AND hs.result='deal_in') riichi_deal_ins,
        SUM(hs.open) called, SUM(hs.open AND ${WIN}) called_wins,
        SUM(h.kind='draw') draws, SUM(hs.result='tenpai') tenpai,
        SUM(h.dealer = hs.seat) dealer_hands, SUM(h.dealer = hs.seat AND ${WIN}) dealer_wins,
        AVG(CASE WHEN ${WIN} THEN hs.delta END) avg_win, MAX(CASE WHEN ${WIN} THEN hs.delta END) best_win,
        AVG(CASE WHEN hs.result='deal_in' THEN hs.delta END) avg_deal_in,
        AVG(CASE WHEN ${WIN} AND hs.yakuman=0 THEN hs.han END) avg_han,
        SUM(${WIN} AND hs.yakuman>0) yakuman,
        SUM(${WIN} AND (hs.yakuman>0 OR hs.han>=5)) big_hands
      FROM game_players gp JOIN hand_seats hs ON hs.game_id = gp.game_id AND hs.seat = gp.seat
      JOIN hands h ON h.game_id = hs.game_id AND h.idx = hs.idx
      WHERE gp.user_id = ? AND gp.status = 'confirmed' AND h.kind != 'chombo'`).bind(uid),
    DB.prepare(`SELECT hs.yaku FROM game_players gp JOIN hand_seats hs ON hs.game_id = gp.game_id AND hs.seat = gp.seat
      WHERE gp.user_id = ? AND gp.status = 'confirmed' AND ${WIN} AND hs.yaku IS NOT NULL`).bind(uid),
    DB.prepare(`SELECT g.ended_at at, gp.points, gp.rank FROM game_players gp JOIN games g ON g.id = gp.game_id
      WHERE gp.user_id = ? AND gp.status = 'confirmed' ORDER BY g.ended_at`).bind(uid),
    DB.prepare(`SELECT g.id, g.ended_at at, g.tour, g.n_hands, gp.seat, gp.score, gp.rank, gp.points, gp.chombo,
        (SELECT json_group_array(json_object('seat', o.seat, 'name', o.name, 'score', o.score, 'rank', o.rank))
           FROM game_players o WHERE o.game_id = g.id) players
      FROM game_players gp JOIN games g ON g.id = gp.game_id
      WHERE gp.user_id = ? AND gp.status = 'confirmed' ORDER BY g.ended_at DESC LIMIT 25`).bind(uid),
    DB.prepare(`SELECT g.id, g.ended_at at, g.tour, gp.seat, gp.score, gp.rank, gp.points, gp.status, rb.username recorded_by,
        (SELECT json_group_array(json_object('seat', o.seat, 'name', o.name, 'score', o.score, 'rank', o.rank))
           FROM game_players o WHERE o.game_id = g.id) players
      FROM game_players gp JOIN games g ON g.id = gp.game_id LEFT JOIN users rb ON rb.id = g.recorded_by
      WHERE gp.user_id = ? AND gp.status = 'pending' ORDER BY g.ended_at DESC LIMIT 50`).bind(uid),
  ]);
  const yaku = {};
  for (const r of yakuRows.results) for (const y of r.yaku.split(",").map(s => s.trim()).filter(Boolean)) if (!DORA.has(y)) yaku[y] = (yaku[y] || 0) + 1;
  const parsePlayers = r => ({ ...r, players: JSON.parse(r.players || "[]").sort((a, b) => a.seat - b.seat) });
  return json({
    user: pubUser(env, me),
    place: place.results[0], hand: hand.results[0],
    yaku: Object.entries(yaku).sort((a, b) => b[1] - a[1]).slice(0, 12),
    series: series.results,
    recent: recent.results.map(parsePlayers),
    pending: pending.results.map(parsePlayers),
  });
}

async function setMyGameStatus(req, env, me, gameId) {
  const b = await readBody(req);
  const status = b.accept ? "confirmed" : "declined";
  const r = await env.DB.prepare("UPDATE game_players SET status = ? WHERE game_id = ? AND user_id = ? AND status IN ('pending','confirmed','declined')")
    .bind(status, gameId, me.id).run();
  return r.meta.changes ? json({ ok: true, status }) : err("Game not found", 404);
}

/* ---------- CSV exports ---------- */
function csv(rows, cols) {
  const cell = v => {
    if (v == null) return "";
    if (typeof v === "number") return String(v);
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets treating names as formulas
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return "﻿" + [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
const iso = ms => (ms == null ? null : new Date(ms).toISOString());
const GAME_COLS = ["game_id", "started_at", "ended_at", "tournament", "room", "hands", "seat", "player_name", "username", "status", "final_score", "rank", "points", "chombo", "warnings"];
const HAND_COLS = ["game_id", "ended_at", "tournament", "hand_no", "round", "honba", "kind", "seat", "seat_wind", "is_dealer", "player_name", "username",
  "result", "riichi", "called", "delta", "han", "fu", "yakuman", "yaku"];
const WINDS = ["East", "South", "West", "North"];

async function exportCsv(env, type, userId) {
  const mine = userId != null;
  const where = mine ? "WHERE gp.user_id = ?1 AND gp.status = 'confirmed'" : "";
  let rows, cols;
  if (type === "games") {
    const q = env.DB.prepare(`SELECT g.id game_id, g.started_at, g.ended_at, g.tour tournament, g.room, g.n_hands hands, gp.seat, gp.name player_name,
        u.username, gp.status, gp.score final_score, gp.rank, gp.points, gp.chombo, gp.warn warnings
      FROM game_players gp JOIN games g ON g.id = gp.game_id LEFT JOIN users u ON u.id = gp.user_id ${where}
      ORDER BY g.ended_at, g.id, gp.seat`);
    rows = (await (mine ? q.bind(userId) : q).all()).results.map(r => ({ ...r, started_at: iso(r.started_at), ended_at: iso(r.ended_at) }));
    cols = GAME_COLS;
  } else if (type === "hands") {
    const q = env.DB.prepare(`SELECT g.id game_id, g.ended_at, g.tour tournament, h.idx + 1 hand_no, h.round, h.honba, h.kind, hs.seat, h.dealer,
        gp.name player_name, u.username, hs.result, hs.riichi, hs.open called, hs.delta, hs.han, hs.fu, hs.yakuman, hs.yaku
      FROM hand_seats hs JOIN hands h ON h.game_id = hs.game_id AND h.idx = hs.idx JOIN games g ON g.id = hs.game_id
      JOIN game_players gp ON gp.game_id = hs.game_id AND gp.seat = hs.seat LEFT JOIN users u ON u.id = gp.user_id ${where}
      ORDER BY g.ended_at, g.id, h.idx, hs.seat`);
    rows = (await (mine ? q.bind(userId) : q).all()).results.map(r => ({
      ...r, ended_at: iso(r.ended_at), seat_wind: WINDS[(r.seat - r.dealer + 4) % 4], is_dealer: r.seat === r.dealer ? 1 : 0,
    }));
    cols = HAND_COLS;
  } else if (type === "users" && !mine) {
    rows = (await env.DB.prepare(`SELECT u.username, u.display, u.created_at,
        (SELECT COUNT(*) FROM game_players gp WHERE gp.user_id = u.id AND gp.status = 'confirmed') games,
        (SELECT COUNT(*) FROM game_players gp WHERE gp.user_id = u.id AND gp.status = 'pending') pending
      FROM users u ORDER BY u.id`).all()).results.map(r => ({ ...r, created_at: iso(r.created_at) }));
    cols = ["username", "display", "created_at", "games", "pending"];
  } else return err("Unknown export");
  const name = `riichi-${mine ? "my-" : ""}${type}-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(csv(rows, cols), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" },
  });
}

async function adminReset(req, env) {
  const b = await readBody(req);
  const u = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(cleanUsername(b.username)).first();
  if (!u) return err("No player with that username", 404);
  await setPassword(env, u.id, String(b.password || ""));
  return json({ ok: true });
}

/* ---------- shared tournaments ----------
   The organizer (a signed-in player) creates one and gets a 6-character code.
   Anyone with the code can see the standings and add finished games.
   Only the organizer (or an admin) can rename it, change the rules, edit or delete games, or delete it. */
const TOUR_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // same alphabet as live rooms: no 0/O/1/I/L
const TOUR_RE = /^[A-Z2-9]{6}$/;
const MAX_TOUR_GAMES = 3000;
const ROUNDS = new Set(["gosha", "shisha", "dec"]);
const CHOMBO = new Set(["mangan", "all3000", "pts"]);
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

function cleanCfg(c) {
  if (!c || typeof c !== "object" || !Array.isArray(c.uma) || c.uma.length !== 4) throw new HttpError(400, "Bad scoring rules");
  const start = Math.round(num(c.start, 1000, 1e6, 25000));
  return {
    start, ret: Math.round(num(c.ret, 1000, 1e6, start)),
    uma: c.uma.map(u => Math.round(num(u, -200, 200, 0) * 10) / 10),
    round: ROUNDS.has(c.round) ? c.round : "gosha",
    chType: CHOMBO.has(c.chType) ? c.chType : "mangan",
    chPts: Math.round(num(c.chPts, 0, 500, 20) * 10) / 10,
  };
}
function cleanTourGame(g) {
  if (!g || !ID_RE.test(String(g.id || "")) || !Array.isArray(g.players) || g.players.length !== 4) throw new HttpError(400, "Bad game data");
  const at = Number(g.at);
  return {
    id: g.id, at: Number.isFinite(at) && at > 0 ? Math.round(at) : Date.now(),
    dur: g.dur == null || g.dur === "" ? null : Math.round(num(g.dur, 0, 864e5, 0)),
    players: g.players.map((p, i) => (p = p || {}, {
      name: str(p && p.name, 40).trim() || "Player " + (i + 1),
      score: int(p.score || 0, -1e6, 1e6), ch: int(p.ch || 0, 0, 99), cp: int(p.cp || 0, 0, 99),
    })),
  };
}
const cleanTourName = s => { const n = String(s || "").trim().slice(0, 80); if (!n) throw new HttpError(400, "Give the tournament a name"); return n; };
const newTourCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => TOUR_CHARS[b % TOUR_CHARS.length]).join("");

async function loadTour(env, code) {
  const t = TOUR_RE.test(code) ? await env.DB.prepare("SELECT * FROM tours WHERE code = ?").bind(code).first() : null;
  if (!t) throw new HttpError(404, "No tournament with that code");
  return t;
}
const canManage = (env, me, t) => !!me && (me.id === t.owner_id || isAdmin(env, me));
function requireOrganizer(env, me, t) {
  if (!me) throw new HttpError(401, "Sign in as the organizer to do that");
  if (!canManage(env, me, t)) throw new HttpError(403, "Only the organizer can do that");
}
async function tourJson(env, me, code) {
  const t = await loadTour(env, code);
  const [owner, games] = await env.DB.batch([
    env.DB.prepare("SELECT username, display FROM users WHERE id = ?").bind(t.owner_id),
    env.DB.prepare("SELECT id, at, dur, players FROM tour_games WHERE code = ? ORDER BY at, id").bind(code),
  ]);
  return json({
    code: t.code, name: t.name, cfg: JSON.parse(t.cfg), updatedAt: t.updated_at,
    owner: owner.results[0] || null, isOwner: canManage(env, me, t),
    games: games.results.map(g => ({ id: g.id, at: g.at, dur: g.dur, players: JSON.parse(g.players) })),
  });
}
const touch = (env, code) => env.DB.prepare("UPDATE tours SET updated_at = ? WHERE code = ?").bind(Date.now(), code);

async function createTour(req, env, me) {
  const b = await readBody(req, 1_500_000);
  const name = cleanTourName(b.name), cfg = cleanCfg(b.cfg);
  const games = Array.isArray(b.games) ? b.games.map(cleanTourGame) : [];
  if (games.length > MAX_TOUR_GAMES) return err("Too many games");
  const uniq = [...new Map(games.map(g => [g.id, g])).values()];
  const now = Date.now();
  for (let i = 0; i < 8; i++) {
    const code = newTourCode();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO tours(code, name, cfg, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(code, name, JSON.stringify(cfg), me.id, now, now),
        env.DB.prepare(`INSERT INTO tour_games(code, id, at, dur, players, added_by, created_at)
          SELECT ?1, j.value->>'id', j.value->>'at', j.value->>'dur', json(j.value->'players'), ?2, ?3 FROM json_each(?4) j`)
          .bind(code, me.id, now, JSON.stringify(uniq)),
      ]);
      return await tourJson(env, me, code);
    } catch (e) {
      if (!/UNIQUE|PRIMARY KEY/i.test(String(e && e.message || e))) throw e;
    }
  }
  return err("Couldn't make a tournament code — try again", 503);
}

async function updateTour(req, env, me, code) {
  const t = await loadTour(env, code); requireOrganizer(env, me, t);
  const b = await readBody(req);
  const name = b.name != null ? cleanTourName(b.name) : t.name;
  const cfg = b.cfg != null ? JSON.stringify(cleanCfg(b.cfg)) : t.cfg;
  await env.DB.prepare("UPDATE tours SET name = ?, cfg = ?, updated_at = ? WHERE code = ?").bind(name, cfg, Date.now(), code).run();
  return tourJson(env, me, code);
}

async function deleteTour(env, me, code) {
  const t = await loadTour(env, code); requireOrganizer(env, me, t);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tour_games WHERE code = ?").bind(code),
    env.DB.prepare("DELETE FROM tours WHERE code = ?").bind(code),
  ]);
  return json({ ok: true });
}

async function addTourGame(req, env, me, code) {
  await loadTour(env, code);
  const g = cleanTourGame(await readBody(req));
  const n = await env.DB.prepare("SELECT COUNT(*) n FROM tour_games WHERE code = ?").bind(code).first();
  if (n.n >= MAX_TOUR_GAMES) return err("This tournament is full");
  // Same game id sent twice (a retry after a dropped connection) is ignored rather than duplicated.
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO tour_games(code, id, at, dur, players, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(code, g.id, g.at, g.dur, JSON.stringify(g.players), me ? me.id : null, Date.now()),
    touch(env, code),
  ]);
  return tourJson(env, me, code);
}

async function editTourGame(req, env, me, code, id) {
  const t = await loadTour(env, code); requireOrganizer(env, me, t);
  const g = cleanTourGame({ ...(await readBody(req)), id });
  const r = await env.DB.prepare("UPDATE tour_games SET at = ?, dur = ?, players = ? WHERE code = ? AND id = ?")
    .bind(g.at, g.dur, JSON.stringify(g.players), code, id).run();
  if (!r.meta.changes) return err("Game not found", 404);
  await touch(env, code).run();
  return tourJson(env, me, code);
}

async function deleteTourGame(env, me, code, id) {
  const t = await loadTour(env, code); requireOrganizer(env, me, t);
  await env.DB.batch([env.DB.prepare("DELETE FROM tour_games WHERE code = ? AND id = ?").bind(code, id), touch(env, code)]);
  return tourJson(env, me, code);
}

async function handleTours(request, env, me, parts) {
  const [, , code, sub, id] = parts, method = request.method;
  if (!code) {
    if (method === "POST") return createTour(request, env, requireUser(me));
    return err("Not found", 404);
  }
  if (!TOUR_RE.test(code)) return err("Tournament codes are 6 letters/numbers", 400);
  if (!sub) {
    if (method === "GET") return tourJson(env, me, code);
    if (method === "POST") return updateTour(request, env, me, code);
    if (method === "DELETE") return deleteTour(env, me, code);
  }
  if (sub === "games") {
    if (!id && method === "POST") return addTourGame(request, env, me, code);
    if (id && ID_RE.test(id)) {
      if (method === "PUT") return editTourGame(request, env, me, code, id);
      if (method === "DELETE") return deleteTourGame(env, me, code, id);
    }
  }
  return err("Not found", 404);
}

/* ---------- router: /api/auth/*, /api/me/*, /api/users/*, /api/games, /api/claim, /api/tours/*, /api/admin/* ---------- */
export const ACCOUNT_ROUTES = new Set(["auth", "me", "users", "games", "claim", "tours", "admin"]);

export async function handleAccounts(request, env, parts) {
  if (!env.DB) return err("Accounts are not set up on this server", 503);
  const method = request.method;
  if (method !== "GET") {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return err("Bad origin", 403);
  }
  try {
    await ensureSchema(env);
    const me = await currentUser(request, env);
    const [, area, a, b] = parts;
    const route = `${method} ${area}${a ? "/" + a : ""}`;

    if (route === "POST auth/register") return await register(request, env);
    if (route === "POST auth/login") return await login(request, env);
    if (route === "POST auth/logout") return await logout(request, env);
    if (route === "POST auth/password") return await changePassword(request, env, requireUser(me));

    if (route === "GET me") return json({ user: pubUser(env, me) });
    if (route === "POST me") return await updateProfile(request, env, requireUser(me));
    if (route === "GET me/stats") return await myStats(env, requireUser(me));
    if (route === "GET me/export") return await exportCsv(env, new URL(request.url).searchParams.get("type"), requireUser(me).id);
    if (method === "POST" && area === "me" && a === "games" && ID_RE.test(b || "")) return await setMyGameStatus(request, env, requireUser(me), b);

    if (method === "GET" && area === "users" && a) return await lookupUser(env, cleanUsername(decodeURIComponent(a)));
    if (route === "POST games") return await saveGame(request, env, me);
    if (route === "POST claim") return await claimTable(request, env, requireUser(me));
    if (area === "tours") return await handleTours(request, env, me, parts);

    if (area === "admin") {
      if (!isAdmin(env, requireUser(me))) return err("Admins only", 403);
      if (route === "GET admin/export") return await exportCsv(env, new URL(request.url).searchParams.get("type"), null);
      if (route === "POST admin/reset") return await adminReset(request, env);
    }
    return err("Not found", 404);
  } catch (e) {
    if (e instanceof HttpError) return err(e.message, e.status);
    console.error(e);
    return err("Server error", 500);
  }
}
