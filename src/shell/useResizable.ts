import { useState, type PointerEvent as ReactPointerEvent } from "react";

function clampSize(v: number, min: number, max: number) {
  return Math.max(min, Math.min(v, max));
}

// 可拖曳分隔線：記憶尺寸（localStorage）+ 指標拖曳調整。axis "x" 調寬度、"y" 調高度。
// 回傳目前尺寸與要綁在分隔線上的 onPointerDown；拖曳結束才寫回 localStorage。
export function useResizable(opts: {
  storageKey: string;
  initial: number;
  min: number;
  max: number | (() => number);
  axis: "x" | "y";
  /** 反向：把手在元素「前面」（例如右側面板拖左緣）時，往負方向拖是變大。 */
  invert?: boolean;
}) {
  const maxOf = () => (typeof opts.max === "function" ? opts.max() : opts.max);
  const [size, setSize] = useState<number>(() => {
    try {
      const v = localStorage.getItem(opts.storageKey);
      if (v != null) {
        const n = parseFloat(v);
        if (Number.isFinite(n)) return clampSize(n, opts.min, maxOf());
      }
    } catch {
      /* 忽略讀取失敗 */
    }
    return opts.initial;
  });

  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const start = opts.axis === "x" ? e.clientX : e.clientY;
    const startSize = size;
    let latest = startSize;
    const sign = opts.invert ? -1 : 1;
    const move = (ev: PointerEvent) => {
      const cur = opts.axis === "x" ? ev.clientX : ev.clientY;
      latest = clampSize(startSize + sign * (cur - start), opts.min, maxOf());
      setSize(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(opts.storageKey, String(latest));
      } catch {
        /* 忽略寫入失敗 */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = opts.axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return { size, onPointerDown };
}
