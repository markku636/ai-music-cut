// 規則層 / EDL 與 store 的接線（分析完成、滑桿變動、專案還原時呼叫）。
import { buildEdl, DEFAULT_EDL_OPTIONS, type Edl, type EdlOptions, type EnergyProbe } from "../analysis/edl/build";
import { breathFor } from "../analysis/edl/breath";
import { hasZeroCross, loudnessWindows, minEnergyPointMs, nearestZeroCrossMs, rmsDbRange } from "../analysis/peaks";
import { runRulesAt } from "../analysis/rules";
import { thresholdsFor } from "../analysis/thresholds";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useTranscript } from "../store/transcript";

/** 用目前激進度對某媒體重跑規則層；回候選數。record=true 會記進 undo。 */
export function runRulesFor(mediaId: string, opts: { label?: string; record?: boolean } = {}): number {
  const ts = useTranscript.getState();
  const tr = ts.byMedia[mediaId];
  if (!tr) return 0;
  const local = ts.local[mediaId];
  const aggr = useProject.getState().aggressiveness;
  const cands = runRulesAt({ transcript: tr, loudness: local ? loudnessWindows(local) : [], loudnessHopMs: local?.hopMs ?? 100 }, aggr);
  useDecisions.getState().setCandidates(mediaId, cands, { label: opts.label ?? "規則分析", aggressiveness: aggr, record: opts.record ?? false });
  return cands.length;
}

/**
 * `edlFor` 的快取。
 *
 * **一次 buildEdl 在 57 分鐘的節目上要 48 毫秒**，而全 App 有二十幾個地方會叫它 ——
 * 時間軸、預覽列、審核模式、總覽條、字幕、章節、分割輸出…… 每個元件各自 useMemo，
 * 等於同一份 EDL 在一次決策變更後被重算四五遍。實測（11400 字）：接受一筆候選要
 * **4.1 秒**才畫得出來、拖播放線每格 272 毫秒。
 *
 * 鍵用**物件識別**而不是內容雜湊：zustand 每次變更都會換掉陣列 / 物件，
 * 所以識別相同就代表內容真的沒動，比算雜湊便宜得多（雜湊 4560 筆候選本身就不便宜）。
 */
const edlCache = new Map<string, { key: unknown[]; edl: Edl | null }>();

function sameKey(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 目前決策 → EDL（含自然度守門）。同樣的輸入會回同一個物件（見上面的快取說明）。 */
export function edlFor(mediaId: string): Edl | null {
  const ts = useTranscript.getState();
  const tr = ts.byMedia[mediaId];
  const durationMs = tr?.durationMs ?? useProject.getState().media.find((m) => m.id === mediaId)?.probe?.duration_ms ?? 0;
  if (!durationMs) return null;
  const local = ts.local[mediaId];
  const probe: EnergyProbe | undefined = local
    ? {
        minEnergyPointMs: (a, b) => minEnergyPointMs(local, a, b),
        rmsDbAt: (a, b) => rmsDbRange(local, a, b),
        // v2 的舊分析檔沒有零交越 → 不掛這個方法，buildEdl 就會跳過第三段細修
        ...(hasZeroCross(local) ? { nearestZeroCrossMs: (ms: number, w: number) => nearestZeroCrossMs(local, ms, w) } : {}),
      }
    : undefined;
  const d = useDecisions.getState();
  const aggressiveness = useProject.getState().aggressiveness;
  const key = [tr, local, d.candidates[mediaId], d.decisions[mediaId], d.splits[mediaId], aggressiveness, durationMs];
  const hit = edlCache.get(mediaId);
  if (hit && sameKey(hit.key, key)) return hit.edl;
  const th = thresholdsFor(aggressiveness);
  // pauseKeepMs 以前傳在這裡，但 EdlOptions 根本沒有這個欄位 —— 是個從來沒生效過的死參數。
  // 呼吸感現在走 breath（句中 / 句尾 / 段落三級，隨激進度縮放）。
  const opts: EdlOptions = {
    ...DEFAULT_EDL_OPTIONS,
    breath: breathFor(aggressiveness),
    maxSentenceRemovalRatio: th.maxSentenceRemovalRatio,
  };
  const edl = buildEdl(
    { words: tr?.words ?? [], sentences: tr?.sentences ?? [], vad: tr?.vad ?? [], durationMs, splits: d.splits[mediaId] ?? [] },
    d.candidates[mediaId] ?? [],
    d.decisions[mediaId] ?? {},
    opts,
    probe,
  );
  edlCache.set(mediaId, { key, edl });
  return edl;
}

/** 關檔 / 換專案時清掉，不要讓舊媒體的 EDL 一直佔著記憶體。 */
export function clearEdlCache(mediaId?: string): void {
  if (mediaId) edlCache.delete(mediaId);
  else edlCache.clear();
}
