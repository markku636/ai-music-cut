import type { PointerEvent as ReactPointerEvent } from "react";

// 拖曳把手：axis "x" → 直立細條（調左右）、"y" → 水平細條（調上下）。
export default function Splitter({ axis, onPointerDown }: { axis: "x" | "y"; onPointerDown: (e: ReactPointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      className={
        "shrink-0 bg-fg/10 hover:bg-accent/60 active:bg-accent transition-colors " +
        (axis === "x" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize")
      }
    />
  );
}
