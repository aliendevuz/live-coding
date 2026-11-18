// node signaling/test.mjs  — exercises logic.mjs against an in-memory store.
import assert from "node:assert/strict";
import { handle } from "./src/logic.mjs";

const items = new Map();
const store = {
  async get(id) { return items.get(id) || null; },
  async put(item, cond) {
    const cur = items.get(item.id);
    if (cond.notExists && cur) return false;
    if (cond.notExistsOrOwner && cur && cur.owner !== cond.notExistsOrOwner) return false;
    items.set(item.id, item);
    return true;
  },
  async del(id) { items.delete(id); },
};
const call = (method, path, body, key) =>
  handle({ method, path, headers: key ? { "x-room-key": key } : {}, body: body && JSON.stringify(body) }, store, 60);

const KEY = "k".repeat(32);
const room = "abcd1234ef";
const sdp = { type: "offer", sdp: "v=0" };

assert.equal((await call("GET", `/rooms/${room}/offer`)).statusCode, 404);
assert.equal((await call("PUT", `/rooms/${room}/offer`, { epoch: 1, sdp })).statusCode, 401);
assert.equal((await call("PUT", `/rooms/${room}/offer`, { epoch: 1, sdp }, KEY)).statusCode, 204);
assert.equal((await call("PUT", `/rooms/${room}/offer`, { epoch: 2, sdp }, "x".repeat(32))).statusCode, 409, "other host");
const got = await call("GET", `/rooms/${room}/offer`);
assert.deepEqual(JSON.parse(got.body), { epoch: "1", sdp });
assert.equal((await call("PUT", `/rooms/${room}/answer/2`, { sdp })).statusCode, 409, "stale epoch");
assert.equal((await call("PUT", `/rooms/${room}/answer/1`, { sdp })).statusCode, 204);
assert.equal((await call("PUT", `/rooms/${room}/answer/1`, { sdp })).statusCode, 409, "second answer");
assert.equal((await call("GET", `/rooms/${room}/answer/1`)).statusCode, 200);
// reconnect: same host, new epoch
assert.equal((await call("PUT", `/rooms/${room}/offer`, { epoch: 5, sdp }, KEY)).statusCode, 204);
assert.equal((await call("PUT", `/rooms/${room}/answer/5`, { sdp })).statusCode, 204);
assert.equal((await call("GET", "/rooms/BAD!/offer")).statusCode, 404);
assert.equal((await call("DELETE", `/rooms/${room}`, null, "x".repeat(32))).statusCode, 403);
assert.equal((await call("DELETE", `/rooms/${room}`, null, KEY)).statusCode, 204);
assert.equal((await call("GET", `/rooms/${room}/offer`)).statusCode, 404);
console.log("signaling logic: all tests passed");
