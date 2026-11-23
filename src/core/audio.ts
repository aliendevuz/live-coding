// Lesson audio: what we send is a mix of the microphone and (optionally) the
// computer's own sound, each with its own mute and volume. The partner's voice
// plays through a hidden <audio> element.
//
// System audio comes from the Rust side (sysaudio.rs), which captures every
// process EXCEPT this app's own process tree, so the partner's voice we play
// is never sent back to them (no echo loop, no howling speakers).

import { Channel, invoke } from "@tauri-apps/api/core";
import { Emitter } from "./util";

export interface Levels {
  me: number; // what the partner hears (after mutes and volumes)
  peer: number;
  mic: number; // raw microphone input, for the settings dialog
  sys: number; // raw system audio input
}

export interface AudioState {
  micId: string;
  micMuted: boolean;
  micVolume: number; // 0..2
  micOk: boolean;
  sysOn: boolean;
  sysMuted: boolean;
  sysVolume: number; // 0..2
  sysError: string;
  outVolume: number; // partner's voice, 0..1
}

type Events = { levels: Levels; state: AudioState };

const RATE = 48_000;

export async function listMics(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  } catch {
    return [];
  }
}

// Plays the PCM chunks Rust sends (mono f32, 48 kHz) into the audio graph.
// A small jitter buffer: start after ~30 ms, trim back when it grows past
// ~150 ms (the two clocks drift), output silence when it runs dry.
const WORKLET = `
class SysAudioFeed extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${RATE});
    this.r = 0; this.w = 0; this.n = 0; this.primed = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      for (let i = 0; i < d.length; i++) {
        this.buf[this.w] = d[i];
        this.w = (this.w + 1) % this.buf.length;
      }
      this.n = Math.min(this.buf.length, this.n + d.length);
      if (this.n > ${RATE * 0.15}) {
        const drop = this.n - ${RATE * 0.04};
        this.r = (this.r + drop) % this.buf.length;
        this.n -= drop;
      }
    };
  }
  process(_in, outs) {
    const out = outs[0][0];
    if (!this.primed && this.n >= ${RATE * 0.03}) this.primed = true;
    for (let i = 0; i < out.length; i++) {
      if (this.primed && this.n > 0) {
        out[i] = this.buf[this.r];
        this.r = (this.r + 1) % this.buf.length;
        this.n--;
      } else out[i] = 0;
    }
    if (this.n === 0) this.primed = false;
    for (let c = 1; c < outs[0].length; c++) outs[0][c].set(out);
    return true;
  }
}
registerProcessor("sysaudio-feed", SysAudioFeed);
`;

export class Audio extends Emitter<Events> {
  /** The track sent to the partner: the mix. Stable for the whole session. */
  track: MediaStreamTrack | null = null;
  state: AudioState;

  private ctx: AudioContext | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private micGain: GainNode | null = null;
  private sysGain: GainNode | null = null;
  private micSrc: MediaStreamAudioSourceNode | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private sysNode: AudioWorkletNode | null = null;
  private workletReady: Promise<void> | null = null;
  private meMeter: AnalyserNode | null = null;
  private micMeter: AnalyserNode | null = null;
  private sysMeter: AnalyserNode | null = null;
  private peerMeter: AnalyserNode | null = null;
  private el = new Audio_Element();
  private timer = 0;
  private sysGen = 0;

  constructor(prefs: { micId?: string; micVolume?: number; sysVolume?: number; outVolume?: number } = {}) {
    super();
    this.state = {
      micId: prefs.micId ?? "",
      micMuted: false,
      micVolume: prefs.micVolume ?? 1,
      micOk: false,
      sysOn: false,
      sysMuted: false,
      sysVolume: prefs.sysVolume ?? 1,
      sysError: "",
      outVolume: prefs.outVolume ?? 1,
    };
    this.el.volume(this.state.outVolume);
  }

  /** Nothing reaches the partner: microphone muted and no system audio. */
  get muted() {
    return this.state.micMuted && (!this.state.sysOn || this.state.sysMuted);
  }

  private graph() {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
    this.ctx = ctx;
    this.dest = ctx.createMediaStreamDestination();
    this.micGain = ctx.createGain();
    this.sysGain = ctx.createGain();
    this.micGain.connect(this.dest);
    this.sysGain.connect(this.dest);
    this.meMeter = this.analyser();
    this.micGain.connect(this.meMeter!);
    this.sysGain.connect(this.meMeter!);
    this.track = this.dest.stream.getAudioTracks()[0] ?? null;
    this.applyGains();
    // The mix only flows while the context runs; the autoplay policy may hold
    // it until the first click or key press (e.g. a folder dropped on the icon).
    const wake = () => {
      if (this.ctx !== ctx || ctx.state !== "suspended") return off();
      void ctx.resume().then(() => ctx.state === "running" && off());
    };
    const off = () => ["pointerdown", "keydown"].forEach((t) => window.removeEventListener(t, wake, true));
    ["pointerdown", "keydown"].forEach((t) => window.addEventListener(t, wake, true));
    return ctx;
  }

