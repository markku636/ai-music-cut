// CLI 的地端模型：轉寫（faster-whisper）與人聲分離（demucs）。
//
// App 那邊走 Tauri 指令，CLI 沒有 Tauri，所以直接 spawn python —— 但**參數與模型要一致**，
// 不然同一個檔在 App 與 CLI 會得到不一樣的逐字稿，而那種不一致沒有人會發現。
// 對照組：`src-tauri/src/local_asr.rs` 的 sidecar 與 `local_separate.rs` 的 demucs_args。
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** 跟 Rust 端同一支腳本：輸出格式必須一致，前端 / CLI 才共用一套解析。 */
const TRANSCRIBE_PY = `
import json, sys

def main():
    audio, model_name, language, out_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        sys.stderr.write("faster-whisper 未安裝：%s\\n" % e)
        return 2
    try:
        model = WhisperModel(model_name, device="auto", compute_type="int8")
    except Exception as e:
        sys.stderr.write("模型載入失敗：%s\\n" % e)
        return 3
    lang = None if not language or language in ("auto", "") else language
    segments, info = model.transcribe(
        audio, language=lang, word_timestamps=True, vad_filter=True,
        condition_on_previous_text=False,
    )
    out_segments = []
    for i, s in enumerate(segments):
        words = [{"start": float(w.start), "end": float(w.end), "word": w.word,
                  "probability": float(getattr(w, "probability", 0.0) or 0.0)} for w in (s.words or [])]
        out_segments.append({
            "id": i, "start": float(s.start), "end": float(s.end), "text": s.text,
            "avg_logprob": float(getattr(s, "avg_logprob", 0.0) or 0.0),
            "no_speech_prob": float(getattr(s, "no_speech_prob", 0.0) or 0.0),
            "compression_ratio": float(getattr(s, "compression_ratio", 0.0) or 0.0),
            "words": words,
        })
    doc = {"model": model_name, "language": getattr(info, "language", None) or lang or "",
           "duration_sec": float(getattr(info, "duration", 0.0) or 0.0), "segments": out_segments}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    return 0

sys.exit(main())
`;

export interface RunResult {
  code: number | null;
  stderr: string;
}

function run(py: string, args: string[], onLine?: (line: string) => void): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(py, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buf = "";
    p.stderr.on("data", (d) => {
      const s = String(d);
      stderr += s;
      buf += s;
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) onLine?.(l.trim());
    });
    p.stdout.on("data", () => {});
    p.on("error", (e) => resolve({ code: null, stderr: String(e) }));
    p.on("close", (code) => resolve({ code, stderr }));
  });
}

export function pythonBin(): string {
  return process.env.AICUT_PYTHON?.trim() || "python";
}

/** 本機轉寫。回傳與 App 相同形狀的逐字稿文件。 */
export async function transcribeLocal(
  audioPath: string,
  opts: { model?: string; language?: string; onLine?: (line: string) => void },
): Promise<unknown> {
  const dir = await mkdtemp(path.join(tmpdir(), "aicut-asr-"));
  const out = path.join(dir, "doc.json");
  try {
    const r = await run(
      pythonBin(),
      ["-c", TRANSCRIBE_PY, audioPath, opts.model?.trim() || "large-v3", opts.language ?? "zh", out],
      opts.onLine,
    );
    if (r.code !== 0) {
      // 腳本自己會說原因（未安裝 / 模型載入失敗）；2 才是「套件沒裝」，別無條件叫人 pip install
      const detail = r.stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
      const hint = r.code === 2 ? `　→ ${pythonBin()} -m pip install -U faster-whisper` : "";
      throw new Error(detail ? `本機辨識失敗：${detail}${hint}` : `本機辨識以結束碼 ${r.code} 退出${hint}`);
    }
    return JSON.parse(await readFile(out, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface LocalStem {
  name: string;
  label: string;
  path: string;
  bytes: number;
}

/** demucs 把結果寫在 `<out>/htdemucs/<檔名去副檔名>/<軌>.wav`。 */
export function stemPath(outDir: string, input: string, stem: string): string {
  return path.join(outDir, "htdemucs", path.parse(input).name, `${stem}.wav`);
}

export function expectedStems(stems: "vocals_accom" | "all"): { name: string; label: string }[] {
  return stems === "all"
    ? [
        { name: "vocals", label: "人聲" },
        { name: "drums", label: "鼓" },
        { name: "bass", label: "貝斯" },
        { name: "other", label: "其他" },
      ]
    : [
        { name: "vocals", label: "人聲" },
        { name: "no_vocals", label: "伴奏（去人聲）" },
      ];
}

/** 本機人聲分離。參數要跟 Rust 端一致，同一個檔在兩邊才會得到同一組軌。 */
export async function separateLocal(
  filePath: string,
  stems: "vocals_accom" | "all",
  outDir: string,
  onLine?: (line: string) => void,
): Promise<LocalStem[]> {
  const args = ["-m", "demucs", "-n", "htdemucs"];
  if (stems !== "all") args.push("--two-stems=vocals");
  args.push("-o", outDir, filePath);
  const r = await run(pythonBin(), args, onLine);
  if (r.code !== 0) {
    const detail = r.stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    throw new Error(detail ? `本機分離失敗：${detail}` : `本機分離以結束碼 ${r.code} 退出　→ ${pythonBin()} -m pip install -U demucs`);
  }
  const out: LocalStem[] = [];
  for (const s of expectedStems(stems)) {
    const p = stemPath(outDir, filePath, s.name);
    const bytes = await stat(p).then((x) => x.size).catch(() => 0);
    if (!bytes) throw new Error(`分離完成但找不到 ${s.label} 那一軌（${p}）`);
    out.push({ ...s, path: p, bytes });
  }
  return out;
}
