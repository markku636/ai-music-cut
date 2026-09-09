// 去人聲 / 分軌：本機 demucs（htdemucs）把音檔拆成人聲與伴奏（或四軌），
// 檔案寫在來源旁邊，並（選用）加進媒體清單。
//
// 全程在這台機器上跑：不上傳、不需要金鑰。第一次會下載模型（幾百 MB），之後就都在本機。
// demucs 寫出來的是 wav；要別的格式用工具列的「轉檔」，不在這裡多做一層轉換
// —— 分離本身就已經是最慢的一步，再串一次 ffmpeg 只是讓失敗點變多。
import { listen } from "@tauri-apps/api/event";
import { api, errKind, errMessage, type LocalSeparateEvent, type SeparateStem } from "../api";
import { t } from "../i18n";
import { newJobId, useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { toast } from "../ui";

export type SeparateStems = "vocals_accom" | "all";

export interface SeparateOptions {
  stems: SeparateStems;
  /** null = 與來源同資料夾。 */
  outDir: string | null;
  /** 完成後把各軌加進媒體清單，並切到伴奏（去人聲）那一軌。 */
  addToProject: boolean;
}

export async function runSeparate(mediaId: string, opts: SeparateOptions): Promise<SeparateStem[]> {
  const media = useProject.getState().media.find((m) => m.id === mediaId);
  if (!media) throw new Error(t("找不到媒體"));
  const jobs = useJobs.getState();
  const jobId = newJobId();
  jobs.upsert({
    id: jobId,
    kind: "separate",
    mediaId,
    step: t("本機分離人聲（demucs）…"),
    pct: 0,
    status: "running",
    message: media.name,
    cancel: () => void api.mediaCancel(jobId).catch(() => {}),
  });

  // demucs 把進度印在 stderr，Rust 端轉成事件；沒有進度的行當成步驟文字
  const un = await listen<LocalSeparateEvent>("local-separate", (ev) => {
    const p = ev.payload;
    if (p.job_id !== jobId) return;
    if (p.event === "progress" && p.pct != null) jobs.upsert({ id: jobId, pct: p.pct });
    else if (p.event === "status" && p.message) jobs.upsert({ id: jobId, message: p.message });
  });

  try {
    const stems = await api.localSeparateRun(jobId, media.path, opts.stems === "all" ? "4" : "2", opts.outDir);
    jobs.upsert({ id: jobId, status: "done", step: t("完成"), pct: 100, message: stems.map((s) => s.label).join(" · "), endedAt: Date.now() });
    if (opts.addToProject) {
      const proj = useProject.getState();
      let focus: string | null = null;
      for (const s of stems) {
        const id = await proj.openMedia(s.path).catch(() => null);
        // demucs 的伴奏軌叫 no_vocals（不是 accompaniment）—— 名字對錯會讓它切到人聲軌
        if (id && (s.name === "no_vocals" || (!focus && s.name !== "vocals"))) focus = id;
      }
      if (focus) useProject.getState().setActive(focus);
    }
    toast.success(t("已分離 {n} 軌，存在 {dir}", { n: stems.length, dir: dirOf(stems[0]?.path ?? media.path) }));
    return stems;
  } catch (e) {
    if (errKind(e) === "canceled") {
      jobs.upsert({ id: jobId, status: "canceled", step: t("已取消"), endedAt: Date.now() });
      throw e;
    }
    const msg = errMessage(e);
    jobs.upsert({ id: jobId, status: "error", step: t("失敗"), error: msg, endedAt: Date.now() });
    toast.error(msg);
    throw e;
  } finally {
    un();
  }
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : p;
}
