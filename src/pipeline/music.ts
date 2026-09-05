// AI 配樂（ttls /v1/music，ACE-Step）：送單 → 輪詢 → 下載候選 → 直接加進媒體清單，
// 生出來的曲子就能用同一套剪輯 / 節拍 / 驗收流程處理。
import { api, errKind, errMessage, type MusicJobInfo, type MusicOpts } from "../api";
import { t } from "../i18n";
import { newJobId, useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { toast } from "../ui";
import { sleep } from "./retry";

export interface GenerateMusicOptions extends MusicOpts {
  /** 寫到哪個資料夾（空 = 設定的輸出資料夾 → 目前媒體同資料夾）。 */
  outDir?: string | null;
  /** 完成後把候選加進媒體清單並切過去。 */
  addToProject?: boolean;
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : p;
}

/** prompt → 檔名用的短 slug（英數與 -，最多 40 字）。 */
export function slugify(prompt: string): string {
  const s = prompt
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "bgm";
}

/** 生成音樂；回寫下來的檔案路徑。 */
export async function runGenerateMusic(opts: GenerateMusicOptions): Promise<string[]> {
  const proj = useProject.getState();
  const active = proj.media.find((m) => m.id === proj.activeMediaId) ?? null;
  const settings = useSettings.getState().s;
  const outDir = opts.outDir?.trim() || settings.output_dir?.trim() || (active ? dirOf(active.path) : "");
  if (!outDir) throw new Error(t("請先選一個輸出資料夾（設定 → 輸出）"));

  const jobs = useJobs.getState();
  const jobId = newJobId();
  let serverJobId: string | null = null;
  let canceled = false;
  jobs.upsert({
    id: jobId,
    kind: "music",
    mediaId: active?.id ?? "",
    step: t("送單給 ACE-Step…"),
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
    serverJobId = await api.ttlsMusicStart(opts);
    const startedAt = Date.now();
    let info: MusicJobInfo;
    for (;;) {
      if (canceled) throw new Error("canceled");
      await sleep(3000);
      info = await api.ttlsMusicPoll(serverJobId);
      const secs = Math.round((Date.now() - startedAt) / 1000);
      if (info.status === "queued") step(t("排隊中"), `${Math.round(info.waiting_sec ?? 0)}s`);
      else if (info.status === "running") step(t("生成中"), t("已 {s} 秒（{n} 首候選）", { s: secs, n: opts.n_candidates }));
      else if (info.status === "post") step(t("母帶後處理"), `${secs}s`);
      else if (info.status === "done") break;
      else if (info.status === "failed") throw new Error(info.error ?? t("音樂生成失敗"));
      else if (info.status === "cancelled") throw new Error("canceled");
    }

    step(t("下載"));
    const stem = slugify(opts.prompt);
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
    toast.success(t("配樂完成：{n} 首", { n: files.length }));
    return files;
  } catch (e) {
    const msg = errMessage(e);
    if (canceled || msg === "canceled" || errKind(e) === "canceled") {
      jobs.upsert({ id: jobId, status: "canceled", step: t("已取消"), endedAt: Date.now() });
      throw e;
    }
    jobs.upsert({ id: jobId, status: "error", step: t("失敗"), error: msg, endedAt: Date.now() });
    if (errKind(e) === "auth") toast.error(t("ttls 金鑰缺少或錯誤，請到設定輸入"));
    else toast.error(msg);
    throw e;
  }
}
