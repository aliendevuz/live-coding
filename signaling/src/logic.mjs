// Duet signaling logic, independent of storage so the same code runs on Lambda
// (DynamoDB store) and locally (in-memory store, see ../dev-server.mjs).
//
//   PUT    /rooms/{room}/offer            host publishes {epoch, sdp}   (needs x-room-key)
//   GET    /rooms/{room}/offer            guest reads the latest offer
//   PUT    /rooms/{room}/answer/{epoch}   guest answers that epoch      (first writer wins)
//   GET    /rooms/{room}/answer/{epoch}   host polls for the answer
//   DELETE /rooms/{room}                  host closes the room          (needs x-room-key)
//   GET    /rooms/{room}/ice              STUN/TURN servers for this connection
//                                         (host: x-room-key; guest: the room must have an offer)
//
// store: { get(id) -> item|null, put(item, cond) -> bool, del(id) }
//   cond: { notExists: true } or { notExistsOrOwner: hash }; put returns false if cond fails.
import { createHash } from "node:crypto";

const ROOM_RE = /^[a-z0-9]{8,32}$/;
const EPOCH_RE = /^[0-9]{1,16}$/;
const MAX_BODY = 64 * 1024;

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: body === undefined ? "" : JSON.stringify(body),
});

const hashKey = (key) => createHash("sha256").update(key).digest("hex");

function parseBody(raw) {
  if (!raw || raw.length > MAX_BODY) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * req: { method, path, headers (lower-case keys), body (string|null) }
 * turn: async () => RTCIceServer[], or null when no TURN is configured (see turn.mjs)
 */
export async function handle(req, store, ttlSeconds, turn = null) {
  const { method } = req;
  if (method === "OPTIONS") return reply(204);
  const expires = () => Math.floor(Date.now() / 1000) + ttlSeconds;

  const parts = (req.path || "").split("/").filter(Boolean);
  if (parts[0] !== "rooms" || !ROOM_RE.test(parts[1] || "")) return reply(404, { error: "not found" });
  const room = parts[1];
  const kind = parts[2];
  const roomKey = req.headers["x-room-key"] || "";
  const offerId = `${room}#offer`;

  if (!kind && method === "DELETE") {
    const cur = await store.get(offerId);
    if (cur && cur.owner !== hashKey(roomKey)) return reply(403, { error: "forbidden" });
    await store.del(offerId);
    return reply(204);
  }

  if (kind === "ice" && parts.length === 3) {
    if (method !== "GET") return reply(405, { error: "method" });
    if (!turn) return reply(404, { error: "no turn configured" });
    // Not an open relay: only someone hosting a room, or joining one that exists.
    if (roomKey.length < 16 && !(await store.get(offerId))) return reply(404, { error: "no room" });
    try {
      return reply(200, { iceServers: await turn() });
    } catch (e) {
      console.error(e);
      return reply(502, { error: "turn unavailable" });
    }
  }

  if (kind === "offer" && parts.length === 3) {
    if (method === "GET") {
      const item = await store.get(offerId);
      if (!item) return reply(404, { error: "no offer" });
      return reply(200, { epoch: item.epoch, sdp: item.sdp });
    }
    if (method === "PUT") {
      if (roomKey.length < 16) return reply(401, { error: "missing room key" });
      const body = parseBody(req.body);
      if (!body || !EPOCH_RE.test(String(body.epoch)) || typeof body.sdp !== "object" || !body.sdp) {
        return reply(400, { error: "bad offer" });
      }
      const owner = hashKey(roomKey);
      const ok = await store.put(
        { id: offerId, epoch: String(body.epoch), sdp: body.sdp, owner, ttl: expires() },
        { notExistsOrOwner: owner },
      );
      return ok ? reply(204) : reply(409, { error: "room taken" });
    }
    return reply(405, { error: "method" });
  }

  if (kind === "answer" && parts.length === 4 && EPOCH_RE.test(parts[3])) {
    const id = `${room}#answer#${parts[3]}`;
    if (method === "GET") {
      const item = await store.get(id);
      if (!item) return reply(404, { error: "no answer" });
      return reply(200, { epoch: parts[3], sdp: item.sdp });
    }
    if (method === "PUT") {
      const body = parseBody(req.body);
      if (!body || typeof body.sdp !== "object" || !body.sdp) return reply(400, { error: "bad answer" });
      const offer = await store.get(offerId);
      if (!offer || offer.epoch !== parts[3]) return reply(409, { error: "stale epoch" });
      const ok = await store.put({ id, sdp: body.sdp, ttl: expires() }, { notExists: true });
      return ok ? reply(204) : reply(409, { error: "already answered" });
    }
    return reply(405, { error: "method" });
  }

  return reply(404, { error: "not found" });
}
