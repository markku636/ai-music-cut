import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight, Play, RotateCcw, Scissors, Square } from "lucide-react";
import { seamNear, seamsOf, seamWindow, type Seam } from "../analysis/edl/map";
import { useT } from "../i18n";
import { edlFor } from "../pipeline/rules";
import { currentPreviewKey, ensurePreview } from "../pipeline/previewRender";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { formatMs } from "../time";
import { Badge, Button, IconButton, Segmented } from "../ui/index";
import { toast } from "../ui";
import { activeSource, resetToSource, setCutPlayer, switchTo } from "./cutPlayer";
import { getPlayer, playRange, stopRange } from "./playerRef";

type Mode = "src" | "live" | "rendered";

const SEAM_PAD_MS = 1200;

/**
 * 輸出前的預覽列：原始 / 剪後（即時）/ 剪後（成品），加上接縫巡覽。
 *
 * 「即時」是跳播近似 —— 播放時跳過剪除區，但沒有 crossfade、沒有 room tone、沒有結尾淡出。
 * 「成品」是真的用同一套剪接器渲染出來的檔（只跳過響度正規化），接點的爆音只有它聽得到。
 * 徽章刻意把這個差別講出來，不要讓人以為「即時」就等於成品。
 */
export default function PreviewBar({ mediaId }: { mediaId: string }) {
  const t = useT();
  const cutRef = useRef<HTMLAudioElement>(null);
  const [mode, setMode] = useState<Mode>("src");
  const [rendered, setRendered] = useState<{ path: string; key: string; durationMs: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [seamIdx, setSeamIdx] = useState(0);
  const skipEnabled = usePlayback((s) => s.skipEnabled);
  const toggleSkip = usePlayback((s) => s.toggleSkip);
  const candidates = useDecisions((s) => s.candidates[mediaId] ?? EMPTY);
  const decisions = useDecisions((s) => s.decisions[mediaId] ?? EMPTY_D);
  const decide = useDecisions((s) => s.decide);
  const aggressiveness = useProject((s) => s.aggressiveness);
  // 接縫清單與「預覽是否過期」都吃 EDL —— 少了 splits / pastes 就會停在舊的那一份
  const splits = useDecisions((s) => s.splits[mediaId] ?? EMPTY_D2);
  const pastes = useDecisions((s) => s.pastes[mediaId] ?? EMPTY_D2);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const edl = useMemo(() => edlFor(mediaId), [mediaId, candidates, decisions, splits, pastes, aggressiveness]);
  const seams = useMemo(() => (edl ? seamsOf(edl) : []), [edl]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const liveKey = useMemo(() => currentPreviewKey(mediaId), [mediaId, candidates, decisions, splits, pastes, aggressiveness]);
  // 決策一改，手上的成品預覽就過期了 —— 自動退回「即時」，但**不自動重渲染**
  const stale = !!rendered && !!liveKey && rendered.key !== liveKey;

  useEffect(() => {
    setCutPlayer(cutRef.current);
    return () => {
      setCutPlayer(null);
      resetToSource();
    };
  }, []);

  useEffect(() => {
    setRendered(null);
    setMode("src");
    resetToSource();
  }, [mediaId]);

  useEffect(() => {
    if (stale && mode === "rendered") {
      setMode("live");
      switchTo("src", { keeps: edl?.keeps ?? [] });
    }
  }, [stale, mode, edl]);

  const goMode = useCallback(
    async (m: Mode) => {
      const keeps = edl?.keeps ?? [];
      if (m === "rendered") {
        if (!rendered || stale) {
          setBusy(true);
          try {
            const r = await ensurePreview(mediaId);
            if (!r) {
              toast.error(t("沒有可預覽的內容（還沒分析或沒有保留段）"));
              return;
            }
            setRendered({ path: r.path, key: r.key, durationMs: r.durationMs });
            if (!r.cached) toast.success(t("預覽已渲染（與成品同一套剪接）"));
          } catch (e) {
            toast.error(String(e));
            return;
          } finally {
            setBusy(false);
          }
        }
        // <audio> 換 src 需要一拍
        setTimeout(() => switchTo("cut", { keeps, cutDurationMs: rendered?.durationMs ?? null }), 120);
      } else {
        switchTo("src", { keeps });
        if (m === "live" && !skipEnabled) toggleSkip();
        if (m === "src" && skipEnabled) toggleSkip();
      }
      setMode(m);
    },
    [edl, rendered, stale, mediaId, skipEnabled, toggleSkip, t],
  );

  const playSeam = useCallback(
    (s: Seam) => {
      setSeamIdx(s.index);
      if (mode === "rendered" && activeSource() === "cut" && cutRef.current) {
        const w = seamWindow(s, SEAM_PAD_MS);
        cutRef.current.currentTime = w.startMs / 1000;
        void cutRef.current.play().catch(() => {});
        window.setTimeout(() => cutRef.current?.pause(), w.endMs - w.startMs);
        return;
      }
      // 即時模式：用來源時間軸播，跳播會把剪掉的部分吃掉。
      //
      // 編排接縫（貼上 / 搬移）在來源時間軸上**放不出來** —— 它的兩邊來自來源的兩個
      // 地方，`srcAfterMs` 可能比 `srcBeforeMs` 還小，直接餵進去就是一個顛倒的範圍
      // （放不出聲音，或整檔從頭播）。這種接縫只播前面那一段的尾巴，要聽真正的接法
      // 得切到成品預覽。
      if (s.rearranged) {
        playRange(Math.max(0, s.srcBeforeMs - SEAM_PAD_MS), s.srcBeforeMs, { skip: true });
        return;
      }
      playRange(Math.max(0, s.srcBeforeMs - SEAM_PAD_MS), s.srcAfterMs + SEAM_PAD_MS, { skip: true });
    },
    [mode],
  );

  const step = (dir: 1 | -1) => {
    const el = mode === "rendered" ? cutRef.current : getPlayer();
    const cur = el ? el.currentTime * 1000 : 0;
    const next = mode === "rendered" ? seamNear(seams, cur, dir) : seams[Math.max(0, Math.min(seams.length - 1, seamIdx + dir))];
    if (next) playSeam(next);
  };

  const cur = seams[seamIdx] ?? null;

  const keepThisSeam = () => {
    if (!cur?.candidateIds.length) return;
    decide(mediaId, cur.candidateIds, "rejected", { label: t("巡接縫時改判保留") });
    toast.info(t("已改判保留（預覽需要重新渲染）"));
  };

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 h-9 border-t border-fg/10 bg-bar text-xs">
      <audio ref={cutRef} src={rendered ? convertFileSrc(rendered.path) : undefined} preload="auto" className="hidden" />
      <Segmented<Mode>
        size="sm"
        value={mode}
        onChange={(m) => void goMode(m)}
        options={[
          { value: "src", label: t("原始") },
          { value: "live", label: t("剪後（即時）") },
          { value: "rendered", label: busy ? t("渲染中…") : t("剪後（成品）") },
        ]}
      />
      {mode === "live" && <Badge tone="warning">{t("即時近似 · 沒有接點淡化")}</Badge>}
      {mode === "rendered" && !stale && <Badge tone="success">{t("已渲染 · 與成品同一套剪接")}</Badge>}
      {stale && <Badge tone="warning">{t("決策已變，預覽過期")}</Badge>}

      <span className="w-px h-4 bg-fg/10 mx-0.5" aria-hidden />
      <span className="inline-flex items-center gap-1 text-fg/55 whitespace-nowrap">
        <Scissors size={12} className="opacity-60" />
        {seams.length ? t("接縫 {i} / {n}", { i: Math.min(seamIdx + 1, seams.length), n: seams.length }) : t("沒有接縫")}
      </span>
      <IconButton icon={ChevronLeft} label={t("上一個接縫")} disabled={!seams.length} onClick={() => step(-1)} />
      <IconButton icon={Play} label={t("重播這個接縫")} disabled={!cur} onClick={() => cur && playSeam(cur)} />
      <IconButton icon={ChevronRight} label={t("下一個接縫")} disabled={!seams.length} onClick={() => step(1)} />
      {cur && (
        <span className="text-fg/45 truncate max-w-[16rem]">
          {formatMs(cur.outMs, { millis: false })} ·{" "}
          {cur.rearranged ? t("編排接縫（貼上 / 搬移）") : t("剪掉 {s}s", { s: (cur.removedMs / 1000).toFixed(2) })}
          {cur.kind === "gap" && ` · ${t("留白")}`}
        </span>
      )}
      {cur && !!cur.candidateIds.length && (
        <Button size="sm" variant="ghost" icon={RotateCcw} className="whitespace-nowrap" onClick={keepThisSeam}>
          {t("這刀不要")}
        </Button>
      )}
      <IconButton icon={Square} label={t("停止")} className="ml-auto" onClick={() => { stopRange(); cutRef.current?.pause(); }} />
    </div>
  );
}

const EMPTY: never[] = [];
const EMPTY_D2: never[] = [];
const EMPTY_D = {};
