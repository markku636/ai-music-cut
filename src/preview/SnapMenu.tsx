// 吸附控制：磁鐵鈕（總開關，N）+ 一個下拉決定要吸到哪些東西。
//
// 吸附以前只吸拍點，是剪音樂用的。剪 podcast 時真正想吸的是句界與既有接縫，
// 所以這顆從「BPM 那一群」搬出來，變成不分音樂 / 語音都看得到的常駐控制。
import { Magnet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SnapEnabled } from "../analysis/snap";
import { useT } from "../i18n";
import { useTimeline } from "../store/timeline";
import { IconButton } from "../ui/index";

const KINDS: { key: keyof SnapEnabled; label: string; hint: string }[] = [
  { key: "seams", label: "接縫", hint: "已經剪過的接點 —— 兩刀對齊才不會留下碎片" },
  { key: "sentences", label: "句界", hint: "句子的頭尾。剪 podcast 最常用的一個" },
  { key: "words", label: "字界", hint: "每個字的頭尾。很密，需要細修時才開" },
  { key: "beats", label: "拍點", hint: "剪音樂用；偵測到拍網格時才有作用" },
];

export default function SnapMenu({ hasGrid }: { hasGrid: boolean }) {
  const t = useT();
  const snap = useTimeline((s) => s.snap);
  const toggleSnap = useTimeline((s) => s.toggleSnap);
  const setSnapKind = useTimeline((s) => s.setSnapKind);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const on = KINDS.filter((k) => snap[k.key] && (k.key !== "beats" || hasGrid)).map((k) => t(k.label));
  const summary = on.length ? on.join(" · ") : t("沒有勾選任何目標");

  return (
    <span ref={ref} className="relative flex items-center">
      <IconButton
        icon={Magnet}
        label={snap.enabled ? t("吸附（開，N）：{list}", { list: summary }) : t("吸附（關，N）")}
        active={snap.enabled}
        onClick={toggleSnap}
      />
      <button
        type="button"
        aria-label={t("選擇吸附目標")}
        title={t("選擇吸附目標")}
        onClick={() => setOpen((v) => !v)}
        className="h-7 w-3 -ml-1 rounded-sm text-[9px] leading-none text-fg/40 hover:bg-fg/5 hover:text-fg/70"
      >
        ▾
      </button>
      {open && (
        <div className="absolute top-8 right-0 z-30 w-60 rounded-md border border-fg/10 bg-bg shadow-lg p-1.5 text-[12px]">
          <div className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-fg/35">{t("吸附到")}</div>
          {KINDS.map((k) => {
            const unavailable = k.key === "beats" && !hasGrid;
            return (
              <label
                key={k.key}
                title={t(k.hint)}
                className={`flex items-start gap-2 px-1.5 py-1 rounded-sm ${unavailable ? "opacity-40" : "hover:bg-fg/5 cursor-pointer"}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={snap[k.key]}
                  disabled={unavailable}
                  onChange={(e) => setSnapKind(k.key, e.target.checked)}
                />
                <span className="min-w-0">
                  <span className="text-fg/85">{t(k.label)}</span>
                  {unavailable && <span className="text-fg/35"> · {t("未偵測到拍網格")}</span>}
                  <span className="block text-[10px] text-fg/40 leading-snug">{t(k.hint)}</span>
                </span>
              </label>
            );
          })}
          <div className="mt-1 border-t border-fg/8 px-1.5 pt-1 text-[10px] text-fg/35">{t("容差跟著縮放走：放得越大吸得越準。")}</div>
        </div>
      )}
    </span>
  );
}
