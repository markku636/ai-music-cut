import { useMemo, useState } from "react";
import { Check, Lightbulb, MessageSquareOff, Plus, RotateCw, Trash2, X } from "lucide-react";
import { fillerTotals, groupFillers, type FillerGroup } from "../analysis/fillerStats";
import { EN_PURE_FILLERS, EN_SOFT_FILLERS, ZH_PURE_FILLERS, ZH_SOFT_FILLERS, type FillerMode } from "../analysis/lexicon";
import { normText } from "../analysis/normalize";
import { hasSignal, observeEpisode, parseObservations, putObservation, serializeObservations, suggestRules, totalsOf } from "../analysis/fillerLearn";
import { useProject } from "../store/project";
import { speakerColor } from "../analysis/speakers";
import { runRulesFor } from "../pipeline/rules";
import { Button, EmptyState, Input, Modal, Select } from "../ui/index";
import { toast } from "../ui";
import { useT } from "../i18n";
import { useDecisions } from "../store/decisions";
import { useSettings } from "../store/settings";
import { useTranscript } from "../store/transcript";

/**
 * 贅字管理。
 *
 * 一集 57 分鐘的節目會提出上千筆贅字候選，但它們只有二三十個「詞」：
 * 「然後」四百次、「就是」兩百次、「對」一百次。逐筆審是審不完的，
 * 以**詞**為單位一次決定一整群，才是這件事真正的操作粒度。
 *
 * 兩件事分開放：
 * - **本集**：這一集出現了哪些贅字、各幾次、可以省多少 → 整群接受 / 整群拒絕。
 * - **詞表**：跨集有效的個人設定。每個主持人的口頭禪都不一樣，
 *   內建那份是通用的，「我的」那份疊在上面。只存被動過的那幾個詞，
 *   之後改進了內建詞表，沒動過那個詞的人才拿得到新版本。
 *
 * 詞表改了要重跑規則才會反映到候選上（候選是分析當下算出來的）——
 * 這件事不能靠使用者猜，所以有一顆明確的「套用到本集」。
 */

const MODES: { value: FillerMode; label: string; hint: string }[] = [
  { value: "always", label: "一定剪", hint: "當成純語助詞，分數高到會自動剪" },
  { value: "context", label: "看語境", hint: "提出來但不自動剪，留給你或 AI 判斷" },
  { value: "never", label: "永不剪", hint: "完全不提這個詞，內建規則也不算數" },
];

const MODE_LABEL: Record<FillerMode, string> = { always: "一定剪", context: "看語境", never: "永不剪" };

