import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cutSpansOf, overviewBars, scrollTargetMs, spansToRects, viewportOf, xFromMs } from "../analysis/overview";
import { addLines, gainLine, loudnessFraction, loudnessLine, quietShare } from "../analysis/loudnessLine";
import { DEFAULT_GAIN_OPTIONS, measureUnits, planGains } from "../analysis/loudness/plan";
import { splitUnits } from "../analysis/loudness/units";
import { useT } from "../i18n";
import { edlFor } from "../pipeline/rules";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useTranscript } from "../store/transcript";

/**
 * 總覽導航條（Audition / Audacity / Reaper 都有的那條）。
 *
 * 一集 57 分鐘的節目放大到聽得出接縫的程度時，畫面上只剩幾秒鐘 —— 捲個幾下就
 * 完全不知道自己在整集的哪裡。這條同時是兩件事：
 * - **地圖**：整份錄音的音量起伏、剪掉了哪些地方、標記在哪，一眼看完。
 * - **導航**：點一下就跳過去，拖著視窗框就能捲。
 *
 * **只在放大時出現**。整段適配時它跟上面的波形是同一張圖，留著只是佔高度。
 */

// 這個檔案跟 Timeline / PlayheadOverlay / BeatGridOverlay 一樣各自帶一份 ——
// 主題是 CSS 變數，取值必須在畫的當下讀，抽成共用模組並不會少掉什麼。
function cssTriple(varName: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || "248 248 242";
}
function cssRgb(varName: string, alpha = 1): string {
  return `rgb(${cssTriple(varName).split(/\s+/).join(" ")} / ${alpha})`;
}

const HEIGHT = 34;

