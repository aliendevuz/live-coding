// Microphone capture, remote playback and simple level meters.

import { Emitter } from "./util";

type Events = { levels: { me: number; peer: number } };

export async function listMics(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  } catch {
    return [];
  }
}

export class Audio extends Emitter<Events> {
  track: MediaStreamTrack | null = null;
  muted = false;
  private ctx: AudioContext | null = null;
  private meMeter: AnalyserNode | null = null;
  private peerMeter: AnalyserNode | null = null;
  private el = new Audio_Element();
  private timer = 0;

  async startMic(deviceId?: string): Promise<MediaStreamTrack | null> {
    this.track?.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.track = stream.getAudioTracks()[0] ?? null;
    } catch (e) {
      console.warn("microphone unavailable", e);
      this.track = null;
    }
    if (this.track) {
      this.track.enabled = !this.muted;
      this.meMeter = this.meter(new MediaStream([this.track]));
    }
    this.ensureLoop();
    return this.track;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.track) this.track.enabled = !m;
  }

  playRemote(stream: MediaStream) {
    this.el.play(stream);
    this.peerMeter = this.meter(stream);
    this.ensureLoop();
  }

  setOutputVolume(v: number) {
    this.el.volume(v);
  }

  stop() {
    this.track?.stop();
    this.track = null;
    clearInterval(this.timer);
    this.el.play(null);
    void this.ctx?.close();
    this.ctx = null;
  }

  private meter(stream: MediaStream): AnalyserNode | null {
    try {
      this.ctx ??= new AudioContext();
      const src = this.ctx.createMediaStreamSource(stream);
      const a = this.ctx.createAnalyser();
      a.fftSize = 512;
      src.connect(a);
      return a;
    } catch {
      return null;
    }
  }

  private ensureLoop() {
    if (this.timer) return;
    const buf = new Uint8Array(512);
    const level = (a: AnalyserNode | null) => {
      if (!a) return 0;
      a.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += (v - 128) ** 2;
      return Math.min(1, Math.sqrt(sum / buf.length) / 40);
    };
    this.timer = window.setInterval(() => {
      void this.ctx?.resume();
      this.emit("levels", { me: this.muted ? 0 : level(this.meMeter), peer: level(this.peerMeter) });
    }, 120);
  }
}

/** Hidden <audio> element for the peer's voice. */
class Audio_Element {
  private el: HTMLAudioElement;
  constructor() {
    this.el = document.createElement("audio");
    this.el.autoplay = true;
    document.body.appendChild(this.el);
  }
  play(stream: MediaStream | null) {
    this.el.srcObject = stream;
    if (stream) void this.el.play().catch(() => {});
  }
  volume(v: number) {
    this.el.volume = v;
  }
}
