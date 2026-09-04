// 去人聲 / 分軌：上傳原檔到 ttls `POST /v1/separate`（demucs htdemucs），把回來的各軌寫在來源旁邊，
// 並（選用）加進媒體清單。同步端點、無進度百分比；長音檔可能要幾分鐘（工作列可取消 = 放棄等待）。
import { api, errKind, errMessage, type SeparateStem } from "../api";
import { t } from "../i18n";
import { newJobId, useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { toast } from "../ui";

export type SeparateStems = "vocals_accom" | "all";
export type SeparateFormat = "wav" | "mp3" | "flac";

export interface SeparateOptions {
  stems: SeparateStems;
  format: SeparateFormat;
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
    step: t("上傳並分離人聲（demucs）…"),
    pct: null,
    status: "running",
    message: media.name,
    cancel: () => void api.mediaCancel(jobId).catch(() => {}),
  });
  try {
    const stems = await api.ttlsSeparate(jobId, media.path, opts.stems, opts.format, opts.outDir);
    jobs.upsert({ id: jobId, status: "done", step: t("完成"), pct: 100, message: stems.map((s) => s.label).join(" · "), endedAt: Date.now() });
    if (opts.addToProject) {
      const proj = useProject.getState();
      let focus: string | null = null;
      for (const s of stems) {
        const id = await proj.openMedia(s.path).catch(() => null);
        if (id && (s.name === "accompaniment" || (!focus && s.name !== "vocals"))) focus = id;
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
    if (errKind(e) === "auth") toast.error(t("ttls 金鑰缺少或錯誤，請到設定輸入"));
    else toast.error(msg);
    throw e;
  }
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : p;
}
