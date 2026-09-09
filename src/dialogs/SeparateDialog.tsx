import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Download, MicOff } from "lucide-react";
import { api, errMessage, type LocalSeparateEvent, type LocalSeparateStatus } from "../api";
import { Button, Field, Modal, Segmented, Spinner } from "../ui/index";
import { copyToClipboard, pickDirectory } from "../ui";
import { useT } from "../i18n";
import { runSeparate, type SeparateStems } from "../pipeline/separate";
import { useProject } from "../store/project";

/**
 * 去人聲 / 分軌對話框：選 2 軌（人聲 + 伴奏）或 4 軌、資料夾；跑**本機** demucs。
 * 完成後預設把各軌加進媒體清單並切到伴奏軌，接著就能用同一套剪輯 / 輸出流程處理去人聲版本。
 *
 * demucs 會把 torch 一起帶進來（幾百 MB），所以跟本機辨識一樣**不自動安裝**：
 * 沒裝的時候這裡直接給指令與一顆安裝鈕，按之前先讓人看到實際會執行什麼。
 * 輸出格式固定 wav（demucs 就是寫 wav）；要別的格式用工具列的「轉檔」。
 */
export default function SeparateDialog({ mediaId, onClose }: { mediaId: string; onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media.find((m) => m.id === mediaId) ?? null);
  const [stems, setStems] = useState<SeparateStems>("vocals_accom");
  const [outDir, setOutDir] = useState<string | null>(null);
  const [addToProject, setAddToProject] = useState(true);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [st, setSt] = useState<LocalSeparateStatus | null>(null);

  const probe = async () => setSt(await api.localSeparateDetect().catch(() => null));
  useEffect(() => {
    void probe();
  }, []);

  const ready = !!st?.python && !!st?.demucs;
  const minutes = media?.probe ? Math.max(1, Math.round(media.probe.duration_ms / 60000)) : 1;

  const install = async () => {
    const jobId = `demucs-install-${mediaId}`;
    setInstalling(true);
    setLog([]);
    const un = await listen<LocalSeparateEvent>("local-separate", (ev) => {
      const p = ev.payload;
      if (p.job_id !== jobId || !p.message) return;
      // pip 裝 torch 會吐很長一串，只留最後 200 行免得面板被拖慢
      setLog((l) => [...l, p.message!].slice(-200));
    });
    try {
      const ok = await api.localSeparateInstall(jobId);
      if (!ok) setError(t("安裝沒有成功，看下面的輸出找原因"));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      un();
      setInstalling(false);
      await probe();
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await runSeparate(mediaId, { stems, outDir, addToProject });
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
      onClose={busy || installing ? () => {} : onClose}
      title={t("去人聲 / 分軌")}
      icon={MicOff}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy || installing}>
            {t("取消")}
          </Button>
          <Button variant="primary" onClick={() => void start()} loading={busy} disabled={busy || installing || !ready || !media}>
            {t("開始分離")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-xs text-fg/55 leading-relaxed">
          {t("用你電腦上的 demucs（htdemucs）把「{name}」分成人聲與伴奏；伴奏軌就是去人聲版本。不上傳、不需要金鑰。{m} 分鐘的音檔在 CPU 上大約要幾分鐘，有顯示卡會快很多；期間可在工作列取消。", {
            name: media?.name ?? "",
            m: minutes,
          })}
        </p>

        {st && !ready && (
          <div className="rounded-md border border-fg/10 px-3 py-2 space-y-2 text-[11px]">
            <div className="text-warning">
              {!st.python ? t("找不到 python：先安裝 Python 3.9 以上並確認它在 PATH 上。") : t("還沒安裝 demucs（會連 torch 一起裝，幾百 MB）。")}
            </div>
            {st.python && (
              <div className="flex items-center gap-1">
                <code className="min-w-0 flex-1 truncate rounded bg-inset px-2 py-1 font-mono text-[11px] select-all" title={st.install_hint}>
                  {st.install_hint}
                </code>
                <Button size="sm" variant="ghost" onClick={() => void copyToClipboard(st.install_hint, t("已複製"))}>
                  {t("複製")}
                </Button>
                <Button size="sm" variant="primary" icon={Download} loading={installing} disabled={installing} onClick={() => void install()}>
                  {t("開始安裝")}
                </Button>
              </div>
            )}
            {log.length > 0 && (
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-inset px-2 py-1 font-mono text-[10px] leading-4 text-fg/60">
                {log.join("\n")}
              </pre>
            )}
          </div>
        )}

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
            {t("本機分離中…（進度在工作列）")}
          </div>
        )}
        {error && <div className="text-xs text-danger break-all">{error}</div>}
      </div>
    </Modal>
  );
}
