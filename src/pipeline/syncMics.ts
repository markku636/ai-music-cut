// 多麥克風同步：對齊 → 併成一軌 → 開起來繼續剪。
//
// 為什麼是「併成一軌」而不是保留成多軌：剪輯是在**來源時間軸**上做的，而 EDL、
// 跳播、驗收、輸出整條路徑都假設只有一個來源。硬要留多軌，就得讓每一刀同步套用到
// 每一軌，那是另一個層級的改動。先對齊、再合併，之後照常剪 —— 這也是多數人實際的
// 工作方式（同步完就當一軌處理），而且合併後的檔案是真的檔案，隨時可以重來。
//
// 對齊本身不碰音訊：只比對能量包絡（見 analysis/sync.ts）。
import { estimateGate, gateSpec, worthGating, type GateEstimate, type GateSpec } from "../analysis/gate";
import { estimateOffset, delaysFromOffsets, DEFAULT_SYNC, type SyncOptions } from "../analysis/sync";
import { api, type RenderGate } from "../api";
import { t } from "../i18n";
import { useProject } from "../store/project";
import { useTranscript } from "../store/transcript";
import { ensureLocalAnalysis } from "./waveform";

export interface MicSyncRow {
  mediaId: string;
  name: string;
  /** 這一軌量到的底噪 / 人聲差距（dB）—— 決定串音衰減值不值得做。 */
  gate: GateEstimate;
  /** 差距太小就不建議處理（硬切會傷到內容）。 */
  canGate: boolean;
  /** 相對基準軌的位移（負數＝這一軌比較早開始）。基準軌恆為 0。 */
  offsetMs: number;
  /** 0–1。低於 0.3 大概沒對上，UI 要標出來。 */
  confidence: number;
  /** 合併時實際要延遲多少（都 ≥ 0）。 */
  delayMs: number;
}

/** 只做對齊、不動檔案 —— 讓使用者先看結果再決定要不要合併。 */
export async function analyzeMicSync(mediaIds: string[], opts: SyncOptions = DEFAULT_SYNC): Promise<MicSyncRow[]> {
  if (mediaIds.length < 2) throw new Error(t("至少要選兩軌"));
  const proj = useProject.getState();
  for (const id of mediaIds) await ensureLocalAnalysis(id);
  const local = useTranscript.getState().local;
  const base = local[mediaIds[0]];
  if (!base) throw new Error(t("基準軌還沒分析完成"));

  const rows: MicSyncRow[] = [];
  for (let i = 0; i < mediaIds.length; i++) {
    const id = mediaIds[i];
    const name = proj.media.find((m) => m.id === id)?.name ?? id;
    const la = local[id];
    const g = la ? estimateGate(la) : { noiseFloorDb: -60, speechDb: -60, thresholdDb: -60, marginDb: 0 };
    if (i === 0) {
      rows.push({ mediaId: id, name, offsetMs: 0, confidence: 1, delayMs: 0, gate: g, canGate: worthGating(g) });
      continue;
    }
    const other = local[id];
    if (!other) throw new Error(t("「{name}」還沒分析完成", { name }));
    const r = estimateOffset(base, other, opts);
    rows.push({ mediaId: id, name, offsetMs: r.offsetMs, confidence: r.confidence, delayMs: 0, gate: g, canGate: worthGating(g) });
  }
  const delays = delaysFromOffsets(rows.map((r) => r.offsetMs));
  return rows.map((r, i) => ({ ...r, delayMs: delays[i] }));
}

/**
 * 依 rows 合併成一個新檔，開起來並設為使用中。回傳新檔路徑。
 *
 * `crosstalkDb` 給值就開串音衰減（只對「值得處理」的軌套用）：一人一軌時每支麥都收得到
 * 別人的聲音，合起來同一句話會聽到兩次 —— 一次清楚、一次糊的。
 */
export async function combineMics(rows: MicSyncRow[], crosstalkDb?: number): Promise<string> {
  const proj = useProject.getState();
  const paths: string[] = [];
  for (const r of rows) {
    const m = proj.media.find((x) => x.id === r.mediaId);
    if (!m) throw new Error(t("找不到媒體：{name}", { name: r.name }));
    paths.push(m.path);
  }
  const first = proj.media.find((m) => m.id === rows[0].mediaId)!;
  const base = first.path.replace(/\.[^.]+$/, "");
  const outPath = `${base}_synced.wav`;
  const gates = crosstalkDb == null ? undefined : rows.map((r) => (r.canGate ? toRenderGate(gateSpec(r.gate, crosstalkDb)) : null));
  await api.mediaCombine(
    paths,
    rows.map((r) => Math.max(0, Math.round(r.delayMs))),
    outPath,
    gates,
  );
  const id = await useProject.getState().openMedia(outPath);
  useProject.getState().setActive(id);
  return outPath;
}

function toRenderGate(g: GateSpec): RenderGate {
  return { threshold: g.threshold, range: g.range, attack_ms: g.attackMs, release_ms: g.releaseMs };
}
