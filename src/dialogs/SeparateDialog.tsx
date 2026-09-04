import { useState } from "react";
import { MicOff } from "lucide-react";
import { errMessage } from "../api";
import { Button, Field, Modal, Segmented, Select, Spinner } from "../ui/index";
import { pickDirectory } from "../ui";
import { useT } from "../i18n";
import { runSeparate, type SeparateFormat, type SeparateStems } from "../pipeline/separate";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";

/**
 * 去人聲 / 分軌對話框：選 2 軌（人聲 + 伴奏）或 4 軌、輸出格式、資料夾；跑 ttls demucs。
 * 完成後預設把各軌加進媒體清單並切到伴奏軌，接著就能用同一套剪輯 / 輸出流程處理去人聲版本。
 */
export default function SeparateDialog({ mediaId, onClose }: { mediaId: string; onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media.find((m) => m.id === mediaId) ?? null);
  const ttls = useSettings((s) => s.ttls);
  const key = useSettings((s) => s.key);
  const [stems, setStems] = useState<SeparateStems>("vocals_accom");
  const [format, setFormat] = useState<SeparateFormat>("wav");
  const [outDir, setOutDir] = useState<string | null>(null);
  const [addToProject, setAddToProject] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = !ttls?.ok || (key !== null && !key.present);
  const minutes = media?.probe ? Math.max(1, Math.round(media.probe.duration_ms / 60000)) : 1;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await runSeparate(mediaId, { stems, format, outDir, addToProject });
      onClose();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t("去人聲 / 分軌")}
      icon={MicOff}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("取消")}
          </Button>
          <Button variant="primary" onClick={() => void start()} loading={busy} disabled={busy || blocked || !media}>
            {t("開始分離")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-xs text-fg/55 leading-relaxed">
          {t("用 ttls 上的 demucs（htdemucs）把「{name}」分成人聲與伴奏；伴奏軌就是去人聲版本。約需 {m} 分鐘音檔 × 10–20 秒，期間可在工作列取消。", {
            name: media?.name ?? "",
            m: minutes,
          })}
        </p>
        {blocked && <div className="text-xs text-warning">{!ttls?.ok ? t("ttls 伺服器離線，無法分離") : t("需要 ttls 金鑰（設定 → 伺服器）")}</div>}
        <Field label={t("分軌")}>
          <Segmented<SeparateStems>
            full
            value={stems}
            onChange={setStems}
            options={[
              { value: "vocals_accom", label: t("人聲 + 伴奏（2 軌）") },
              { value: "all", label: t("人聲 / 鼓 / 貝斯 / 其他（4 軌）") },
            ]}
          />
        </Field>
        <Field label={t("輸出格式")} hint={t("wav 無損最適合再剪輯；mp3 較小")}>
          <Select value={format} onChange={(e) => setFormat(e.target.value as SeparateFormat)} disabled={busy}>
            <option value="wav">wav（44.1k, 16-bit）</option>
            <option value="flac">flac</option>
            <option value="mp3">mp3</option>
          </Select>
        </Field>
        <Field label={t("存到")} hint={outDir ?? t("與來源同資料夾")}>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                const d = await pickDirectory();
                if (d) setOutDir(d);
              }}
            >
              {t("選擇資料夾")}
            </Button>
            {outDir && (
              <Button variant="ghost" disabled={busy} onClick={() => setOutDir(null)}>
                {t("清除")}
              </Button>
            )}
          </div>
        </Field>
        <label className="flex items-center gap-2 text-xs text-fg/70">
          <input type="checkbox" checked={addToProject} onChange={(e) => setAddToProject(e.target.checked)} disabled={busy} />
          {t("完成後加進媒體清單並切換到伴奏（去人聲）軌")}
        </label>
        {busy && (
          <div className="flex items-center gap-2 text-xs text-fg/60">
            <Spinner size={14} className="text-accent" />
            {t("上傳並分離中…（伺服器同步處理，沒有百分比）")}
          </div>
        )}
        {error && <div className="text-xs text-danger break-all">{error}</div>}
      </div>
    </Modal>
  );
}