function secs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`;
}

export default function FillersDialog({ mediaId, onClose }: { mediaId: string | null; onClose: () => void }) {
  const t = useT();
  const rules = useSettings((s) => s.s.filler_rules ?? {});
  const save = useSettings((s) => s.save);
  const candidates = useDecisions((s) => (mediaId ? s.candidates[mediaId] : undefined));
  const decisions = useDecisions((s) => (mediaId ? s.decisions[mediaId] : undefined));
  const decide = useDecisions((s) => s.decide);
  const words = useTranscript((s) => (mediaId ? s.byMedia[mediaId]?.words : undefined));
  const speakers = useDecisions((s) => (mediaId ? s.speakers[mediaId] : undefined));
  const [tab, setTab] = useState<"episode" | "lexicon">("episode");
  const [draft, setDraft] = useState("");
  const [draftMode, setDraftMode] = useState<FillerMode>("always");
  const [showBuiltin, setShowBuiltin] = useState(false);
  // 只處理某個講者的贅字。主持人的「對」多半是在給回饋（剪掉會讓對話變冷淡），
  // 來賓的「就是」才是要清的 —— 這兩件事不該用同一個決定。
  const [onlySpeaker, setOnlySpeaker] = useState<string | null>(null);
  // 詞表一改，畫面上的統計就跟候選對不上了 —— 標出來並給一顆重跑
  const [stale, setStale] = useState(false);
  // 建議：從**你親手做過的判斷**長出來的詞表提案（fillerLearn.ts）
  const observationsRaw = useSettings((s) => s.s.filler_observations);
  const media = useProject((s) => s.media.find((m) => m.id === mediaId) ?? null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const observations = useMemo(() => parseObservations(observationsRaw), [observationsRaw]);
  const suggestions = useMemo(
    () => suggestRules(totalsOf(observations), rules).filter((x) => !dismissed.has(x.norm)),
    [observations, rules, dismissed],
  );
  // 這一集還沒被記起來的判斷（按鈕上要顯示數量，不然使用者不知道按了會發生什麼）
  const pendingObs = useMemo(() => {
    if (!mediaId || !candidates || !words) return null;
    const obs = observeEpisode(candidates, decisions ?? {}, words, { episode: mediaId, name: media?.name ?? "" });
    return hasSignal(obs) ? obs : null;
  }, [mediaId, candidates, decisions, words, media]);
  const pendingCount = pendingObs ? Object.values(pendingObs.words).reduce((n, [a, b]) => n + a + b, 0) : 0;

  const learn = async () => {
    if (!pendingObs) return;
    const next = putObservation(observations, pendingObs);
    await save({ filler_observations: serializeObservations(next) });
    setDismissed(new Set());
    toast.success(t("記住了這一集的 {n} 個判斷", { n: pendingCount }));
  };

  const applySuggestion = async (norm: string, mode: FillerMode) => {
    await setRule(norm, mode);
    setDismissed(new Set([...dismissed, norm]));
  };


  const groups = useMemo(
    () => (candidates && words ? groupFillers(candidates, decisions ?? {}, words, { turns: speakers?.turns, only: onlySpeaker }) : []),
    [candidates, decisions, words, speakers, onlySpeaker],
  );
  const totals = useMemo(() => fillerTotals(groups), [groups]);

  const setRule = async (word: string, mode: FillerMode | null) => {
    const norm = normText(word);
    if (!norm) return;
    const next = { ...rules };
    // 還原成「跟著內建走」是把這條刪掉，而不是存一個 "context" ——
    // 存下來的話，這個詞就再也收不到未來對內建詞表的改進了
    if (mode === null) delete next[norm];
    else next[norm] = mode;
    await save({ filler_rules: next });
    setStale(true);
  };

  const bulk = (g: FillerGroup, state: "accepted" | "rejected") => {
    if (!mediaId) return;
    decide(mediaId, g.ids, state, {
      origin: "user",
      label: state === "accepted" ? `贅字「${g.text}」全部剪` : `贅字「${g.text}」全部保留`,
    });
    toast.success(
      state === "accepted"
        ? t("「{w}」{n} 筆全部剪掉", { w: g.text, n: g.ids.length })
        : t("「{w}」{n} 筆全部保留", { w: g.text, n: g.ids.length }),
    );
  };

  const rerun = () => {
    if (!mediaId) return;
    const n = runRulesFor(mediaId, { label: t("套用贅字詞表"), record: true });
    setStale(false);
    toast.success(t("已重跑規則：{n} 個候選（可以 Ctrl+Z 回退）", { n }));
  };

  const custom = Object.entries(rules).sort(([a], [b]) => a.localeCompare(b));

  return (
    <Modal
      open
      onClose={onClose}
      title={t("贅字管理")}
      icon={MessageSquareOff}
      size="lg"
      footer={
        <>
          {/*
            這一集你親手做的判斷，記起來之後才會變成「我的詞表」的建議。
            刻意是一顆按鈕而不是自動寫入：開個對話框就偷偷改設定不是好事，
            而且使用者要看得到「記了幾筆」才知道這件事在做什麼。
          */}
          {pendingCount > 0 && (
            <Button variant="ghost" icon={Lightbulb} onClick={() => void learn()} title={t("記起來之後，「我的詞表」分頁會依你的做法提出建議")}>
              {t("記住我這一集的 {n} 個判斷", { n: pendingCount })}
            </Button>
          )}
          {stale && mediaId && (
            <Button variant="primary" icon={RotateCw} onClick={rerun}>
              {t("套用到本集（重跑規則）")}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t("關閉")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex gap-1">
          {(
            [
              ["episode", t("本集")],
              ["lexicon", t("我的詞表")],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`rounded-sm px-2 h-7 text-[12px] ${tab === k ? "bg-accent/15 text-accent" : "text-fg/60 hover:bg-fg/8"}`}
            >
              {label}
              {k === "lexicon" && custom.length > 0 && <span className="ml-1 text-[10px] text-fg/40">{custom.length}</span>}
              {k === "lexicon" && suggestions.length > 0 && (
                <span className="ml-1 rounded-full bg-accent/20 px-1.5 text-[10px] text-accent">{suggestions.length}</span>
              )}
            </button>
          ))}
        </div>

        {stale && (
          <div className="rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-[11px] text-warning/90">
            {t("詞表改過了。候選是分析當下算出來的，要按「套用到本集」重跑規則才會反映；下一次分析會自動吃到。")}
          </div>
        )}

        {/*
          建議來自**你親手做過的判斷**，不是 AI 的意見，也不是這一集的候選長相。
          按了才會改詞表，而且詞表只影響「下一次分析要不要提出這個詞」——
          不會動到任何已經做好的剪輯決策。
        */}
        {tab === "lexicon" && suggestions.length > 0 && (
          <div className="rounded-md border border-accent/25 bg-accent/6 px-3 py-2 space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] text-accent">
              <Lightbulb size={12} />
              {t("依你最近 {n} 集的做法建議", { n: observations.length })}
            </div>
            {suggestions.slice(0, 6).map((x) => (
              <div key={x.norm} className="flex items-center gap-2 text-[12px]">
                <span className="font-medium">{x.text}</span>
                <span className="text-[11px] text-fg/50">
                  {t("剪 {c} · 留 {k}", { c: x.cut, k: x.kept })}
                  {x.kind === "change" && x.current
                    ? t("（目前設成{cur}）", { cur: t(MODE_LABEL[x.current]) })
                    : x.builtin
                      ? t("（內建詞表會剪）")
                      : ""}
                </span>
                <span className="ml-auto shrink-0 flex items-center gap-1">
                  <Button size="sm" variant="primary" icon={Check} onClick={() => void applySuggestion(x.norm, x.mode)}>
                    {x.mode === "always" ? t("設成一律剪") : t("設成永不剪")}
                  </Button>
                  <Button size="sm" variant="ghost" icon={X} onClick={() => setDismissed(new Set([...dismissed, x.norm]))}>
                    {t("略過")}
                  </Button>
                </span>
              </div>
            ))}
            {suggestions.length > 6 && (
              <div className="text-[11px] text-fg/40">{t("還有 {n} 個建議", { n: suggestions.length - 6 })}</div>
            )}
          </div>
        )}

        {/*
          講者篩選列放在**空狀態外面**：篩到一個沒有贅字的人時，如果連篩選列也跟著
          消失，使用者就被困在空畫面裡回不去「全部人」了。
        */}
        {tab === "episode" && mediaId && words && (speakers?.list.length ?? 0) > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-fg/45">{t("只看")}</span>
            <button
              type="button"
              onClick={() => setOnlySpeaker(null)}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${onlySpeaker === null ? "border-accent bg-accent/12 text-accent" : "border-fg/15 text-fg/55 hover:bg-fg/5"}`}
            >
              {t("全部人")}
            </button>
            {speakers?.list.map((sp) => {
              const on = onlySpeaker === sp.id;
              return (
                <button
                  key={sp.id}
                  type="button"
                  onClick={() => setOnlySpeaker(on ? null : sp.id)}
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? "" : "border-fg/15 text-fg/55 hover:bg-fg/5"}`}
                  style={on ? { borderColor: speakerColor(sp.colorIndex), color: speakerColor(sp.colorIndex), background: `${speakerColor(sp.colorIndex)}1f` } : undefined}
                >
                  {sp.label}
                </button>
              );
            })}
            {onlySpeaker && <span className="text-[11px] text-fg/35">{t("整群操作只會動到這個人的那幾筆")}</span>}
          </div>
        )}

        {tab === "episode" ? (
          !mediaId || !words ? (
            <EmptyState icon={MessageSquareOff} title={t("還沒有逐字稿")} hint={t("先分析一個音檔，這裡才會列出贅字統計。")} />
          ) : groups.length === 0 ? (
            <EmptyState
              icon={MessageSquareOff}
              title={onlySpeaker ? t("這個講者沒有贅字候選") : t("這一集沒有贅字候選")}
              hint={onlySpeaker ? t("換一個講者，或按「全部人」看整集。") : t("可以到「我的詞表」加自己的口頭禪，再重跑規則。")}
            />
          ) : (
            <>
              <div className="rounded-md border border-fg/10 px-3 py-2 text-[11px] text-fg/60 leading-relaxed">
                {t("{w} 個詞、{n} 筆候選，全部剪掉可省 {all}；目前會剪 {c} 筆（省 {cut}），還有 {p} 筆待決。", {
                  w: totals.words,
                  n: totals.count,
                  all: secs(totals.totalMs),
                  c: totals.cut,
                  cut: secs(totals.cutMs),
                  p: totals.pending,
                })}
              </div>
              <div className="max-h-[46vh] overflow-y-auto -mx-1 px-1">
                <table className="w-full text-[12px] border-collapse">
                  <thead className="sticky top-0 bg-panel text-[10px] uppercase tracking-wide text-fg/35">
                    <tr>
                      <th className="text-left font-normal py-1 pl-1">{t("詞")}</th>
                      <th className="text-right font-normal py-1">{t("次數")}</th>
                      <th className="text-right font-normal py-1">{t("剪")}</th>
                      <th className="text-right font-normal py-1">{t("待決")}</th>
                      <th className="text-right font-normal py-1">{t("不剪")}</th>
                      <th className="text-right font-normal py-1 pr-2">{t("可省")}</th>
                      <th className="text-left font-normal py-1">{t("整群操作")}</th>
                      <th className="text-left font-normal py-1">{t("加進詞表")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      <tr key={g.norm} className="border-t border-fg/8 hover:bg-fg/[0.03]">
                        <td className="py-1 pl-1 max-w-[9rem] truncate" title={g.text}>
                          {g.text}
                          {!g.builtin && <span className="ml-1 text-[9px] rounded-sm bg-accent/15 text-accent px-1">{t("自訂")}</span>}
                        </td>
                        <td className="text-right tabular-nums">{g.count}</td>
                        <td className="text-right tabular-nums text-danger/80">{g.cut || ""}</td>
                        <td className="text-right tabular-nums text-warning/80">{g.pending || ""}</td>
                        <td className="text-right tabular-nums text-fg/40">{g.rejected || ""}</td>
                        <td className="text-right tabular-nums pr-2 text-fg/50">{secs(g.totalMs)}</td>
                        <td className="py-0.5">
                          <span className="flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => bulk(g, "accepted")}>
                              {t("全剪")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => bulk(g, "rejected")}>
                              {t("全留")}
                            </Button>
                          </span>
                        </td>
                        <td className="py-0.5">
                          <Select
                            className="!h-6 !text-[11px]"
                            value={g.rule ?? ""}
                            onChange={(e) => void setRule(g.norm, (e.target.value || null) as FillerMode | null)}
                          >
                            <option value="">{t("跟著內建")}</option>
                            {MODES.map((m) => (
                              <option key={m.value} value={m.value}>
                                {t(m.label)}
                              </option>
                            ))}
                          </Select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        ) : (
          <>
            <div className="flex items-end gap-2">
              <label className="flex-1 min-w-0">
                <span className="block text-[11px] text-fg/50 mb-1">{t("加一個詞（你自己的口頭禪）")}</span>
                <Input
                  value={draft}
                  placeholder={t("例如：我跟你講")}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && draft.trim()) {
                      void setRule(draft, draftMode);
                      setDraft("");
                    }
                  }}
                />
              </label>
              <span className="w-28 shrink-0">
                <Select value={draftMode} onChange={(e) => setDraftMode(e.target.value as FillerMode)}>
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {t(m.label)}
                    </option>
                  ))}
                </Select>
              </span>
              <Button
                icon={Plus}
                disabled={!draft.trim()}
                onClick={() => {
                  void setRule(draft, draftMode);
                  setDraft("");
                }}
              >
                {t("加入")}
              </Button>
            </div>

            <ul className="text-[11px] text-fg/45 space-y-0.5 pl-1">
              {MODES.map((m) => (
                <li key={m.value}>
                  <span className="text-fg/70">{t(m.label)}</span>：{t(m.hint)}
                </li>
              ))}
            </ul>

            {custom.length === 0 ? (
              <EmptyState icon={MessageSquareOff} title={t("詞表是空的")} hint={t("空的就是完全照內建那份走，這也很正常。")} />
            ) : (
              <div className="max-h-[36vh] overflow-y-auto space-y-1">
                {custom.map(([word, mode]) => (
                  <div key={word} className="flex items-center gap-2 rounded-sm border border-fg/8 px-2 py-1">
                    <span className="flex-1 min-w-0 truncate">{word}</span>
                    <span className="w-28 shrink-0">
                      <Select value={mode} onChange={(e) => void setRule(word, e.target.value as FillerMode)}>
                        {MODES.map((m) => (
                          <option key={m.value} value={m.value}>
                            {t(m.label)}
                          </option>
                        ))}
                      </Select>
                    </span>
                    <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void setRule(word, null)}>
                      {t("移除")}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div>
              <button type="button" onClick={() => setShowBuiltin((v) => !v)} className="text-[11px] text-fg/40 hover:text-fg/70">
                {showBuiltin ? t("收起內建詞表") : t("看內建詞表（已經涵蓋這些，不用重複加）")}
              </button>
              {showBuiltin && (
                <div className="mt-1 space-y-1 text-[11px] text-fg/45 leading-relaxed">
                  <div>
                    <span className="text-fg/65">{t("一定剪")}：</span>
                    {[...ZH_PURE_FILLERS, ...EN_PURE_FILLERS].join("、")}
                  </div>
                  <div>
                    <span className="text-fg/65">{t("看語境")}：</span>
                    {[...ZH_SOFT_FILLERS, ...EN_SOFT_FILLERS].join("、")}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
