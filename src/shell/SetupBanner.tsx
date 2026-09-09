import { useState } from "react";
import { AlertTriangle, Bot } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "../ui/index";
import Icon from "../ui/Icon";
import { useT } from "../i18n";
import { selectActiveMedia, useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { openSettings } from "../commands/appActions";

type Tone = "danger" | "warning" | "info";

const TONE: Record<Tone, string> = {
  danger: "bg-danger/10 text-danger border-danger/20",
  warning: "bg-warning/10 text-warning border-warning/20",
  info: "bg-info/10 text-info border-info/20",
};

function readFlag(storage: Storage | null, key: string): boolean {
  try {
    return storage?.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeFlag(storage: Storage | null, key: string) {
  try {
    storage?.setItem(key, "1");
  } catch {
    /* ignore */
  }
}

/**
 * 設定問題「在咬到人的地方」說清楚：同時只顯示一條，優先序 ffmpeg → ttls 離線 → 無金鑰 → 無 claude。
 * 無金鑰那條在有媒體且尚未分析時自動收起（WorkflowStrip 的第 ② 步已顯示同一個 CTA，不疊兩條）。
 */
export default function SetupBanner() {
  const t = useT();
  const onOpenSettings = (focus?: "ffmpeg") => openSettings(focus ?? null);
  const loaded = useSettings((s) => s.loaded);
  const ffmpeg = useSettings((s) => s.ffmpeg);
  const claude = useSettings((s) => s.claude);
  const active = useProject(selectActiveMedia);
  const [, bump] = useState(0);
  const rerender = () => bump((n) => n + 1);

  if (!loaded) return null;

  let tone: Tone;
  let icon: LucideIcon;
  let text: string;
  let action: React.ReactNode;

  if (ffmpeg && !ffmpeg.found) {
    tone = "danger";
    icon = AlertTriangle;
    text = t("找不到 ffmpeg：無法讀取音檔、計算波形或輸出。");
    action = (
      <Button size="sm" variant="primary" onClick={() => onOpenSettings("ffmpeg")}>
        {t("指定 ffmpeg 路徑")}
      </Button>
    );
  } else if (claude && !claude.installed && active?.analysis === "ready") {
    if (readFlag(typeof localStorage !== "undefined" ? localStorage : null, "aicut:banner.claude")) return null;
    tone = "info";
    icon = Bot;
    text = t("未安裝 Claude Code CLI：規則層的候選仍可用；裝好並登入後才有 AI 判讀與 AI 助手。");
    action = (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          writeFlag(localStorage, "aicut:banner.claude");
          rerender();
        }}
      >
        {t("知道了")}
      </Button>
    );
  } else return null;

  return (
    <div role="status" className={`shrink-0 px-3 py-1.5 text-xs flex items-center gap-3 border-b ${TONE[tone]}`}>
      <Icon icon={icon} size={14} />
      <span className="flex-1 min-w-0 truncate" title={text}>
        {text}
      </span>
      <span className="flex items-center gap-1 shrink-0">{action}</span>
    </div>
  );
}
