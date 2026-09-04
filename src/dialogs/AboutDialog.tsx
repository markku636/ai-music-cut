import { Info } from "lucide-react";
import { api } from "../api";
import { APP_NAME, REPO_URL } from "../brand";
import { Button, Modal } from "../ui/index";
import { useT } from "../i18n";
import { useSettings } from "../store/settings";

export default function AboutDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const paths = useSettings((s) => s.paths);
  return (
    <Modal open onClose={onClose} title={t("關於")} icon={Info} size="sm" footer={<Button variant="primary" onClick={onClose}>{t("關閉")}</Button>}>
      <div className="space-y-3 text-sm">
        <div>
          <div className="text-lg font-semibold">{APP_NAME}</div>
          <div className="text-fg/50 text-xs">v{__APP_VERSION__} · MIT</div>
        </div>
        <p className="text-fg/70 leading-relaxed">
          {t("AI Podcast 自動粗剪：剪贅字口吃（以自然順暢為原則）、音量平衡、含糊段落給建議由你決定；AI 助手以工具直接操作剪輯決策。")}
        </p>
        <div className="text-xs text-fg/60 space-y-1">
          <div>
            GitHub：
            <button type="button" className="text-accent hover:underline" onClick={() => void api.openExternal(REPO_URL)}>
              {REPO_URL}
            </button>
          </div>
          {paths && (
            <>
              <div>
                {t("設定")}：
                <button type="button" className="text-accent hover:underline break-all" onClick={() => void api.openPath(paths.config_dir)}>
                  {paths.config_dir}
                </button>
              </div>
              <div>
                {t("快取")}：
                <button type="button" className="text-accent hover:underline break-all" onClick={() => void api.openPath(paths.cache_dir)}>
                  {paths.cache_dir}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
