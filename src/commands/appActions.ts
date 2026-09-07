import { api, errMessage } from "../api";
import { AUDIO_EXTENSIONS } from "../brand";
import { nextSpeakerChange, speakerAtMs } from "../analysis/speakers";
import { isActiveState } from "../analysis/types";
import { t } from "../i18n";
import { runAnalyze } from "../pipeline/analyze";
import { runJudge } from "../pipeline/judge";
import { enrichAnalysis } from "../pipeline/persist";
import { runRulesFor } from "../pipeline/rules";
import { runVerify } from "../pipeline/verify";
import { playRange, seekTo } from "../preview/playerRef";
import { isSilentDirection, nextShuttle, shuttleLabel } from "../preview/shuttle";
import { defaultProjectFileName } from "../project/format";
import { useDecisions } from "../store/decisions";
import { openDialog, type SettingsFocus } from "../store/dialogs";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import { useUi } from "../store/ui";
import { useVerify } from "../store/verify";
import { formatMs } from "../time";
import { clipboard, copySelection, cutSelectionToClipboard, moveSelectionToPlayhead, pasteAtPlayhead } from "../timeline/clipboard";
import { clearSelection, cutSelection } from "../timeline/selectionActions";
import { bladeAtPlayhead, currentEdl, liftSelection, seamsOfEdl } from "../timeline/trimActions";
import { pickOpenFile, pickSaveFile, toast } from "../ui";

/**
 * App 層的動作：從 App.tsx 的 closure 搬出來的 module 函式。
 * 它們只碰 store / api / toast / t，不需要 React；指令表、快捷鍵、面板、MCP 都直接呼叫。
 */

/** 最近開啟（設定檔，最多 10 筆）。 */
export function rememberRecent(path: string): void {
  const st = useSettings.getState();
  const next = [path, ...st.s.recent_projects.filter((p) => p !== path)].slice(0, 10);
  void st.save({ recent_projects: next });
}

export function isAudioPath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.includes(ext);
}

export async function openMedia(path?: string): Promise<void> {
  try {
    const p = path ?? (await pickOpenFile([{ name: t("音訊"), extensions: AUDIO_EXTENSIONS }]));
    if (!p) return;
    if (p.endsWith(".aicut.json")) {
      await useProject.getState().loadFrom(p);
      rememberRecent(p);
      toast.success(t("已載入專案"));
      return;
    }
    await useProject.getState().openMedia(p);
    rememberRecent(p);
  } catch (e) {
    toast.error(errMessage(e));
  }
}

export async function saveProject(opts?: { as?: boolean }): Promise<void> {
  const st = useProject.getState();
  try {
    let target = opts?.as ? null : st.path;
    if (!target) {
      const name = defaultProjectFileName(selectActiveMedia(st)?.name ?? null);
      target = await pickSaveFile(name, [{ name: t("AI Music Cut 專案"), extensions: ["json"] }]);
      if (!target) return;
    }
    await st.saveTo(target, enrichAnalysis);
    rememberRecent(target);
    toast.success(t("已儲存"));
  } catch (e) {
    toast.error(errMessage(e));
  }
}

export function openSettings(focus: SettingsFocus = null): void {
  openDialog("settings", { focus });
}

/** 所有「分析」入口共用的前置檢查：缺 ffmpeg / 金鑰時不轉檔不上傳，直接帶到該設定欄位。 */
export function analyzeWithPreflight(mediaId?: string): void {
  const id = mediaId ?? useProject.getState().activeMediaId;
  if (!id) return;
  const st = useSettings.getState();
  if (st.ffmpeg && !st.ffmpeg.found) {
    toast.error(t("找不到 ffmpeg，先到設定指定路徑"));
    openSettings("ffmpeg");
    return;
  }
  if (st.key && !st.key.present) {
    toast.info(t("分析需要 ttls 金鑰，先貼上金鑰再開始"));
    openSettings("key");
    return;
  }
  void runAnalyze(id).catch(() => {});
}

export function judgeActive(): void {
  const id = useProject.getState().activeMediaId;
  if (!id) return;
  void runJudge(id).catch((e) => toast.error(errMessage(e)));
}

export function rerunRules(): void {
  const id = useProject.getState().activeMediaId;
  if (id) runRulesFor(id, { label: t("調整激進度"), record: true });
}

export function openRender(range?: { startMs: number; endMs: number } | null): void {
  openDialog("render", { range: range ?? null, reel: null, reelBed: null });
}

