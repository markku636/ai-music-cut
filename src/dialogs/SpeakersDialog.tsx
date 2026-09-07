import { useMemo, useState } from "react";
import { UserRound, UserPlus, Users } from "lucide-react";
import { speakerColor, speakerStats, type Speaker, type SpeakerTurn } from "../analysis/speakers";
import { levelSpread, speakerLevels, spreadVerdict } from "../analysis/speakerLevel";
import { Button, EmptyState, Input, Modal } from "../ui/index";
import { toast } from "../ui";
import { useT } from "../i18n";
import { useDecisions } from "../store/decisions";
import { useTimeline } from "../store/timeline";
import { useTranscript } from "../store/transcript";
import { formatMs } from "../time";

// 模組層的空值：每次 render 現做一個 [] 會讓 useMemo 的依賴每次都變。
const NO_SPEAKERS: Speaker[] = [];
const NO_TURNS: SpeakerTurn[] = [];

/**
 * 講者面板。
 *
 * 多人 podcast 剪起來最缺的一件事是逐字稿上看不出**是誰在講**。標籤本身在
 * `analysis/speakers.ts` 產生（多麥克風合併時順便算出來，是確定性的不是猜的）；
 * 這裡只做三件事：改名字、看發言佔比、手動修掉指派錯的地方。
 *
 * **單軌素材沒有自動指派**，而且這裡要講清楚為什麼 —— 不然使用者只會覺得功能壞了。
 * 單軌要靠聲紋分群，那需要模型；硬猜出來的標籤看起來很像但錯得很安靜，比沒有更糟。
 */
