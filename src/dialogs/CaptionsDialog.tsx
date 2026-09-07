import { useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Captions, ClipboardCopy, Save } from "lucide-react";
import {
  buildCues,
  CAPTION_EXT,
  renderCaptions,
  type CaptionFormat,
} from "../analysis/captions";
import { assignWords } from "../analysis/speakers";
import { api, errMessage } from "../api";
import { useT } from "../i18n";
import { edlFor } from "../pipeline/rules";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useTranscript } from "../store/transcript";
import { Button, EmptyState, Modal, Segmented } from "../ui/index";
import { toast } from "../ui";

const FORMATS: { id: CaptionFormat; label: string; hint: string }[] = [
  { id: "srt", label: "SRT", hint: "YouTube / 多數播放器" },
  { id: "vtt", label: "WebVTT", hint: "網頁播放器 / HTML5" },
  { id: "md", label: "Markdown", hint: "部落格 / 節目筆記" },
  { id: "txt", label: "純文字", hint: "只有內容" },
];

/**
 * 字幕與逐字稿匯出。
 *
 * **這裡真正難的不是格式，是時間。** 逐字稿在來源時間軸上，字幕要的是成品時間 ——
 * 剪掉 20 個贅字之後，來源 12:30 那句話在成品裡是 12:11，剪愈多錯愈遠而且錯得很
 * 安靜（字幕會整份慢慢飄掉，愈後面愈離譜）。所以這裡一定要有 EDL 才做得出來，
 * 而且被剪掉的字**整個不出現**（不是往前挪，是根本沒說過）。
 *
 * 邏輯全在 `analysis/captions.ts`，這裡只負責選格式、預覽、存檔。
 */
export default function CaptionsDialog({ mediaId, onClose }: { mediaId: string | null; onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media.find((m) => m.id === mediaId) ?? null);
  const transcript = useTranscript((s) => (mediaId ? s.byMedia[mediaId] : undefined));
  const speakers = useDecisions((s) => (mediaId ? s.speakers[mediaId] : undefined));
  const [format, setFormat] = useState<CaptionFormat>("srt");
  const [withSpeaker, setWithSpeaker] = useState(true);

  const labelOf = useMemo(() => {
    const by = new Map((speakers?.list ?? []).map((x) => [x.id, x.label]));
    return (id: string) => by.get(id) ?? id;
  }, [speakers]);

  const cues = useMemo(() => {
    if (!mediaId || !transcript) return [];
    const edl = edlFor(mediaId);
    if (!edl) return [];
    const speakerOf = speakers?.turns.length ? assignWords(transcript.words, speakers.turns) : undefined;
    return buildCues({ words: transcript.words, sentences: transcript.sentences, keeps: edl.keeps, speakerOf });
  }, [mediaId, transcript, speakers]);

  const hasSpeakers = (speakers?.list.length ?? 0) > 0;
  const text = useMemo(
    () => renderCaptions(cues, format, { speakerPrefix: withSpeaker && hasSpeakers, labelOf }),
    [cues, format, withSpeaker, hasSpeakers, labelOf],
  );

  const outMs = cues.length ? cues[cues.length - 1].endMs : 0;

  const saveAs = async () => {
    if (!text.trim()) return;
    const base = (media?.name ?? "captions").replace(/\.[^.]+$/, "");
    const ext = CAPTION_EXT[format];
    const path = await save({ defaultPath: `${base}.${ext}`, filters: [{ name: format.toUpperCase(), extensions: [ext] }] }).catch(() => null);
    if (!path) return;
    try {
      await api.writeTextFile(path, text);
      toast.success(t("已存成 {p}", { p: path }));
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("字幕與逐字稿")}
      icon={Captions}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t("關閉")}</Button>
          <Button
            icon={ClipboardCopy}
            disabled={!text.trim()}
            onClick={() => {
              void navigator.clipboard.writeText(text);
              toast.success(t("已複製"));
            }}
          >
            {t("複製")}
          </Button>
          <Button variant="primary" icon={Save} disabled={!text.trim()} onClick={() => void saveAs()}>
            {t("存檔")}
          </Button>
        </>
      }
    >
      {!transcript ? (
        <EmptyState icon={Captions} title={t("還沒有逐字稿")} hint={t("先分析這個音檔，字幕才有內容可以產。")} />
      ) : cues.length === 0 ? (
        <EmptyState icon={Captions} title={t("沒有可以匯出的內容")} hint={t("整份逐字稿都落在被剪掉的區間裡。")} />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-[11px] leading-relaxed text-fg/50">
            {t("時間戳是**成品**時間，不是逐字稿的時間 —— 被剪掉的字整個不會出現，後面的字幕跟著往前挪。所以字幕不會愈到後面愈飄。")}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              value={format}
              onChange={(v) => setFormat(v as CaptionFormat)}
              options={FORMATS.map((f) => ({ value: f.id, label: t(f.label) }))}
            />
            <span className="text-[11px] text-fg/40">{t(FORMATS.find((f) => f.id === format)?.hint ?? "")}</span>
          </div>
          {hasSpeakers && (
            <label className="flex items-center gap-2 text-[12px] text-fg/60">
              <input type="checkbox" checked={withSpeaker} onChange={(e) => setWithSpeaker(e.target.checked)} />
              {t("把講者名字寫進去")}
            </label>
          )}
          <div className="mono text-[11px] tabular-nums text-fg/40">
            {t("{n} 則 · 到 {t} 為止", { n: cues.length, t: `${Math.floor(outMs / 60000)}:${String(Math.floor((outMs % 60000) / 1000)).padStart(2, "0")}` })}
            {!hasSpeakers && ` · ${t("沒有講者標籤")}`}
          </div>
          <pre className="mono max-h-[45vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-inset p-3 text-[11px] leading-5 text-fg/70">
            {text.slice(0, 8000)}
            {text.length > 8000 ? `\n…（預覽只到前 8000 字，存檔是完整的）` : ""}
          </pre>
        </div>
      )}
    </Modal>
  );
}