/** 開驗收報告：已有報告就直接看，否則對最近一次輸出跑一次。 */
export function openVerify(): void {
  const id = useProject.getState().activeMediaId;
  if (!id) return;
  const v = useVerify.getState();
  const last = v.lastOutput[id] ?? null;
  // durationMs 交給 runVerify 自己去 probe 成品；這裡不再塞「期望長度」進去（那會讓時長檢查失效）
  openDialog("verify", { outPath: last?.path ?? v.byMedia[id]?.outPath ?? null, outDurationMs: null });
  if (!v.byMedia[id] && last) void runVerify(id, { outPath: last.path }).catch(() => {});
}

/** 輸出完成 → 直接跑 ASR 驗收並開報告（人只要聽機器標出來的可疑處）。 */
export function startVerify(outPath: string, durationMs: number | null): void {
  const id = useProject.getState().activeMediaId;
  if (!id) return;
  openDialog("verify", { outPath, outDurationMs: durationMs });
  void runVerify(id, { outPath, outDurationMs: durationMs }).catch(() => {});
}

// ---- 候選導覽 ----

/** 精準修剪器開著時在接縫之間跳；沒開就回 false 讓 [ ] 回到候選導覽。 */
function stepSeam(dir: 1 | -1): boolean {
  const focus = useTimeline.getState().focusSeamMs;
  if (focus == null) return false;
  const seams = seamsOfEdl(currentEdl());
  if (!seams.length) return false;
  let idx = 0;
  let best = Infinity;
  seams.forEach((s, i) => {
    const d = Math.abs(s.srcBeforeMs - focus);
    if (d < best) {
      best = d;
      idx = i;
    }
  });
  const next = seams[Math.max(0, Math.min(seams.length - 1, idx + dir))];
  if (next) {
    useTimeline.getState().setFocusSeam(next.srcBeforeMs);
    seekTo(Math.max(0, next.srcBeforeMs - 300));
  }
  return true;
}

/** 依時間順序選上一個 / 下一個候選並 seek。 */
export function stepCandidate(dir: 1 | -1): void {
  if (stepSeam(dir)) return;
  const id = useProject.getState().activeMediaId;
  if (!id) return;
  const d = useDecisions.getState();
  const list = d.candidates[id] ?? [];
  if (!list.length) return;
  const cur = list.findIndex((c) => d.selectedIds.includes(c.id));
  let next: number;
  if (cur < 0) {
    const now = usePlayback.getState().currentMs;
    next = dir > 0 ? list.findIndex((c) => c.startMs > now) : list.length - 1;
    if (next < 0) next = 0;
  } else next = Math.max(0, Math.min(list.length - 1, cur + dir));
  const c = list[next];
  d.select([c.id]);
  usePlayback.getState().seek(Math.max(0, c.startMs - 300));
  // 捲進視野交給 DecisionPanel：清單虛擬化之後，那一列可能不在 DOM 裡，querySelector 會落空。
}

export function decideSelected(state: "accepted" | "rejected"): void {
  const id = useProject.getState().activeMediaId;
  const d = useDecisions.getState();
  if (!id || !d.selectedIds.length) return;
  d.decide(id, d.selectedIds, state);
}

export function previewSelected(): void {
  const id = useProject.getState().activeMediaId;
  const d = useDecisions.getState();
  if (!id || !d.selectedIds.length) return;
  const c = (d.candidates[id] ?? []).find((x) => x.id === d.selectedIds[0]);
  if (!c) return;
  playRange(c.startMs - 1000, c.endMs + 1000, { skip: isActiveState(d.decisions[id]?.[c.id]?.state) });
}

/** Delete：有時間選取 → 剪掉選取；否則拒絕選取的候選。 */
export function deleteKey(): void {
  if (useTimeline.getState().selection) {
    cutSelection();
    return;
  }
  decideSelected("rejected");
}

// ---- 播放線 / 標記 ----

export function shuttle(key: "J" | "K" | "L", opts: { slow: boolean }): void {
  const pb = usePlayback.getState();
  const next = nextShuttle(pb.shuttle, key, { slow: opts.slow });
  pb.setShuttle(next);
  // 只在「剛進入倒退」時說一次，不然每點一下都跳一個 toast
  if (isSilentDirection(next) && !isSilentDirection(pb.shuttle)) toast.info(t("{label}　倒退只移動播放線，沒有聲音", { label: shuttleLabel(next) }));
}

export function nudge(ms: number): void {
  seekTo(Math.max(0, usePlayback.getState().currentMs + ms));
}

