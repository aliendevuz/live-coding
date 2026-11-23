// Short-lived TURN credentials for GET /rooms/{room}/ice.
//
// Configured by environment variables (none set = no TURN, clients use STUN only):
//   Cloudflare Realtime TURN (recommended: 1,000 GB/month free):
//     CF_TURN_KEY_ID, CF_TURN_API_TOKEN
//   Your own coturn with `use-auth-secret` / `static-auth-secret=...`:
//     TURN_URLS   comma-separated, e.g. "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp"
//     TURN_SECRET the static-auth-secret
//   TURN_TTL_SECONDS  credential lifetime (default 12 h: longer than a lesson)
import { createHmac } from "node:crypto";

const STUN = { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] };

/** env -> async () => RTCIceServer[] | null */
export function turnProvider(env = process.env) {
  const ttl = Number(env.TURN_TTL_SECONDS || 12 * 3600);
  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
    return async () => {
      const r = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ ttl }),
        },
      );
      if (!r.ok) throw new Error(`cloudflare turn: ${r.status} ${await r.text().catch(() => "")}`);
      const body = await r.json();
      // The API has returned both an array and a single object over time.
      const list = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
      // Browsers time out on :53 (DNS port, often filtered); the other URLs cover it.
      return [STUN, ...list.filter(Boolean).map(dropPort53)];
    };
  }
  if (env.TURN_URLS && env.TURN_SECRET) {
    const urls = env.TURN_URLS.split(",").map((u) => u.trim()).filter(Boolean);
    return async () => {
      // coturn REST API convention: username = expiry, password = base64(HMAC-SHA1(secret, username)).
      const username = `${Math.floor(Date.now() / 1000) + ttl}:duet`;
      const credential = createHmac("sha1", env.TURN_SECRET).update(username).digest("base64");
      return [STUN, { urls, username, credential }];
    };
  }
  return null;
}

function dropPort53(s) {
  const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u));
  return { ...s, urls };
}
