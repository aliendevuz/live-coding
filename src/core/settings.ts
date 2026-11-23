export interface Settings {
  name: string;
  signalingUrl: string;
  micId: string;
  micVolume: number;
  sysVolume: number;
  outVolume: number;
}

const KEY = "duet.settings";
const DEFAULT_URL = (import.meta.env.VITE_SIGNALING_URL as string | undefined) || "http://localhost:8787";

export function loadSettings(): Settings {
  const raw = localStorage.getItem(KEY);
  const s = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
  // A stale local test URL must not override the URL built into this installer.
  const url = s.signalingUrl && !(s.signalingUrl.includes("localhost") && !DEFAULT_URL.includes("localhost")) ? s.signalingUrl : DEFAULT_URL;
  const vol = (v: unknown, max: number) => (typeof v === "number" && v >= 0 && v <= max ? v : 1);
  return {
    name: s.name || "",
    signalingUrl: url,
    micId: s.micId || "",
    micVolume: vol(s.micVolume, 2),
    sysVolume: vol(s.sysVolume, 2),
    outVolume: vol(s.outVolume, 1),
  };
}

export function saveSettings(s: Settings) {
  // Only remember the URL when the user changed it from the built-in default.
  const { signalingUrl, ...rest } = s;
  localStorage.setItem(KEY, JSON.stringify(signalingUrl === DEFAULT_URL ? rest : s));
}

/** The host remembers its last room so a restarted app can reopen the same code. */
export interface HostedRoom {
  room: string;
  key: string;
  project: string;
}
export const loadHostedRoom = (): HostedRoom | null => JSON.parse(localStorage.getItem("duet.hosted") || "null");
export const saveHostedRoom = (r: HostedRoom) => localStorage.setItem("duet.hosted", JSON.stringify(r));