export function markIn(): void {
  const ms = usePlayback.getState().currentMs;
  // 只標了一端要說一聲，否則按了 I 畫面上什麼都沒有，看起來像壞掉
  if (!useTimeline.getState().markIn(ms)) toast.info(t("入點 {at}　再按 O 標出點", { at: formatMs(ms, { millis: true }) }));
}

export function markOut(): void {
  const ms = usePlayback.getState().currentMs;
  if (!useTimeline.getState().markOut(ms)) toast.info(t("出點 {at}　再按 I 標入點", { at: formatMs(ms, { millis: true }) }));
}

export function gotoIn(): void {
  const sel = useTimeline.getState().selection;
  if (sel) seekTo(sel.startMs);
}

export function gotoOut(): void {
  const sel = useTimeline.getState().selection;
  if (sel) seekTo(sel.endMs);
}

export function addMarkerAtPlayhead(kind: "standard" | "chapter" | "todo"): void {
  const id = useProject.getState().activeMediaId;
  if (!id) return;
  const ms = usePlayback.getState().currentMs;
  useDecisions.getState().addMarker(id, ms, kind);
  // 章節與待辦都要取名字才有用，直接把索引分頁叫出來
  if (kind !== "standard") useUi.getState().setTab("index");
  const at = formatMs(ms, { millis: false });
  toast.info(
    kind === "chapter" ? t("下了章節 {at}　到「索引」分頁取名字", { at }) : kind === "todo" ? t("下了待辦 {at}　到「索引」分頁寫要做什麼", { at }) : t("下了標記 {at}", { at }),
  );
}

export function stepMarker(dir: 1 | -1): void {
  const id = useProject.getState().activeMediaId;
  if (!id) return;
  const list = (useDecisions.getState().markers[id] ?? []).slice().sort((a, b) => a.ms - b.ms);
  if (!list.length) return;
  const cur = usePlayback.getState().currentMs;
  const next = dir > 0 ? list.find((m) => m.ms > cur + 5) : [...list].reverse().find((m) => m.ms < cur - 5);
  if (next) seekTo(next.ms);
}

export function stepSpeaker(dir: 1 | -1): void {
  const id = useProject.getState().activeMediaId;
  if (!id) return;
  const st = useDecisions.getState().speakers[id];
  if (!st?.turns.length) {
    toast.info(t("這一集還沒有講者標籤"));
    return;
  }
  const next = nextSpeakerChange(st.turns, usePlayback.getState().currentMs, dir);
  if (next == null) {
    toast.info(dir > 0 ? t("後面沒有換人了") : t("前面沒有換人了"));
    return;
  }
  seekTo(next);
  const who = st.list.find((x) => x.id === speakerAtMs(st.turns, next))?.label;
  if (who) toast.info(t("換到 {who}", { who }));
}

export function bladeToggle(): void {
  const r = bladeAtPlayhead({ toggle: true });
  if (r === null) toast.info(t("這裡切不了：太靠近既有的接縫，或落在已剪掉的區段裡"));
  else toast.info(r ? t("切了一刀") : t("移除切點"));
}

export function toggleSnapWithToast(): void {
  useTimeline.getState().toggleSnap();
  toast.info(useTimeline.getState().snap.enabled ? t("吸附：開") : t("吸附：關"));
}

export function liftWithToast(): void {
  if (!liftSelection()) toast.info(t("先選一段再提起"));
}

export function selectAll(): void {
  const m = selectActiveMedia(useProject.getState());
  if (m?.probe) useTimeline.getState().setSelection({ startMs: 0, endMs: m.probe.duration_ms });
}

export { clearSelection };

// ---- 剪貼簿 ----

export function cutToClipboard(): void {
  if (!cutSelectionToClipboard()) toast.info(t("先在波形上拖一段"));
  else toast.success(t("已剪下（Ctrl+V 貼到播放線）"));
}

export function copyToClipboardAction(): void {
  if (!copySelection()) toast.info(t("先在波形上拖一段"));
  else toast.success(t("已複製（Ctrl+V 貼到播放線）"));
}

export function pasteAtPlayheadAction(): void {
  if (!clipboard()) return toast.info(t("剪貼簿是空的"));
  if (!pasteAtPlayhead()) toast.error(t("貼不上去（剪貼簿是別的音檔，或那一段太短）"));
  else toast.success(t("已貼上"));
}

export function moveToPlayheadAction(): void {
  if (!moveSelectionToPlayhead()) toast.info(t("搬不過去（沒有選取，或播放線就在選取範圍裡）"));
  else toast.success(t("已搬移"));
}

export function openPath(path: string): void {
  void api.openPath(path).catch((e) => toast.error(errMessage(e)));
}
