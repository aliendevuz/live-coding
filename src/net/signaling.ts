// Client for the Lambda signaling mailbox (see signaling/src/logic.mjs).
// Used only to exchange one offer/answer per (re)connect; afterwards all
// traffic is peer-to-peer.

export interface Signal {
  epoch: string;
  sdp: RTCSessionDescriptionInit;
}

export class SignalingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class Signaling {
  constructor(
    private baseUrl: string,
    private room: string,
    private roomKey?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async req(method: string, path: string, body?: unknown): Promise<Signal | null> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.roomKey) headers["x-room-key"] = this.roomKey;
    const r = await fetch(`${this.baseUrl}/rooms/${this.room}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 404 && method === "GET") return null;
    if (!r.ok) {
      const msg = await r.text().catch(() => "");
      throw new SignalingError(`signaling ${method} ${path}: ${r.status} ${msg}`, r.status);
    }
    return r.status === 204 ? null : ((await r.json()) as Signal);
  }

  putOffer(epoch: string, sdp: RTCSessionDescriptionInit) {
    return this.req("PUT", "/offer", { epoch, sdp });
  }
  getOffer() {
    return this.req("GET", "/offer");
  }
  putAnswer(epoch: string, sdp: RTCSessionDescriptionInit) {
    return this.req("PUT", `/answer/${epoch}`, { sdp });
  }
  getAnswer(epoch: string) {
    return this.req("GET", `/answer/${epoch}`);
  }
  close() {
    return this.req("DELETE", "").catch(() => null);
  }
}
