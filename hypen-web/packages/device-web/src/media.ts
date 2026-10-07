/**
 * Platform media seams for the browser DeviceHost's capture drivers
 * (`camera.capture`, `mic.record`, `permission.request`). The default
 * implementation is the real browser (getUserMedia, canvas JPEG,
 * MediaRecorder, Web Audio with an AudioWorklet and a ScriptProcessor
 * fallback); tests inject fakes of the same shapes.
 */

/** The subset of a MediaStream the host touches. */
export interface MediaStreamLike {
  getTracks(): Array<{ kind?: string; stop(): void; readyState?: string }>;
}

/** The subset of MediaRecorder the camera driver uses. */
export interface RecorderLike {
  readonly state: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
  start(timesliceMs?: number): void;
  stop(): void;
}

/** A running PCM capture graph. */
export interface AudioCaptureLike {
  /** The rate the planar blocks arrive at (the AudioContext's rate). */
  readonly sampleRate: number;
  /** Deliver any partially filled block, then resolve (bounded wait). */
  flush(): Promise<void>;
  /** Tear the graph down (idempotent). */
  close(): void;
}

export interface MediaBackend {
  /** `navigator.mediaDevices.getUserMedia`, or undefined when absent. */
  readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStreamLike>;
  /** Attach a live stream to the host's preview element and start playback. */
  attachPreview(video: HTMLVideoElement, stream: MediaStreamLike): Promise<void>;
  /** Encode the preview's current frame as a JPEG. */
  snapshot(video: HTMLVideoElement): Promise<Blob>;
  /** A recorder for a video stream, and the bare media type it produces. */
  createRecorder(stream: MediaStreamLike): { recorder: RecorderLike; contentType: string } | null;
  /**
   * Start PCM capture of `stream` with exactly `channels` channels: planar
   * float blocks go to `onBlock` as they are captured. Resolves once the
   * graph runs.
   */
  openAudioCapture?: (
    stream: MediaStreamLike,
    channels: 1 | 2,
    onBlock: (planar: Float32Array[]) => void
  ) => Promise<AudioCaptureLike>;
}

/** Bare media type (drivers strip codec parameters, RFC 001 §3). */
export function bareMediaType(type: string): string {
  return type.split(";")[0]!.trim().toLowerCase();
}

const VIDEO_TYPES = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm", "video/mp4"];

/** AudioWorklet processor: batches render quanta into planar blocks. */
const WORKLET_SOURCE = `
class HypenPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 2048;
    this.buf = null;
    this.n = 0;
    this.port.onmessage = (ev) => {
      if (ev.data === "flush") {
        const out = this.buf && this.n > 0 ? this.buf.map((b) => b.slice(0, this.n)) : [];
        this.buf = null;
        this.n = 0;
        this.port.postMessage({ flushed: true, data: out });
      }
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input.length;
    if (!this.buf || this.buf.length !== ch) {
      this.buf = Array.from({ length: ch }, () => new Float32Array(this.size));
      this.n = 0;
    }
    const len = input[0].length;
    let off = 0;
    while (off < len) {
      const k = Math.min(this.size - this.n, len - off);
      for (let c = 0; c < ch; c++) this.buf[c].set(input[c].subarray(off, off + k), this.n);
      this.n += k;
      off += k;
      if (this.n === this.size) {
        const full = this.buf;
        this.port.postMessage({ data: full }, full.map((b) => b.buffer));
        this.buf = Array.from({ length: ch }, () => new Float32Array(this.size));
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("hypen-pcm-capture", HypenPcmCapture);
`;

type AudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

/**
 * The real browser backend for `view` (a window). `audioWorklet: false`
 * forces the ScriptProcessor capture path (engines without AudioWorklet —
 * also how the fallback is exercised in a real browser).
 */
