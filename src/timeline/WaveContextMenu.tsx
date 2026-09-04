import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import Icon from "../ui/Icon";

export interface MenuItem {
  label?: ReactNode;
  icon?: LucideIcon;
  /** 右側灰字快捷鍵提示。 */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

export interface WaveContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * 通用右鍵選單（fixed 定位，超出視窗自動往內收）。點外面 / Esc / 捲動關閉。
 */
export default function WaveContextMenu({ x, y, items, onClose }: WaveContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    setPos({ left, top });
  }, [x, y, items.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", onClose, { once: true, capture: true });
    window.addEventListener("resize", onClose, { once: true });
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[200px] py-1 rounded-md bg-elevated border border-fg/10 shadow-e3 text-[13px] select-none"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="my-1 h-px bg-fg/10" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.onClick?.();
            }}
            className={`w-full flex items-center gap-2 px-3 h-7 text-left disabled:opacity-40 disabled:pointer-events-none ${
              it.danger ? "text-danger hover:bg-danger/12" : "text-fg/85 hover:bg-accent/15"
            }`}
          >
            <span className="w-4 grid place-items-center text-fg/60">
              {it.checked ? <span className="text-accent">✓</span> : it.icon ? <Icon icon={it.icon} size={14} /> : null}
            </span>
            <span className="flex-1 truncate">{it.label}</span>
            {it.shortcut && <span className="mono text-[11px] text-fg/35 ml-4">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