export default function OverviewStrip({ mediaId, durationMs }: { mediaId: string | null; durationMs: number }) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [w, setW] = useState(0);
  const [dragging, setDragging] = useState(false);
  const pxPerSec = useTimeline((s) => s.pxPerSec);
  const fitPxPerSec = useTimeline((s) => s.fitPxPerSec);
  const viewWidth = useTimeline((s) => s.viewWidth);
  const viewStartMs = useTimeline((s) => s.viewStartMs);
  const scrollTo = useTimeline((s) => s.scrollTo);
  const currentMs = usePlayback((s) => s.currentMs);
  const showLoudness = useTimeline((s) => s.showLoudness);
  const targetLufs = useProject((s) => s.targetLufs);
  const leveling = useProject((s) => s.leveling);
  const local = useTranscript((s) => (mediaId ? s.local[mediaId] : undefined));
  const markers = useDecisions((s) => (mediaId ? s.markers[mediaId] : undefined));
  // 訂閱決策：剪掉哪裡要跟著更新。EDL 每次重算不便宜，所以只在這兩者變動時重算。
  const decisions = useDecisions((s) => (mediaId ? s.decisions[mediaId] : undefined));
  const candidates = useDecisions((s) => (mediaId ? s.candidates[mediaId] : undefined));
  // splits / pastes 也是 keeps 的輸入 —— 漏了它們，切一刀或貼一段之後這條不會重畫
  const splits = useDecisions((s) => (mediaId ? s.splits[mediaId] : undefined));
  const pastes = useDecisions((s) => (mediaId ? s.pastes[mediaId] : undefined));

  // callback ref 而不是 useEffect([])：這條在整段適配時整個不渲染，
  // 用 effect 的話第一次跑時 ref 還是 null，之後元素出現也不會再跑一次 ——
  // 寬度就永遠是 0，畫布不會被調整、點擊換算還會除到 0。
  const attach = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    wrapRef.current = el;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    roRef.current = ro;
    setW(el.clientWidth);
  }, []);

  useEffect(() => () => roRef.current?.disconnect(), []);

  const bars = useMemo(() => (local && w > 0 ? overviewBars(local.rmsU8, w) : null), [local, w]);
  // 整集的響度形狀。資料本來就在 analysis.bin（每 100 ms 一個視窗），這裡只是壓到帶寬。
  const loud = useMemo(() => (showLoudness && local && w > 0 ? loudnessLine(local.win, local.nWin, w) : null), [showLoudness, local, w]);
  const quiet = useMemo(() => (loud ? quietShare(loud, targetLufs) : 0), [loud, targetLufs]);
  // 「93% 偏小聲」講完，下一個問題一定是「那我該怎麼辦」。逐段平衡就是答案，
  // 但它要輸出之後才聽得到 —— 所以把它的結果畫在同一張圖上。
  // 用的是輸出時真的會套的那一組增益（planGains），不是另外估一次。
  const after = useMemo(() => {
    if (!loud || !leveling || !local || !mediaId || w <= 0) return null;
    const edl = edlFor(mediaId);
    if (!edl?.keeps.length) return null;
    const tr = useTranscript.getState().byMedia[mediaId];
    const units = splitUnits(edl.keeps, tr?.vad ?? []);
    if (!units.length) return null;
    const gains = planGains(measureUnits(units, local), { ...DEFAULT_GAIN_OPTIONS, targetLufs });
    return addLines(loud, gainLine(units, gains.map((g) => g.gainDb), durationMs, w));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loud, leveling, local, mediaId, w, durationMs, targetLufs, decisions, candidates, splits, pastes]);

  const cuts = useMemo(() => {
    if (!mediaId || w <= 0 || !durationMs) return [];
    const edl = edlFor(mediaId);
    if (!edl) return [];
    // EDL 給的是「保留」的段落；剪掉的是它們的**聯集**的補集（見 cutSpansOf ——
    // 照陣列順序推游標的話，搬到後面的那一段會被當成從來沒保留過）
    return spansToRects(cutSpansOf(edl.keeps, durationMs), w, durationMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId, w, durationMs, decisions, candidates, splits, pastes]);

  const vp = useMemo(
    () => viewportOf({ viewStartMs, viewWidthPx: viewWidth, pxPerSec: pxPerSec ?? fitPxPerSec, durationMs, stripWidth: w }),
    [viewStartMs, viewWidth, pxPerSec, fitPxPerSec, durationMs, w],
  );

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || w <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(HEIGHT * dpr);
    const g = cv.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, HEIGHT);

    // 波形
    if (bars) {
      g.fillStyle = cssRgb("--c-fg", 0.4);
      const mid = HEIGHT / 2;
      for (let i = 0; i < bars.length; i++) {
        const h = Math.max(1, (bars[i] / 255) * (HEIGHT - 6));
        g.fillRect(i, mid - h / 2, 1, h);
      }
    }

    // 剪掉的地方
    g.fillStyle = cssRgb("--c-danger", 0.35);
    for (const r of cuts) g.fillRect(r.x, 0, r.w, HEIGHT);

    // 響度形狀：目標線 + 逐像素的 short-term LUFS。
    // 即時響度表回答「這一刻多大聲」，這條回答「哪幾段要處理」—— 那是剪 podcast 真正在問的。
    if (loud) {
      const yOf = (v: number) => HEIGHT - loudnessFraction(v, targetLufs) * HEIGHT;
      // 目標線
      g.strokeStyle = cssRgb("--c-success", 0.55);
      g.setLineDash([3, 3]);
      g.lineWidth = 1;
      g.beginPath();
      const ty = Math.round(yOf(targetLufs)) + 0.5;
      g.moveTo(0, ty);
      g.lineTo(w, ty);
      g.stroke();
      g.setLineDash([]);
      // 平衡後的樣子（先畫，才不會蓋住現況那條）
      if (after) {
        g.fillStyle = cssRgb("--c-accent", 0.5);
        for (let x = 0; x < after.length; x++) {
          const v = after[x];
          if (Number.isFinite(v)) g.fillRect(x, Math.max(0, yOf(v) - 0.5), 1, 1);
        }
      }
      // 現況。低於目標 3 LU 以上的那幾格換色 —— 那正是「這一段偏小聲」。
      for (let x = 0; x < loud.length; x++) {
        const v = loud[x];
        if (!Number.isFinite(v)) continue;
        g.fillStyle = v < targetLufs - 3 ? cssRgb("--c-warning", 0.85) : cssRgb("--c-success", 0.8);
        g.fillRect(x, Math.max(0, yOf(v) - 1), 1, 2);
      }
    }

    // 標記（章節畫高一點，其他矮一格）
    for (const m of markers ?? []) {
      g.fillStyle = m.kind === "chapter" ? cssRgb("--c-accent", 0.9) : cssRgb("--c-warning", 0.8);
      g.fillRect(xFromMs(m.ms, w, durationMs), m.kind === "chapter" ? 0 : HEIGHT - 6, 1.5, m.kind === "chapter" ? HEIGHT : 6);
    }

    // 播放線
    g.fillStyle = cssRgb("--c-accent", 1);
    g.fillRect(xFromMs(currentMs, w, durationMs), 0, 1, HEIGHT);

    // 目前可視範圍
    g.strokeStyle = cssRgb("--c-fg", 0.75);
    g.lineWidth = 1;
    g.strokeRect(vp.x + 0.5, 0.5, Math.max(2, vp.w - 1), HEIGHT - 1);
    g.fillStyle = cssRgb("--c-fg", 0.1);
    g.fillRect(vp.x, 0, vp.w, HEIGHT);
  }, [bars, cuts, markers, currentMs, vp, w, durationMs, loud, after, targetLufs]);

  // 整段適配時這條跟上面的波形是同一張圖，留著只是佔高度
  if (!mediaId || !durationMs || vp.full) return null;

  const jump = (clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const x = clientX - el.getBoundingClientRect().left;
    scrollTo(scrollTargetMs({ x, stripWidth: w, durationMs, viewWidthPx: viewWidth, pxPerSec: pxPerSec ?? fitPxPerSec }));
  };

  return (
    <div
      ref={attach}
      className="relative w-full cursor-pointer select-none border-t border-fg/8 bg-inset/40"
      style={{ height: HEIGHT }}
      title={t("總覽：點一下跳過去，拖曳可以捲動")}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        jump(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging) jump(e.clientX);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
      }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      {/* 標籤壓在波形上會讀不出來，給一點底 */}
      <span className="pointer-events-none absolute left-0.5 top-0.5 rounded-sm bg-app/70 px-1 text-[9px] leading-[11px] text-fg/40">
        {t("總覽")}
      </span>
      <span className="pointer-events-none absolute right-0.5 top-0.5 rounded-sm bg-app/70 px-1 text-[9px] leading-[11px] tabular-nums text-fg/40">
        {loud && quiet > 0.05
          ? after
            ? t("{p}% 偏小聲 → 平衡後 {q}%", { p: Math.round(quiet * 100), q: Math.round(quietShare(after, targetLufs) * 100) })
            : t("{p}% 偏小聲", { p: Math.round(quiet * 100) })
          : `${Math.round((vp.endMs - vp.startMs) / 1000)}s / ${Math.round(durationMs / 1000)}s`}
      </span>
    </div>
  );
}
