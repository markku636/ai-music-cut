import { useEffect, useState } from "react";
import { BookOpen, Bug, Copy, ExternalLink, FileText, Heart, Info, RefreshCw } from "lucide-react";
import { api } from "../api";
import { APP_NAME, REPO_URL, TOOL_PAGE_URL } from "../brand";
import { DONATE_TIERS, PAYPAL_ME_URL } from "../donate";
import { Button, Modal } from "../ui/index";
import Icon from "../ui/Icon";
import { copyToClipboard } from "../ui";
import { useT } from "../i18n";
import { useSettings } from "../store/settings";
import { checkForUpdate, isNewer, REPO, type UpdateInfo } from "../updateCheck";

/**
 * 關於。版面與更新檢查的作法移植自 db-kit（同一位作者的另一個 Tauri 工具）——
 * 那邊已經磨過一輪：版本旁邊要有複製鈕（回報問題時附上）、更新檢查要能手動觸發、
 * 連結一律用系統瀏覽器開、檔案位置收起來不要一開場就佔版面。
 */

type CheckState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "update"; info: UpdateInfo }
  | { phase: "latest" }
  | { phase: "failed" };

export default function AboutDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const paths = useSettings((s) => s.paths);
  const [check, setCheck] = useState<CheckState>({ phase: "idle" });
  const [showPaths, setShowPaths] = useState(false);

  // 開啟時先看快取（每天最多打一次 API）；失敗一律安靜略過，不擋開啟
  useEffect(() => {
    let alive = true;
    void checkForUpdate().then((info) => {
      if (!alive || !info) return;
      setCheck(isNewer(info.version, __APP_VERSION__) ? { phase: "update", info } : { phase: "latest" });
    });
    return () => {
      alive = false;
    };
  }, []);

  const runCheck = async () => {
    setCheck({ phase: "checking" });
    const info = await checkForUpdate({ force: true });
    if (!info) return setCheck({ phase: "failed" });
    setCheck(isNewer(info.version, __APP_VERSION__) ? { phase: "update", info } : { phase: "latest" });
  };

  const open = (url: string) => void api.openExternal(url).catch(() => {});
  const links: { icon: typeof ExternalLink; label: string; url: string }[] = [
    { icon: ExternalLink, label: t("GitHub 專案"), url: REPO_URL },
    { icon: BookOpen, label: t("作者部落格"), url: TOOL_PAGE_URL },
    { icon: FileText, label: t("變更紀錄"), url: `https://github.com/${REPO}/blob/main/CHANGELOG.md` },
    { icon: Bug, label: t("回報問題"), url: `https://github.com/${REPO}/issues/new` },
  ];

  return (
    <Modal open onClose={onClose} title={t("關於 {app}").replace("{app}", APP_NAME)} icon={Info} size="sm">
      <div className="flex flex-col items-center text-center gap-1 py-2">
        <img src="/app-icon.png" alt={APP_NAME} className="w-28 h-28 mb-1" draggable={false} />
        <div className="text-lg font-semibold">{APP_NAME}</div>
        <div className="flex items-center gap-1 text-xs text-fg/40 tabular-nums">
          <span>
            {t("版本")} {__APP_VERSION__}
          </span>
          <button
            type="button"
            onClick={() => void copyToClipboard(`${APP_NAME} v${__APP_VERSION__}`, t("已複製版本資訊"))}
            title={t("複製版本資訊（回報問題時附上）")}
            className="w-5 h-5 grid place-items-center rounded text-fg/40 hover:text-fg hover:bg-fg/10"
          >
            <Icon icon={Copy} size={12} />
          </button>
        </div>
        <p className="text-sm text-fg/60 mt-1 leading-relaxed">
          {t("AI Podcast 智慧剪輯：剪贅字與口吃（以自然順暢為原則）、修聲、音量平衡、章節與節目筆記；含糊段落只給建議由你決定。")}
        </p>

        <div className="mt-3 flex flex-col items-center gap-2 min-h-[52px]">
          {check.phase === "update" && (
            <button
              type="button"
              // 導到部落格的工具頁，不是 GitHub Release ——
              // 那一頁有安裝說明與截圖，Release 頁對非工程師只是一串檔名。
              onClick={() => open(TOOL_PAGE_URL)}
              className="text-sm font-medium text-accent hover:underline inline-flex items-center gap-1.5"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-accent" aria-hidden />
              {t("有新版 v{version}，點擊前往下載").replace("{version}", check.info.version)}
            </button>
          )}
          {check.phase === "latest" && <div className="text-sm text-success">{t("已是最新版本")}</div>}
          {check.phase === "failed" && <div className="text-sm text-fg/50">{t("檢查失敗（離線或已達 GitHub API 上限），稍後再試")}</div>}
          <Button icon={RefreshCw} loading={check.phase === "checking"} onClick={() => void runCheck()}>
            {check.phase === "checking" ? t("檢查中…") : t("檢查更新")}
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap justify-center items-center gap-1">
          {links.map((l) => (
            <button
              key={l.label}
              type="button"
              onClick={() => open(l.url)}
              className="inline-flex items-center gap-1.5 text-[13px] text-fg/60 hover:text-fg hover:bg-fg/5 rounded px-2 py-1"
            >
              <Icon icon={l.icon} size={13} />
              {l.label}
            </button>
          ))}
        </div>

        {paths && (
          <div className="mt-2 w-full">
            <button type="button" onClick={() => setShowPaths((v) => !v)} className="text-[11px] text-fg/40 hover:text-fg/70">
              {showPaths ? t("隱藏檔案位置") : t("檔案位置")}
            </button>
            {showPaths && (
              <div className="mt-1 space-y-0.5 text-left text-[11px]">
                <button type="button" className="block w-full text-left text-fg/50 hover:text-accent break-all" onClick={() => void api.openPath(paths.config_dir)}>
                  {t("設定")}：{paths.config_dir}
                </button>
                <button type="button" className="block w-full text-left text-fg/50 hover:text-accent break-all" onClick={() => void api.openPath(paths.cache_dir)}>
                  {t("快取")}：{paths.cache_dir}
                </button>
              </div>
            )}
          </div>
        )}

        {/*
          贊助。排在連結列與檔案位置之後、授權行之前 —— 打開「關於」的人多半是為了
          查版本或找回報入口，那些事辦完了才輪得到「這東西幫了我」。
          四個固定金額直接是四顆按鈕（見 donate.ts：不寫「隨意」）。
        */}
        <div className="mt-4 w-full border-t border-fg/10 pt-3">
          <div className="text-[13px] text-fg/60">{t("這個工具免費且開源。如果它幫你省下時間，可以請我喝杯咖啡。")}</div>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
            {DONATE_TIERS.map((tier) => (
              <button
                type="button"
                key={tier.usd}
                onClick={() => open(tier.url)}
                title={t("以 PayPal 贊助 US${usd}").replace("{usd}", String(tier.usd))}
                className="inline-flex items-center gap-1 rounded border border-fg/15 px-2.5 py-1 text-[13px] tabular-nums text-fg/70 hover:border-accent/40 hover:text-accent hover:bg-accent/5"
              >
                <Icon icon={Heart} size={12} />${tier.usd}
              </button>
            ))}
            <button
              type="button"
              onClick={() => open(PAYPAL_ME_URL)}
              className="rounded px-2 py-1 text-[13px] text-fg/50 hover:text-fg hover:bg-fg/5"
            >
              {t("其他金額")}
            </button>
          </div>
        </div>

        <div className="mt-3 text-[11px] text-fg/35">{t("MIT 授權 · Tauri + React 打造")}</div>
      </div>
    </Modal>
  );
}
