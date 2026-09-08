// 麥克風擷取（無 React）：getUserMedia → AudioWorklet（/pcm-worklet.js）→ 逐包 raw-body IPC 給 Rust 寫 wav。
//
// 關掉瀏覽器的 DSP（回音消除 / 降噪 / AGC）：那是給視訊會議用的，會把錄音處理得很怪；要降噪有我們自己的。
// 監聽預設關（開了會迴授）。裝置標籤要先拿過一次串流才有。
// `source` 可以換成任何 f32 mono 48k 的 AsyncIterable（dev 用 wav 檔餵、測試用合成），流程完全一樣。
import { invoke } from "@tauri-apps/api/core";
import { peakDb } from "./levels";

export interface RecordDone {
  path: string;
  duration_ms: number;
  frames: number;
  peak_dbfs: number;
  clipped_frames: number;
}

export interface InputDevice {
  deviceId: string;
  label: string;
}

export interface CaptureOptions {
  outPath: string;
  deviceId?: string | null;
  /** 每包的峰值（dBFS）與累計時間。 */
  onLevel?: (peakDb: number, elapsedMs: number) => void;
  /** 寫入跟不上（in-flight > 20 包）；不丟包，只是提醒。 */
  onBackpressure?: (inflight: number) => void;
  onError?: (e: unknown) => void;
  /** 來源自己結束了（只有 stub 來源會發生；麥克風不會）。 */
  onEnded?: () => void;
  /** 取代麥克風的來源（dev / 測試）。 */
  source?: AsyncIterable<Float32Array> | null;
}

export interface CaptureHandle {
  jobId: string;
  elapsedMs: () => number;
  stop: () => Promise<RecordDone>;
  cancel: () => Promise<void>;
}

export const SAMPLE_RATE = 48_000;

/** dev / 探針：下一次 startCapture 用這個來源代替麥克風（用過一次就清掉）。 */
let devStub: AsyncIterable<Float32Array> | null = null;
export function setDevStubSource(src: AsyncIterable<Float32Array> | null): void {
  devStub = src;
}
export function takeDevStubSource(): AsyncIterable<Float32Array> | null {
  const s = devStub;
  devStub = null;
  return s;
}

/** 列出輸入裝置（要先拿過一次權限才有標籤）。 */
export async function listInputs(): Promise<InputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {
    /* 沒權限就沒標籤，還是列得出 id */
  }
  const list = await navigator.mediaDevices.enumerateDevices();
  return list.filter((d) => d.kind === "audioinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `麥克風 ${i + 1}` }));
}

function newJobId(): string {
  return `rec-${Math.random().toString(36).slice(2, 10)}`;
}

export async function startCapture(opts: CaptureOptions): Promise<CaptureHandle> {
  const jobId = newJobId();
  await invoke("record_start", { jobId, outPath: opts.outPath, sampleRate: SAMPLE_RATE, channels: 1 });
  const t0 = performance.now();
  let frames = 0;
  let inflight = 0;
  let chain: Promise<void> = Promise.resolve();
  let failed: unknown = null;
  const push = (chunk: Float32Array) => {
    if (failed) return;
    frames += chunk.length;
    opts.onLevel?.(peakDb(chunk), (frames / SAMPLE_RATE) * 1000);
    inflight++;
    if (inflight > 20) opts.onBackpressure?.(inflight);
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    // 序列化：IPC 是非同步的，包的順序必須跟送出的順序一樣
    chain = chain
      .then(() => invoke<number>("record_write", bytes, { headers: { "x-job": jobId } }))
      .then(() => {
        inflight--;
      })
      .catch((e) => {
        inflight--;
        failed = e;
        opts.onError?.(e);
      });
  };

  let teardown: () => Promise<void> = async () => {};
  if (opts.source) {
    const src = opts.source;
    let stopped = false;
    const pump = (async () => {
      for await (const chunk of src) {
        if (stopped) break;
        push(chunk);
      }
      if (!stopped) opts.onEnded?.();
    })();
    teardown = async () => {
      stopped = true;
      await pump.catch(() => {});
    };
  } else {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    try {
      await ctx.audioWorklet.addModule("/pcm-worklet.js");
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      await invoke("record_cancel", { jobId }).catch(() => {});
      throw new Error(`AudioWorklet 載入失敗：${e instanceof Error ? e.message : String(e)}`);
    }
    const srcNode = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    let flushed: () => void = () => {};
    const flushedP = new Promise<void>((r) => (flushed = r));
    node.port.onmessage = (e) => {
      if (e.data === "flushed") flushed();
      else if (e.data instanceof Float32Array) push(e.data);
    };
    srcNode.connect(node);
    teardown = async () => {
      node.port.postMessage("stop");
      await Promise.race([flushedP, new Promise((r) => setTimeout(r, 500))]);
      srcNode.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => {});
    };
  }

  return {
    jobId,
    elapsedMs: () => (frames ? (frames / SAMPLE_RATE) * 1000 : performance.now() - t0),
    stop: async () => {
      await teardown();
      await chain;
      if (failed) {
        await invoke("record_cancel", { jobId }).catch(() => {});
        throw failed;
      }
      return invoke<RecordDone>("record_stop", { jobId });
    },
    cancel: async () => {
      await teardown();
      await chain.catch(() => {});
      await invoke("record_cancel", { jobId }).catch(() => {});
    },
  };
}

/** 測試 / dev：把一份 f32 mono 48k 陣列切成 4096 一包當來源，照真實時間吐（rate 1 = 即時、0 = 全速）。 */
export async function* chunkedSource(samples: Float32Array, rate = 0, chunk = 4096): AsyncGenerator<Float32Array> {
  for (let i = 0; i < samples.length; i += chunk) {
    const part = samples.slice(i, i + chunk);
    if (rate > 0) await new Promise((r) => setTimeout(r, (part.length / SAMPLE_RATE) * 1000 * rate));
    yield part;
  }
}
