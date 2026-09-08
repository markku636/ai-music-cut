// 麥克風 PCM 擷取：AudioWorklet 把第 0 聲道的 f32 累積成 4096 frame（≈ 85 ms @ 48k）一包丟回主執行緒。
// 不用 MediaRecorder：webm/opus 有損、時戳飄、還要多轉一次。這裡拿到的是原始 PCM，Rust 直接寫 wav。
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = 4096;
    this.buf = new Float32Array(this.chunk);
    this.fill = 0;
    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e.data === "stop") {
        this.flush();
        this.stopped = true;
      }
    };
  }
  flush() {
    if (this.fill > 0) {
      const out = this.buf.slice(0, this.fill);
      this.port.postMessage(out, [out.buffer]);
      this.fill = 0;
    }
    this.port.postMessage("flushed");
  }
  process(inputs) {
    if (this.stopped) return false;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const n = Math.min(ch.length - i, this.chunk - this.fill);
      this.buf.set(ch.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.chunk) {
        const out = this.buf;
        this.port.postMessage(out, [out.buffer]);
        this.buf = new Float32Array(this.chunk);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCaptureProcessor);
