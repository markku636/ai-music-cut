import { useState } from "react";
import { Palette, Play } from "lucide-react";
import { errMessage } from "../api";
import { Button, Field, FormGrid, Modal, Select, Spinner, Textarea } from "../ui/index";
import { toast } from "../ui";
import { useT } from "../i18n";
import { runStyleTransfer } from "../pipeline/musicStyle";
import { playRange } from "../preview/playerRef";
import { STYLE_PRESETS } from "./musicPresets";
import { formatMs } from "../time";

export interface StyleDialogProps {
  mediaId: string;
  startMs: number;
  endMs: number;
  onClose: () => void;
}

/**
 * 曲風轉換：拿編輯器裡選取的那一段當參考（audio2audio），配上目標風格描述生成新曲。
 * 貼近度調高＝保留原本的旋律與段落走向、只換音色編曲；調低＝讓 AI 自由發揮。
 */
export default function StyleDialog({ mediaId, startMs, endMs, onClose }: StyleDialogProps) {
  const t = useT();
  const [prompt, setPrompt] = useState(STYLE_PRESETS[0].prompt);
  const [strength, setStrength] = useState(0.7);
  const [candidates, setCandidates] = useState(2);
  const [format, setFormat] = useState("mp3");
  const [busy, setBusy] = useState(false);
  const lenMs = Math.max(0, endMs - startMs);
  const tooShort = lenMs < 2000;

  const start = async () => {
    if (!prompt.trim() || tooShort) return;
    setBusy(true);
    try {
      await runStyleTransfer({
        mediaId,
        startMs,
        endMs,
        prompt: prompt.trim(),
        coverStrength: strength,
        nCandidates: candidates,
        format,
        addToProject: true,
      });
      onClose();
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t("改成另一種曲風")}
      icon={Palette}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("取消")}
          </Button>
          <Button variant="primary" onClick={() => void start()} loading={busy} disabled={busy || tooShort || !prompt.trim()}>
            {t("開始轉換")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="flex items-center gap-2 rounded-md border border-fg/10 px-3 py-2 text-xs">
          <span className="text-fg/55">{t("參考片段")}</span>
          <span className="mono text-fg/85 tabular-nums">
            {formatMs(startMs, { millis: false })} – {formatMs(endMs, { millis: false })}
          </span>
          <span className="text-accent mono">{(lenMs / 1000).toFixed(1)}s</span>
          <Button size="sm" variant="ghost" icon={Play} className="ml-auto" onClick={() => playRange(startMs, endMs, { skip: false })}>
            {t("試聽")}
          </Button>
        </div>
        {tooShort && <div className="text-xs text-warning">{t("選取太短（至少 2 秒）才有足夠的參考")}</div>}

        <Field label={t("目標曲風")} hint={t("英文 tag 式效果最好；描述樂器、情緒、節奏")}>
          <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={busy} spellCheck={false} />
        </Field>
        <div className="flex flex-wrap gap-1">
          {STYLE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={busy}
              onClick={() => setPrompt(p.prompt)}
              className="text-[11px] px-2 py-1 rounded-sm border border-fg/10 text-fg/60 hover:bg-fg/5 disabled:opacity-40"
            >
              {p.label}
            </button>
          ))}
        </div>

        <Field
          label={t("貼近原曲 {n}%", { n: Math.round(strength * 100) })}
          hint={strength >= 0.75 ? t("高：保留原本的旋律與段落走向，只換音色編曲") : strength >= 0.45 ? t("中：抓住走向，細節重新編") : t("低：只當靈感，AI 自由發揮")}
        >
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(strength * 100)}
            onChange={(e) => setStrength(Number(e.target.value) / 100)}
            disabled={busy}
            className="w-full accent-[rgb(var(--c-accent))]"
          />
        </Field>

        <FormGrid className="grid-cols-2">
          <Field label={t("候選數")} hint={t("一次生幾首供挑選")}>
            <Select value={String(candidates)} onChange={(e) => setCandidates(Number(e.target.value))} disabled={busy}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("格式")} hint={t("要再剪輯建議 wav / flac")}>
            <Select value={format} onChange={(e) => setFormat(e.target.value)} disabled={busy}>
              <option value="mp3">mp3</option>
              <option value="wav">wav</option>
              <option value="flac">flac</option>
            </Select>
          </Field>
        </FormGrid>

        <p className="text-[11px] text-fg/35 leading-relaxed">
          {t("生成的曲子會加進媒體清單（不會動到原始檔），可以直接剪、貼齊拍點、輸出。長度會跟隨參考片段。")}
        </p>
        {busy && (
          <div className="flex items-center gap-2 text-xs text-fg/60">
            <Spinner size={14} className="text-accent" />
            {t("轉換中…可以關掉這個視窗，進度在左下角工作列（也能取消）")}
          </div>
        )}
      </div>
    </Modal>
  );
}
