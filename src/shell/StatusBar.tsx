import { useEffect } from "react";
import { APP_NAME } from "../brand";
import { useT } from "../i18n";
import ModelMenu from "./ModelMenu";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { ffmpegSourceLabel, shortFfmpegVersion } from "../ffmpegSource";
import { useSettings } from "../store/settings";
import { formatMs } from "../time";
import { openSettings } from "../commands/appActions";
import type { UiMode } from "../store/ui";

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${ok ? (warn ? "bg-warning" : "bg-success") : "bg-danger"}`} aria-hidden />;
}

export default function StatusBar({ variant = "pro" }: { variant?: UiMode }) {
  const t = useT();
  const simple = variant === "simple";
  const onOpenSettings = (focus?: "ffmpeg") => openSettings(focus ?? null);
  const ffmpeg = useSettings((s) => s.ffmpeg);
  const probeAll = useSettings((s) => s.probeAll);
  const currentMs = usePlayback((s) => s.currentMs);
  const dirty = useProject((s) => s.dirty);
  const path = useProject((s) => s.path);

  // 視窗聚焦時每 30 秒重探一次（ffmpeg / claude）。
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hasFocus()) void probeAll();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [probeAll]);


  return (
    <div className="h-7 bg-panel border-t border-fg/10 px-3 flex items-center text-xs text-fg/40 gap-4 min-w-0">
      <span className="shrink-0">
        {APP_NAME} v{__APP_VERSION__}
      </span>
      <button
        type="button"
        onClick={() => onOpenSettings("ffmpeg")}
        className="flex items-center gap-1.5 shrink-0 hover:text-fg/70"
        title={ffmpeg?.found ? `ffmpeg ${ffmpeg.version}
${ffmpegSourceLabel(ffmpeg.source)}：${ffmpeg.ffmpeg_path}` : t("找不到 ffmpeg，點擊到設定指定路徑")}
      >
        <Dot ok={!!ffmpeg?.found} />
        {ffmpeg?.found ? `ffmpeg ${shortFfmpegVersion(ffmpeg.version)} · ${ffmpegSourceLabel(ffmpeg.source)}` : t("找不到 ffmpeg")}
      </button>
      {!simple && <ModelMenu onOpenSettings={() => onOpenSettings()} />}
      <span className="mono shrink-0 text-fg/60">{formatMs(currentMs)}</span>
      <span className="ml-auto flex items-center gap-1.5 min-w-0">
        <Dot ok={!dirty} warn={false} />
        <span className="shrink-0">{dirty ? t("未儲存") : t("已儲存")}</span>
        {path && (
          <span className="truncate text-fg/30" title={path}>
            {path}
          </span>
        )}
      </span>
    </div>
  );
}