export function browserMediaBackend(view: Window | null, options: { audioWorklet?: boolean } = {}): MediaBackend {
  const useWorklet = options.audioWorklet ?? true;
  const win = (view ?? (globalThis as unknown as Window)) as AudioWindow;
  const media = win.navigator?.mediaDevices;
  return {
    getUserMedia:
      media && typeof media.getUserMedia === "function"
        ? (constraints) => media.getUserMedia(constraints)
        : undefined,

    async attachPreview(video, stream) {
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      (video as unknown as { srcObject: unknown }).srcObject = stream;
      try {
        await video.play();
      } catch {
        /* autoplay refused: the preview still renders frames once data flows */
      }
      if (video.readyState < 2 || video.videoWidth === 0) {
        await new Promise<void>((resolve) => {
          const done = () => {
            video.removeEventListener("loadeddata", done);
            resolve();
          };
          video.addEventListener("loadeddata", done);
          setTimeout(done, 3000);
        });
      }
    },

    async snapshot(video) {
      const w = video.videoWidth || 640;
      const h = video.videoHeight || 480;
      const canvas = video.ownerDocument.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext("2d");
      if (!g) throw new Error("canvas 2d unavailable");
      g.drawImage(video, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("JPEG encoding failed");
      return blob;
    },

    createRecorder(stream) {
      const Recorder = win.MediaRecorder;
      if (typeof Recorder !== "function") return null;
      const mimeType = VIDEO_TYPES.find((t) => {
        try {
          return Recorder.isTypeSupported(t);
        } catch {
          return false;
        }
      });
      if (!mimeType) return null;
      const recorder = new Recorder(stream as MediaStream, { mimeType });
      return { recorder: recorder as unknown as RecorderLike, contentType: bareMediaType(mimeType) };
    },

    openAudioCapture:
      typeof (win.AudioContext ?? win.webkitAudioContext) === "function"
        ? async (stream, channels, onBlock) => {
            const Ctx = (win.AudioContext ?? win.webkitAudioContext)!;
            const ctx = new Ctx();
            let closed = false;
            const teardown: Array<() => void> = [];
            const close = () => {
              if (closed) return;
              closed = true;
              for (const t of teardown.splice(0)) {
                try {
                  t();
                } catch {
                  /* already disconnected */
                }
              }
              void ctx.close().catch(() => undefined);
            };
            try {
              if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
              const source = ctx.createMediaStreamSource(stream as MediaStream);
              // Keep the graph pulled without producing sound.
              const sink = ctx.createGain();
              sink.gain.value = 0;
              sink.connect(ctx.destination);
              teardown.push(() => source.disconnect(), () => sink.disconnect());

              if (useWorklet && ctx.audioWorklet && typeof win.AudioWorkletNode === "function") {
                const url = win.URL.createObjectURL(new win.Blob([WORKLET_SOURCE], { type: "text/javascript" }));
                try {
                  await ctx.audioWorklet.addModule(url);
                } finally {
                  win.URL.revokeObjectURL(url);
                }
                const node = new win.AudioWorkletNode(ctx, "hypen-pcm-capture", {
                  numberOfInputs: 1,
                  numberOfOutputs: 1,
                  outputChannelCount: [channels],
                  channelCount: channels,
                  channelCountMode: "explicit",
                  channelInterpretation: "speakers",
                });
                let flushed: (() => void) | null = null;
                node.port.onmessage = (ev: MessageEvent) => {
                  const msg = ev.data as { data: Float32Array[]; flushed?: boolean };
                  if (!closed && msg.data.length > 0) onBlock(msg.data);
                  if (msg.flushed) {
                    const f = flushed;
                    flushed = null;
                    f?.();
                  }
                };
                source.connect(node);
                node.connect(sink);
                teardown.push(() => {
                  node.port.onmessage = null;
                  node.disconnect();
                });
                return {
                  sampleRate: ctx.sampleRate,
                  flush: () =>
                    closed
                      ? Promise.resolve()
                      : new Promise<void>((resolve) => {
                          flushed = resolve;
                          node.port.postMessage("flush");
                          setTimeout(resolve, 250);
                        }),
                  close,
                };
              }

              // ScriptProcessor fallback (engines without AudioWorklet).
              const proc = ctx.createScriptProcessor(4096, channels, channels);
              proc.channelCount = channels;
              proc.channelCountMode = "explicit";
              proc.onaudioprocess = (ev: AudioProcessingEvent) => {
                if (closed) return;
                const input = ev.inputBuffer;
                const planar: Float32Array[] = [];
                for (let c = 0; c < input.numberOfChannels; c++) planar.push(input.getChannelData(c).slice());
                if (planar.length > 0) onBlock(planar);
              };
              source.connect(proc);
              proc.connect(sink);
              teardown.push(() => {
                proc.onaudioprocess = null;
                proc.disconnect();
              });
              return { sampleRate: ctx.sampleRate, flush: () => Promise.resolve(), close };
            } catch (err) {
              close();
              throw err;
            }
          }
        : undefined,
  };
}

/** Stop every track of a stream (idempotent, never throws). */
export function stopStream(stream: MediaStreamLike | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  }
}

/** Map a getUserMedia rejection to a DeviceErrorCode + detail. */
export function mediaErrorOutcome(err: unknown): { code: "denied" | "unavailable"; platformDetail: string } {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return { code: "denied", platformDetail: `platform-refused:${String(name)}` };
  }
  return { code: "unavailable", platformDetail: `media:${typeof name === "string" ? name : "error"}` };
}
