import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Download, RefreshCw } from "lucide-react";
import { api, errMessage, type LocalAsrInstallEvent, type LocalAsrStatus } from "../api";
import { Button, Select } from "../ui/index";
import { copyToClipboard, toast } from "../ui";
import { useT } from "../i18n";

/**
 * 本機辨識的安裝面板。
 *
 * 之前這裡只給一行 `pip install faster-whisper` 加一顆複製鈕 —— 對會用終端機的人夠了，
 * 對其他人等於「你自己想辦法」。現在是**選好再按**：
 *
 * - **選什麼是這裡決定的，Rust 只負責執行**。把「要裝什麼模型」寫死在後端，
 *   換一個模型就得重新發一版。
 * - **順便把模型抓下來**。不先抓的話，第一次分析時才下載 —— 那時候使用者正等著看
 *   結果，卻卡在一個沒有進度的下載上。
 * - **按之前先給人看實際會執行的指令**。這一步會動到使用者的 Python 環境，
 *   不講清楚就按下去是不對的。
 * - **輸出逐行顯示**。這一步要抓幾百 MB，只給一顆轉圈的話，使用者分不出是在下載還是掛了。
 */
export default function LocalAsrSetup() {
  const t = useT();
  const [st, setSt] = useState<LocalAsrStatus | null>(null);
  const [models, setModels] = useState<[string, string][]>([]);
  const [model, setModel] = useState("large-v3");
  const [withModel, setWithModel] = useState(true);
  const [cmd, setCmd] = useState<string[]>([]);
  const [probing, setProbing] = useState(false);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  const probe = async () => {
    setProbing(true);
    try {
      setSt(await api.localAsrDetect());
    } catch {
      setSt(null);
    } finally {
      setProbing(false);
    }
  };

  useEffect(() => {
    void probe();
    void api.localAsrModels().then(setModels).catch(() => {});
    void api.localAsrInstallCommand().then(setCmd).catch(() => {});
  }, []);

  // 新的一行永遠看得到，否則使用者要一直自己往下捲
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const install = async () => {
    const jobId = `asr-install-${Date.now()}`;
    setRunning(true);
    setLog([]);
    setStep("package");
    const un = await listen<LocalAsrInstallEvent>("local-asr-install", (ev) => {
      const p = ev.payload;
      if (p.job_id !== jobId) return;
      if (p.kind === "step") setStep(p.step ?? null);
      // 只留最後 400 行：pip 裝依賴時會吐很長一串，全部留著會把面板拖慢
      else if (p.kind === "line" && p.line != null) setLog((l) => [...l, p.line!].slice(-400));
    });
    try {
      const ok = await api.localAsrInstall(jobId, true, withModel ? model : null);
      if (ok) toast.success(t("安裝完成"));
      else toast.error(t("安裝沒有成功，看下面的輸出找原因"));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      un();
      setRunning(false);
      setStep(null);
      await probe();
    }
  };

  const ready = !!st?.python && !!st?.faster_whisper;
  const cmdLine = cmd.length ? `python ${cmd.join(" ")}` : st?.install_hint ?? "";
  const STEP_LABEL: Record<string, string> = { package: t("安裝套件（含相依）"), model: t("下載模型") };

  return (
    <div className="min-w-0 rounded-md border border-fg/10 px-3 py-2 text-[11px] space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={ready ? "text-success" : "text-warning"}>{ready ? t("可以使用") : t("尚未就緒")}</span>
        <span className="text-fg/45">
          {st
            ? `Python ${st.python ? (st.python_version ?? "OK") : t("找不到")} · faster-whisper ${st.faster_whisper ? "OK" : t("未安裝")}`
            : t("檢查中…")}
        </span>
        <Button size="sm" variant="ghost" icon={RefreshCw} className="ml-auto" loading={probing} onClick={() => void probe()}>
          {t("重新檢查")}
        </Button>
      </div>

      {st && !st.python && (
        <div className="text-fg/60">{t("先安裝 Python 3.9 以上並確認它在 PATH 上；這個 App 不會替你裝 Python。")}</div>
      )}

      {st?.python && (
        <div className="space-y-2">
          {!ready && <div className="text-fg/60">{t("選好要裝什麼再按安裝。這一步會動到你的 Python 環境。")}</div>}

          <label className="flex items-center gap-2">
            <input type="checkbox" checked={withModel} disabled={running} onChange={(e) => setWithModel(e.target.checked)} />
            <span className="text-fg/70">{t("順便下載模型")}</span>
            <span className="w-44">
              <Select value={model} disabled={!withModel || running} onChange={(e) => setModel(e.target.value)}>
                {(models.length ? models : ([["large-v3", "~3 GB"]] as [string, string][])).map(([m, size]) => (
                  <option key={m} value={m}>
                    {m}（{size}）
                  </option>
                ))}
              </Select>
            </span>
          </label>
          <div className="text-fg/45 leading-snug">
            {t("不先下載的話，第一次分析時才會抓 —— 那時你正等著看結果，卻卡在一個沒有進度的下載上。越大越準也越慢；沒有顯示卡也跑得動。")}
          </div>

          <div className="flex items-center gap-1">
            <code className="min-w-0 flex-1 truncate rounded bg-inset px-2 py-1 font-mono text-[11px] select-all" title={cmdLine}>
              {cmdLine}
            </code>
            <Button size="sm" variant="ghost" disabled={!cmdLine} onClick={() => void copyToClipboard(cmdLine, t("已複製"))}>
              {t("複製")}
            </Button>
            <Button size="sm" variant="primary" icon={Download} loading={running} disabled={running} onClick={() => void install()}>
              {ready ? t("重新安裝 / 補模型") : t("開始安裝")}
            </Button>
          </div>

          {(running || log.length > 0) && (
            <div className="space-y-1">
              {step && <div className="text-accent">{STEP_LABEL[step] ?? step}…</div>}
              <pre
                ref={logRef}
                className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded bg-inset px-2 py-1 font-mono text-[10px] leading-4 text-fg/60"
              >
                {log.join("\n")}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
