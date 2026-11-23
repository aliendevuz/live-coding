// Local signaling server for testing Duet without AWS.
//   node signaling/dev-server.mjs   ->  http://localhost:8787
// Same logic as the Lambda (src/logic.mjs), in-memory store.
import http from "node:http";
import { handle } from "./src/logic.mjs";
import { turnProvider } from "./src/turn.mjs";

const PORT = Number(process.env.PORT || 8787);
const TTL = 3600;
const items = new Map();
// Same env vars as the Lambda (CF_TURN_KEY_ID + CF_TURN_API_TOKEN, or TURN_URLS + TURN_SECRET).
const turn = turnProvider();

const live = (id) => {
  const it = items.get(id);
  if (it && it.ttl < Date.now() / 1000) {
    items.delete(id);
    return null;
  }
  return it || null;
};

const store = {
  async get(id) {
    return live(id);
  },
  async put(item, cond) {
    const cur = live(item.id);
    if (cond.notExists && cur) return false;
    if (cond.notExistsOrOwner && cur && cur.owner !== cond.notExistsOrOwner) return false;
    items.set(item.id, item);
    return true;
  },
  async del(id) {
    items.delete(id);
  },
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, DELETE",
  "access-control-allow-headers": "content-type, x-room-key",
};

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const url = new URL(req.url, "http://x");
      const r = await handle(
        { method: req.method, path: url.pathname, headers: req.headers, body: body || null },
        store,
        TTL,
        turn,
      );
      console.log(req.method, url.pathname, "->", r.statusCode);
      res.writeHead(r.statusCode, { ...r.headers, ...CORS });
      res.end(r.body);
    });
  })
  .listen(PORT, () => console.log(`Duet dev signaling on http://localhost:${PORT}${turn ? " (TURN on)" : " (no TURN: STUN only)"}`));
