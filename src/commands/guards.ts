import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import { useUi } from "../store/ui";
import { OK, bumpCommandTick } from "./registry";
import type { Enabled } from "./types";

/**
 * 指令的守門（enabled）：讀 store 的 getState()。
 * 這裡的字串是 zh key，會直接顯示在 tooltip 與 toast 上 —— 每一句都要進 locales。
 */

export function activeId(): string | null {
  return useProject.getState().activeMediaId;
}

export function needsMedia(): Enabled {
  return activeId() ? OK : { ok: false, why: "先開啟一個音檔" };
}

export function needsAnalysis(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  const st = useProject.getState();
  const media = st.media.find((x) => x.id === st.activeMediaId);
  return media?.analysis === "ready" ? OK : { ok: false, why: "先完成分析" };
}

export function needsNotAnalyzing(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  const st = useProject.getState();
  const media = st.media.find((x) => x.id === st.activeMediaId);
  return media?.analysis === "analyzing" ? { ok: false, why: "分析進行中" } : OK;
}

export function needsSelection(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  return useTimeline.getState().selection ? OK : { ok: false, why: "先在波形上選一段" };
}

export function needsTwoMedia(): Enabled {
  return useProject.getState().media.length >= 2 ? OK : { ok: false, why: "媒體清單裡要有兩個以上的檔案" };
}

export function needsAnyMedia(): Enabled {
  return useProject.getState().media.length > 0 ? OK : { ok: false, why: "媒體清單裡要有檔案" };
}

export function needsSelectedCandidate(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  return useDecisions.getState().selectedIds.length ? OK : { ok: false, why: "先在決策清單裡選一筆" };
}

export function needsHistory(dir: "undo" | "redo"): Enabled {
  const d = useDecisions.getState();
  const n = dir === "undo" ? d.past.length : d.future.length;
  return n ? OK : { ok: false, why: dir === "undo" ? "還沒有可以復原的動作" : "沒有可以重做的動作" };
}

export function needsClaude(): Enabled {
  const c = useSettings.getState().claude;
  return c && !c.installed ? { ok: false, why: "需要安裝並登入 Claude Code CLI" } : OK;
}

/** enabled() 讀的東西一變就 bump；只挑會影響「能不能做」的欄位，播放線不算。 */
let installed = false;
export function installCommandReactivity(): () => void {
  if (installed) return () => {};
  installed = true;
  const uns = [
    useProject.subscribe((s, p) => {
      if (s.activeMediaId !== p.activeMediaId || s.media !== p.media || s.dirty !== p.dirty || s.path !== p.path) bumpCommandTick();
    }),
    useDecisions.subscribe((s, p) => {
      if (s.candidates !== p.candidates || s.decisions !== p.decisions || s.effects !== p.effects || s.selectedIds !== p.selectedIds || s.past !== p.past || s.future !== p.future || s.reviewing !== p.reviewing)
        bumpCommandTick();
    }),
    useTimeline.subscribe((s, p) => {
      if (s.selection !== p.selection || s.tool !== p.tool || s.snap !== p.snap || s.skim !== p.skim || s.showBeats !== p.showBeats || s.beatGrid !== p.beatGrid || s.loopSelection !== p.loopSelection || s.showLoudness !== p.showLoudness)
        bumpCommandTick();
    }),
    useSettings.subscribe((s, p) => {
      if (s.ffmpeg !== p.ffmpeg || s.claude !== p.claude || s.s !== p.s) bumpCommandTick();
    }),
    useUi.subscribe((s, p) => {
      if (s.tab !== p.tab || s.railOpen !== p.railOpen || s.density !== p.density) bumpCommandTick();
    }),
  ];
  return () => {
    installed = false;
    for (const u of uns) u();
  };
}