  private analyser() {
    const a = this.ctx!.createAnalyser();
    a.fftSize = 512;
    return a;
  }

  private applyGains() {
    const s = this.state;
    if (this.micGain) this.micGain.gain.value = s.micMuted ? 0 : s.micVolume;
    if (this.sysGain) this.sysGain.gain.value = s.sysMuted ? 0 : s.sysVolume;
    if (this.micTrack) this.micTrack.enabled = !s.micMuted;
  }

  private set(patch: Partial<AudioState>) {
    this.state = { ...this.state, ...patch };
    this.applyGains();
    this.emit("state", this.state);
  }

  /** Open the microphone (again, when the device changes). Returns the mix track. */
  async startMic(deviceId = this.state.micId): Promise<MediaStreamTrack | null> {
    const ctx = this.graph();
    this.micSrc?.disconnect();
    this.micTrack?.stop();
    this.micSrc = null;
    this.micTrack = null;
    this.micMeter = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.micTrack = stream.getAudioTracks()[0] ?? null;
    } catch (e) {
      console.warn("microphone unavailable", e);
    }
    if (this.micTrack) {
      this.micSrc = ctx.createMediaStreamSource(new MediaStream([this.micTrack]));
      this.micSrc.connect(this.micGain!);
      this.micMeter = this.analyser();
      this.micSrc.connect(this.micMeter);
    }
    this.set({ micId: deviceId, micOk: !!this.micTrack });
    this.ensureLoop();
    return this.track;
  }

  setMicMuted(m: boolean) {
    this.set({ micMuted: m });
  }
  setMicVolume(v: number) {
    this.set({ micVolume: v });
  }
  setSysMuted(m: boolean) {
    this.set({ sysMuted: m });
  }
  setSysVolume(v: number) {
    this.set({ sysVolume: v });
  }
  setOutputVolume(v: number) {
    this.el.volume(v);
    this.set({ outVolume: v });
  }

  /** Start or stop sending the computer's sound (everything but this app). */
  async setSysOn(on: boolean) {
    const gen = ++this.sysGen;
    if (!on) {
      this.stopSys();
      this.set({ sysOn: false, sysError: "" });
      return;
    }
    const ctx = this.graph();
    try {
      this.workletReady ??= ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
      await this.workletReady;
      if (gen !== this.sysGen) return;
      const node = new AudioWorkletNode(ctx, "sysaudio-feed", { numberOfInputs: 0, outputChannelCount: [1] });
      const ch = new Channel<ArrayBuffer>();
      ch.onmessage = (buf) => {
        if (this.sysNode === node) node.port.postMessage(new Float32Array(buf));
      };
      this.stopSys();
      this.sysNode = node;
      node.connect(this.sysGain!);
      this.sysMeter = this.analyser();
      node.connect(this.sysMeter);
      await invoke("sysaudio_start", { onData: ch });
      if (gen !== this.sysGen) return;
      this.set({ sysOn: true, sysError: "" });
      this.ensureLoop();
    } catch (e) {
      if (gen !== this.sysGen) return;
      this.stopSys();
      this.set({ sysOn: false, sysError: String(e instanceof Error ? e.message : e) });
    }
  }

  private stopSys() {
    if (this.sysNode) void invoke("sysaudio_stop").catch(() => {});
    this.sysNode?.disconnect();
    this.sysNode = null;
    this.sysMeter = null;
  }

  playRemote(stream: MediaStream) {
    this.el.play(stream);
    try {
      const src = this.graph().createMediaStreamSource(stream);
      this.peerMeter = this.analyser();
      src.connect(this.peerMeter);
    } catch {
      this.peerMeter = null;
    }
    this.ensureLoop();
  }

  stop() {
    this.sysGen++;
    this.stopSys();
    this.micTrack?.stop();
    this.micTrack = null;
    this.track?.stop();
    this.track = null;
    clearInterval(this.timer);
    this.timer = 0;
    this.el.play(null);
    void this.ctx?.close();
    this.ctx = null;
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
      if (this.ctx?.state === "suspended") void this.ctx.resume();
      this.emit("levels", {
        me: this.muted ? 0 : level(this.meMeter),
        peer: level(this.peerMeter),
        mic: level(this.micMeter),
        sys: level(this.sysMeter),
      });
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
    else this.el.remove();
  }
  volume(v: number) {
    this.el.volume = Math.max(0, Math.min(1, v));
  }
}