export default function SpeakersDialog({ mediaId, onClose }: { mediaId: string | null; onClose: () => void }) {
  const t = useT();
  const state = useDecisions((s) => (mediaId ? s.speakers[mediaId] : undefined));
  const rename = useDecisions((s) => s.renameSpeaker);
  const addSpeaker = useDecisions((s) => s.addSpeaker);
  const assign = useDecisions((s) => s.assignSpeaker);
  const selection = useTimeline((s) => s.selection);
  const local = useTranscript((s) => (mediaId ? s.local[mediaId] : undefined));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");

  const list = state?.list ?? NO_SPEAKERS;
  const turns = state?.turns ?? NO_TURNS;
  const stats = useMemo(() => speakerStats(turns, list), [turns, list]);
  const levels = useMemo(() => speakerLevels(local, turns, list), [local, turns, list]);
  const spread = useMemo(() => levelSpread(levels), [levels]);
  const verdict = spreadVerdict(spread);
  const totalMs = stats.reduce((a, b) => a + b.ms, 0);

  const commitName = (sp: Speaker) => {
    const v = (draft[sp.id] ?? sp.label).trim();
    setDraft((d) => {
      const n = { ...d };
      delete n[sp.id];
      return n;
    });
    if (!v || v === sp.label || !mediaId) return;
    rename(mediaId, sp.id, v);
  };

  const assignSelection = (speakerId: string | null) => {
    if (!mediaId || !selection) return;
    assign(mediaId, selection.startMs, selection.endMs, speakerId, t("指派講者"));
    const who = speakerId ? (list.find((x) => x.id === speakerId)?.label ?? speakerId) : t("（清除）");
    toast.success(t("{from}–{to} 指派給 {who}", { from: formatMs(selection.startMs, { millis: false }), to: formatMs(selection.endMs, { millis: false }), who }));
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("講者")}
      icon={Users}
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("關閉")}
        </Button>
      }
    >
      <div className="space-y-3 text-sm">
        {list.length === 0 ? (
          <EmptyState
            icon={Users}
            title={t("這一集還沒有講者標籤")}
            hint={t("一人一軌的素材用「同步麥克風」合併時會自動指派 —— 每支麥都收得到別人，但自己的麥一定最大聲，所以這是算出來的不是猜的。單軌素材沒辦法自動分辨誰是誰（那要聲紋模型），請在下面新增講者，再選取一段時間指派。")}
          />
        ) : (
          <>
            <p className="text-[11px] leading-relaxed text-fg/50">
              {t("佔比是「佔有人在講的時間」，不是佔整集長度 —— 靜音不屬於任何人。兩個人同時講的地方不指派給任何人（沒有答案好過錯誤答案），所以加起來會少於整集。")}
            </p>
            <p className="text-[11px] leading-relaxed text-fg/50">
              {t("有講者標籤時，輸出的逐段平衡會知道哪裡是「換人」而不是「同一個人變大聲」——換人的地方一次補到位，不受相鄰段落的階差限制，也不會把前一個人的音量平滑進來。")}
            </p>
            <div className="space-y-1">
              {stats.map((st) => {
                const sp = list.find((x) => x.id === st.speakerId);
                if (!sp) return null;
                const color = speakerColor(sp.colorIndex);
                return (
                  <div key={sp.id} className="rounded-md border border-fg/10 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="size-3 shrink-0 rounded-full" style={{ background: color }} />
                      <Input
                        value={draft[sp.id] ?? sp.label}
                        onChange={(e) => setDraft((d) => ({ ...d, [sp.id]: e.target.value }))}
                        onBlur={() => commitName(sp)}
                        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                        className="min-w-0 flex-1"
                      />
                      <span className="mono shrink-0 text-[11px] tabular-nums text-fg/45">
                        {Math.round(st.share * 100)}%
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-fg/10">
                      <span className="block h-full" style={{ width: `${st.share * 100}%`, background: color }} />
                    </div>
                    <div className="mono mt-1 text-[11px] tabular-nums text-fg/40">
                      {t("{ms} · {n} 次發言 · 最長一段 {longest}", {
                        ms: formatMs(st.ms, { millis: false }),
                        n: st.turns,
                        longest: formatMs(st.longestMs, { millis: false }),
                      })}
                      {(() => {
                        const lv = levels.find((x) => x.speakerId === sp.id);
                        if (!lv) return null;
                        return lv.lufs == null
                          ? ` · ${t("響度：講太少，量不出來")}`
                          : ` · ${t("來源 {lufs} LUFS", { lufs: lv.lufs.toFixed(1) })}`;
                      })()}
                    </div>
                    {selection && (
                      <Button size="sm" variant="ghost" className="mt-1.5" icon={UserRound} onClick={() => assignSelection(sp.id)}>
                        {t("把選取的 {t} 指派給他", { t: formatMs(Math.max(0, selection.endMs - selection.startMs), { millis: false }) })}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
            {verdict && spread != null && (
              <div
                className={`rounded-md border px-3 py-2 text-[11px] leading-relaxed ${
                  verdict === "bad" ? "border-danger/30 bg-danger/8 text-danger/90" : verdict === "noticeable" ? "border-warning/30 bg-warning/8 text-warning/90" : "border-fg/10 text-fg/50"
                }`}
              >
                {t("講者之間的來源響度最多差 {db} dB。", { db: spread.toFixed(1) })}{" "}
                {verdict === "even"
                  ? t("這個落差聽不太出來，逐段平衡輕鬆吸收得掉。")
                  : verdict === "noticeable"
                    ? t("聽得出來但補得動 —— 輸出時的逐段平衡會把每個人拉向同一個目標。")
                    : t("這已經不是後製能好好補救的了：把小聲的那一位拉起來，他的底噪與房間聲會一起拉起來。下次錄音時把兩支麥的增益調近一點。")}
              </div>
            )}
            <div className="mono text-[11px] tabular-nums text-fg/35">
              {t("有人在講的時間共 {ms}", { ms: formatMs(totalMs, { millis: false }) })}
            </div>
            {selection && (
              <Button size="sm" variant="ghost" onClick={() => assignSelection(null)}>
                {t("清掉選取範圍的講者")}
              </Button>
            )}
          </>
        )}

        <div className="flex items-end gap-2 border-t border-fg/10 pt-3">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[11px] text-fg/50">{t("新增講者")}</span>
            <Input
              value={newName}
              placeholder={t("例如：來賓")}
              disabled={!mediaId}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !newName.trim() || !mediaId) return;
                addSpeaker(mediaId, newName.trim());
                setNewName("");
              }}
            />
          </label>
          <Button
            icon={UserPlus}
            disabled={!mediaId || !newName.trim()}
            onClick={() => {
              if (!mediaId || !newName.trim()) return;
              addSpeaker(mediaId, newName.trim());
              setNewName("");
            }}
          >
            {t("新增")}
          </Button>
        </div>
        {!selection && list.length > 0 && (
          <p className="text-[11px] text-fg/40">{t("在波形上拉一段時間選取，這裡就會出現「指派給他」。")}</p>
        )}
      </div>
    </Modal>
  );
}
