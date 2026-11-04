// Riichi Mahjong — live rooms.
// Static files in /public are served by Cloudflare's asset handler; only /api/* reaches this code.
// Each room is one Durable Object holding a single JSON "doc": { game, tour }.
import { DurableObject } from "cloudflare:workers";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const MAX_DOC = 400_000;       // bytes
const MAX_HIST = 60;           // undo steps kept per room
const IDLE_TTL = 1000 * 60 * 60 * 24 * 90; // rooms vanish after 90 days without changes

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => CODE_CHARS[b % CODE_CHARS.length]).join("");
const validCode = c => typeof c === "string" && /^[A-Z2-9]{6}$/.test(c);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "rooms", CODE, "ws"]
    if (parts[0] !== "api") return env.ASSETS.fetch(request);

    if (parts[1] === "health") return json({ ok: true });

    if (parts[1] === "rooms" && parts.length === 2 && request.method === "POST") {
      const body = await request.text();
      if (body.length > MAX_DOC) return json({ error: "too large" }, 413);
      let doc;
      try { doc = JSON.parse(body).doc; } catch { return json({ error: "bad json" }, 400); }
      if (!doc || typeof doc !== "object") return json({ error: "missing doc" }, 400);
      for (let i = 0; i < 8; i++) {
        const code = newCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const r = await stub.init(doc);
        if (r.ok) return json({ code, version: r.version });
      }
      return json({ error: "could not allocate a room" }, 503);
    }

    if (parts[1] === "rooms" && validCode(parts[2])) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(parts[2]));
      if (parts[3] === "ws") {
        if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
        return stub.fetch(request);
      }
      if (parts.length === 3 && request.method === "GET") {
        const info = await stub.info();
        return info ? json(info) : json({ error: "not found" }, 404);
      }
    }
    return json({ error: "not found" }, 404);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.doc = (await this.ctx.storage.get("doc")) ?? null;
      this.version = (await this.ctx.storage.get("version")) ?? 0;
      this.hist = (await this.ctx.storage.get("hist")) ?? [];
    });
  }

  async init(doc) {
    if (this.doc) return { ok: false };
    this.doc = doc; this.version = 1; this.hist = [];
    await this.persist();
    return { ok: true, version: 1 };
  }

  async info() {
    if (!this.doc) return null;
    return { version: this.version, online: this.ctx.getWebSockets().length, players: (this.doc.game?.players || []).map(p => p.name) };
  }

  async persist() {
    await this.ctx.storage.put({ doc: this.doc, version: this.version, hist: this.hist });
    await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL);
  }

  async alarm() { // idle for IDLE_TTL: clean up
    for (const ws of this.ctx.getWebSockets()) try { ws.close(4410, "room expired"); } catch {}
    await this.ctx.storage.deleteAll();
    this.doc = null; this.version = 0; this.hist = [];
  }

  async fetch(request) {
    if (!this.doc) return new Response("room not found", { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server); // hibernatable: the object can sleep between messages
    server.send(JSON.stringify(this.stateMsg()));
    this.presence();
    return new Response(null, { status: 101, webSocket: client });
  }

  stateMsg(extra) {
    return { type: "state", version: this.version, histLen: this.hist.length, doc: this.doc, ...extra };
  }
  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) try { ws.send(s); } catch {}
  }
  presence() { this.broadcast({ type: "presence", online: this.ctx.getWebSockets().length }); }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_DOC) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!this.doc) { ws.close(4404, "room not found"); return; }

    if (m.type === "ping") { ws.send('{"type":"pong"}'); return; }

    if (m.type === "set") {
      if (!m.doc || typeof m.doc !== "object") return;
      if (m.base !== this.version) { // someone else changed it first: send the truth back
        ws.send(JSON.stringify(this.stateMsg({ rejected: true })));
        return;
      }
      if (m.hist) { this.hist.push(this.doc); if (this.hist.length > MAX_HIST) this.hist.shift(); }
      this.doc = m.doc; this.version++;
      await this.persist();
      ws.send(JSON.stringify({ type: "ack", version: this.version, histLen: this.hist.length }));
      this.broadcast(this.stateMsg({ by: m.by || null }), ws);
      return;
    }

    if (m.type === "undo") {
      if (!this.hist.length) return;
      this.doc = this.hist.pop(); this.version++;
      await this.persist();
      this.broadcast(this.stateMsg({ undo: true, by: m.by || null }));
    }
  }

  async webSocketClose(ws) { try { ws.close(); } catch {} this.presence(); }
  async webSocketError() { this.presence(); }
}
