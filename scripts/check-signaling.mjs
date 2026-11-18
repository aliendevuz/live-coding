// Smoke test for a deployed signaling URL.
//   node scripts/check-signaling.mjs https://xxxx.lambda-url.<region>.on.aws
const U = (process.argv[2] || "").replace(/\/+$/, "");
if (!U) throw new Error("usage: node scripts/check-signaling.mjs <signaling-url>");

const room = "t" + Math.random().toString(36).slice(2, 11);
const key = "k".repeat(32);
const sdp = { type: "offer", sdp: "v=0" };
let failed = 0;

async function r(method, path, body, roomKey) {
  const headers = { "content-type": "application/json", origin: "http://tauri.localhost" };
  if (roomKey) headers["x-room-key"] = roomKey;
  const t = Date.now();
  const res = await fetch(U + path, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { status: res.status, ms: Date.now() - t, cors: res.headers.get("access-control-allow-origin"), body: await res.text() };
}
function check(name, res, want) {
  const ok = res.status === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${res.status} (${res.ms} ms)${ok ? "" : "  " + res.body}`);
}

check("GET offer of an empty room", await r("GET", `/rooms/${room}/offer`), 404);
check("host PUTs offer", await r("PUT", `/rooms/${room}/offer`, { epoch: 1, sdp }, key), 204);
check("another host cannot take the room", await r("PUT", `/rooms/${room}/offer`, { epoch: 2, sdp }, "x".repeat(32)), 409);
const got = await r("GET", `/rooms/${room}/offer`);
check("guest GETs offer", got, 200);
if (got.cors !== "*" && got.cors !== "http://tauri.localhost") {
  failed++;
  console.log(`FAIL  CORS header missing (got ${got.cors})`);
}
check("guest PUTs answer", await r("PUT", `/rooms/${room}/answer/1`, { sdp }), 204);
check("second answer rejected", await r("PUT", `/rooms/${room}/answer/1`, { sdp }), 409);
check("host GETs answer", await r("GET", `/rooms/${room}/answer/1`), 200);
check("delete with wrong key", await r("DELETE", `/rooms/${room}`, null, "x".repeat(32)), 403);
check("host deletes room", await r("DELETE", `/rooms/${room}`, null, key), 204);

const pre = await fetch(U + `/rooms/${room}/offer`, {
  method: "OPTIONS",
  headers: { origin: "http://tauri.localhost", "access-control-request-method": "PUT", "access-control-request-headers": "content-type,x-room-key" },
  signal: AbortSignal.timeout(15000),
});
const allowH = (pre.headers.get("access-control-allow-headers") || "").toLowerCase();
const preOk = pre.ok && allowH.includes("x-room-key");
if (!preOk) failed++;
console.log(`${preOk ? "PASS" : "FAIL"}  CORS preflight: ${pre.status} allow-headers=${allowH}`);

console.log(failed ? `\n${failed} FAILED` : "\nSignaling URL works.");
process.exit(failed ? 1 : 0);
