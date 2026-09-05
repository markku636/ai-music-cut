import { useMemo, useState } from "react";
import { Disc3 } from "lucide-react";
import { errMessage } from "../api";
import { Button, Field, FormGrid, Input, Modal, Segmented, Select, Spinner, Textarea } from "../ui/index";
import { pickDirectory, toast } from "../ui";
import { useT } from "../i18n";
import { runGenerateMusic } from "../pipeline/music";
import { selectActiveMedia, useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import { formatDuration } from "../time";

/** 常用風格（英文 tag 式對 ACE-Step 效果最好）。 */
const PRESETS: { label: string; prompt: string }[] = [
  { label: "Lo-fi", prompt: "lofi hip hop, warm, mellow, vinyl crackle, soft drums" },
  { label: "Podcast 開場", prompt: "upbeat corporate intro, light percussion, bright synth, clean, energetic" },
  { label: "抒情鋼琴", prompt: "emotional piano ballad, soft strings, cinematic, gentle" },
  { label: "電子", prompt: "electronic dance, punchy kick, arpeggio synth, driving bassline" },
  { label: "爵士咖啡", prompt: "jazz cafe, brushed drums, upright bass, warm rhodes, relaxed swing" },
  { label: "環境", prompt: "ambient pad, airy texture, slow evolving, calm, no drums" },
];

type Quality = "fast" | "fine" | "max";

/**
 * AI 配樂（ttls 上的 ACE-Step）：描述風格 → 生成純器樂 BGM，直接加進媒體清單就能剪。
 * BPM 會帶入目前音檔偵測到的拍速，長度帶入目前選取，讓生出來的配樂跟素材對得上。
 */
export default function MusicDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const active = useProject(selectActiveMedia);
  const ttls = useSettings((s) => s.ttls);
  const key = useSettings((s) => s.key);
  const outputDir = useSettings((s) => s.s.output_dir);
  const beatGrid = useTimeline((s) => s.beatGrid);
  const selection = useTimeline((s) => s.selection);

  const selLen = selection ? Math.round((selection.endMs - selection.startMs) / 1000) : 0;
  const [prompt, setPrompt] = useState(PRESETS[0].prompt);
  const [duration, setDuration] = useState<number>(Math.min(240, Math.max(10, selLen || 30)));
  const [bpm, setBpm] = useState<number>(beatGrid ? Math.round(beatGrid.bpm) : 0);
  const [quality, setQuality] = useState<Quality>("fast");
  const [candidates, setCandidates] = useState(2);
  const [format, setFormat] = useState("mp3");
  const [outDir, setOutDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const blocked = !ttls?.ok || (key !== null && !key.present);
  const target = useMemo(() => outDir || outputDir || (active ? active.path.replace(/[\\/][^\\/]+$/, "") : ""), [outDir, outputDir, active]);
  const estimate = quality === "fast" ? t("約 30–60 秒") : quality === "fine" ? t("約 2–5 分鐘") : t("約 5–10 分鐘（最高音質，會吃滿 GPU）");

  const start = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      await runGenerateMusic({
        prompt: prompt.trim(),
        duration_sec: duration,
        bpm,
        quality,
        n_candidates: candidates,
        format,
        seed: -1,
        outDir: outDir ?? undefined,
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
      title={t("AI 配樂")}
      icon={Disc3}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("取消")}
          </Button>
          <Button variant="primary" onClick={() => void start()} loading={busy} disabled={busy || blocked || !prompt.trim() || !target}>
            {t("開始生成")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-xs text-fg/55 leading-relaxed">
          {t("用 ttls 上的 ACE-Step 生成純器樂配樂；生好的曲子會直接加進媒體清單，可以馬上剪、貼齊拍點、輸出。英文 tag 式的描述效果最好。")}
        </p>
        {blocked && <div className="text-xs text-warning">{!ttls?.ok ? t("ttls 伺服器離線，無法生成") : t("需要 ttls 金鑰（設定 → 伺服器）")}</div>}

        <Field label={t("風格描述")}>
          <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={busy} spellCheck={false} />
        </Field>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
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

        <FormGrid className="grid-cols-2">
          <Field label={t("長度（秒）")} hint={selLen ? t("目前選取 {d}", { d: formatDuration(selLen * 1000) }) : t("10–240 秒")}>
            <Input type="number" min={10} max={240} value={duration} onChange={(e) => setDuration(Math.max(10, Math.min(240, Number(e.target.value) || 30)))} disabled={busy} />
          </Field>
          <Field label={t("BPM（0 = 不指定）")} hint={beatGrid ? t("目前素材偵測到 {bpm}", { bpm: beatGrid.bpm }) : undefined}>
            <Input type="number" min={0} max={300} value={bpm} onChange={(e) => setBpm(Math.max(0, Math.min(300, Number(e.target.value) || 0)))} disabled={busy} />
          </Field>
        </FormGrid>

        <Field label={t("音質模式")} hint={estimate}>
          <Segmented<Quality>
            full
            value={quality}
            onChange={setQuality}
            options={[
              { value: "fast", label: t("快速（turbo）") },
              { value: "fine", label: t("精緻（2B）") },
              { value: "max", label: t("最高（4B）") },
            ]}
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

        <Field label={t("存到")} hint={target || t("請先選資料夾")}>
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

        {busy && (
          <div className="flex items-center gap-2 text-xs text-fg/60">
            <Spinner size={14} className="text-accent" />
            {t("生成中…可以關掉這個視窗，進度在左下角工作列（也能取消）")}
          </div>
        )}
      </div>
    </Modal>
  );
}
