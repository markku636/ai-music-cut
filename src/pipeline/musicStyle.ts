// 曲風轉換（ttls /v1/music/style，ACE-Step audio2audio）：
// 把「編輯器裡選取的那一段」切出來當參考，配上目標風格描述，生成同結構但換一種曲風的新曲。
import { api, errKind, errMessage, type MusicJobInfo } from "../api";
import { t } from "../i18n";
import { newJobId, useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { toast } from "../ui";
import { friendlyMusicError, slugify } from "./music";
import { sleep } from "./retry";

export interface StyleTransferOptions {
  mediaId: string;
  /** 參考範圍（來源時間軸）。 */
  startMs: number;
  endMs: number;
  prompt: string;
  /** 0–1，越高越貼近原曲的旋律 / 結構。 */
  coverStrength: number;
  nCandidates: number;
  format: string;
  /** 0 = 跟隨參考長度。 */
  durationSec?: number;
  outDir?: string | null;
  addToProject?: boolean;
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : p;
}

/** 對選取範圍做曲風轉換；回下載下來的檔案路徑。 */
export async function runStyleTransfer(opts: StyleTransferOptions): Promise<string[]> {
  const proj = useProject.getState();
  const media = proj.media.find((m) => m.id === opts.mediaId);
  if (!media) throw new Error(t("找不到媒體"));
  const lenMs = Math.max(0, opts.endMs - opts.startMs);
  if (lenMs < 2000) throw new Error(t("選取太短（至少 2 秒）才有足夠的參考"));
  const settings = useSettings.getState().s;
  const outDir = opts.outDir?.trim() || settings.output_dir?.trim() || dirOf(media.path);

  const jobs = useJobs.getState();
  const jobId = newJobId();
  let serverJobId: string | null = null;
  let canceled = false;
  jobs.upsert({
    id: jobId,
    kind: "music",
    mediaId: opts.mediaId,
    step: t("切出參考片段…"),
    pct: null,
    status: "running",
    message: opts.prompt,
    cancel: () => {
      canceled = true;
      if (serverJobId) void api.ttlsMusicCancel(serverJobId).catch(() => {});
    },
  });
  const step = (label: string, message = "") => jobs.upsert({ id: jobId, step: label, message });

  try {
    const clip = await api.mediaClip(media.path, media.fingerprint, opts.startMs, opts.endMs);
    if (canceled) throw new Error("canceled");

    step(t("上傳參考並送單…"));
    serverJobId = await api.ttlsMusicStyleStart({
      prompt: opts.prompt,
      audio_path: clip,
      cover_strength: opts.coverStrength,
      duration_sec: opts.durationSec ?? 0,
      n_candidates: opts.nCandidates,
      format: opts.format,
      seed: -1,
    });

    const startedAt = Date.now();
    let info: MusicJobInfo;
    for (;;) {
      if (canceled) throw new Error("canceled");
      await sleep(3000);
      info = await api.ttlsMusicPoll(serverJobId);
      const secs = Math.round((Date.now() - startedAt) / 1000);
      if (info.status === "queued") step(t("排隊中"), `${Math.round(info.waiting_sec ?? 0)}s`);
      else if (info.status === "running") step(t("轉換曲風中"), t("已 {s} 秒（{n} 首候選）", { s: secs, n: opts.nCandidates }));
      else if (info.status === "post") step(t("母帶後處理"), `${secs}s`);
      else if (info.status === "done") break;
      else if (info.status === "failed") throw new Error(info.error ?? t("曲風轉換失敗"));
      else if (info.status === "cancelled") throw new Error("canceled");
    }

    step(t("下載"));
    const stem = `${media.name.replace(/\.[^.]+$/, "")}-${slugify(opts.prompt)}`;
    const count = Math.max(1, info.outputs?.length ?? 1);
    const files: string[] = [];
    for (let i = 0; i < count; i++) {
      const ext = info.outputs?.[i]?.audio_format || info.audio_format || opts.format || "mp3";
      const name = count > 1 ? `${stem}-${i + 1}` : stem;
      files.push(await api.ttlsMusicFetch(serverJobId, i, outDir, name, ext));
    }

    if (opts.addToProject !== false) {
      let first: string | null = null;
      for (const f of files) {
        const id = await useProject.getState().openMedia(f).catch(() => null);
        if (id && !first) first = id;
      }
      if (first) useProject.getState().setActive(first);
    }
    jobs.upsert({ id: jobId, status: "done", step: t("完成"), pct: 100, message: files.join(" · "), endedAt: Date.now() });
    toast.success(t("曲風轉換完成：{n} 首", { n: files.length }));
    return files;
  } catch (e) {
    const msg = errMessage(e);
    if (canceled || msg === "canceled" || errKind(e) === "canceled") {
      jobs.upsert({ id: jobId, status: "canceled", step: t("已取消"), endedAt: Date.now() });
      throw e;
    }
    const friendly = friendlyMusicError(msg);
    jobs.upsert({ id: jobId, status: "error", step: t("失敗"), error: friendly, endedAt: Date.now() });
    if (errKind(e) === "auth") toast.error(t("ttls 金鑰缺少或錯誤，請到設定輸入"));
    else toast.error(friendly);
    throw e;
  }
}
