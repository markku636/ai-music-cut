import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import Icon from "./Icon";

/**
 * 選單項目。右鍵選單、工具列下拉、子選單共用同一種資料。
 *
 * `disabled` 與 `muted` 是兩件事：
 * - `disabled`：完全不能互動（標題列那種「灰字說明」）。鍵盤導覽會跳過。
 * - `muted`：看起來像停用，但**點得到、鍵盤選得到**。指令註冊表用它：
 *   點下去會 toast 出「為什麼不能做」（`title` 也是同一句話）——
 *   只灰掉不解釋，人只會以為壞了。
 */
export interface MenuItem {
  label?: ReactNode;
  icon?: LucideIcon;
  /** 右側灰字快捷鍵提示。 */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  muted?: boolean;
  checked?: boolean;
  separator?: boolean;
  /** 滑鼠停留提示；停用原因放這裡。 */
  title?: string;
  /** 子選單（靜態陣列或延遲產生）。慣例最多兩層。 */
  children?: MenuItem[] | (() => MenuItem[]);
  /** 自動化 / 測試用的識別（例如指令 id）。 */
  dataId?: string;
  onClick?: () => void;
}

export type MenuAnchor = { x: number; y: number } | { rect: DOMRect; side: "bottom" | "right" };

export interface MenuPanelProps {
  items: MenuItem[];
  /** 關掉整棵選單（root 與所有子選單）。 */
  onClose: () => void;
  anchor: MenuAnchor;
  /** 0 = root；子選單由 root 遞增。root 負責掛全域的「點外面 / 捲動 / 縮放就關」監聽。 */
  level?: number;
  /** 子選單專用：← 或滑鼠離開時請父層收起我。 */
  onCloseSub?: () => void;
  /** 子選單專用：焦點回到父層那一列。 */
  autoFocus?: boolean;
  minWidthClass?: string;
}

interface RootCtx {
  register: (el: HTMLElement) => () => void;
  contains: (node: Node | null) => boolean;
}

const MenuRootContext = createContext<RootCtx | null>(null);

function resolveChildren(it: MenuItem): MenuItem[] {
  if (!it.children) return [];
  return typeof it.children === "function" ? it.children() : it.children;
}

/** 開子選單前的停留時間：滑過去的路上經過別的項目不該一路開一路關。 */
const HOVER_INTENT_MS = 120;

/**
 * 通用選單面板（fixed 定位、超出視窗自動往內收）。
 *
 * 從 WaveContextMenu 抽出來，多了：子選單（hover / 點 / →）、鍵盤導覽（↑ ↓ Home End 首字）、
 * `muted` 項目、`title` 提示、以及「子選單也算在選單裡面」——
 * 沒有這一條的話，滑進 flyout 的那一下 mousedown 會被 root 當成「點外面」而把整棵關掉。
 */
export default function MenuPanel(props: MenuPanelProps) {
  const parent = useContext(MenuRootContext);
  const level = props.level ?? 0;
  if (level === 0 || !parent) return <MenuRoot {...props} />;
  return <Panel {...props} level={level} />;
}

function MenuRoot(props: MenuPanelProps) {
  const { onClose } = props;
  const els = useRef(new Set<HTMLElement>());
  const ctx = useRef<RootCtx>({
    register: (el) => {
      els.current.add(el);
      return () => {
        els.current.delete(el);
      };
    },
    contains: (node) => {
      if (!node) return false;
      for (const el of els.current) if (el.contains(node)) return true;
      return false;
    },
  });

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ctx.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 不讓全域的 Esc（清除選取）順便觸發：使用者只是想關選單
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
    <MenuRootContext.Provider value={ctx.current}>
      <Panel {...props} level={0} autoFocus={props.autoFocus ?? false} />
    </MenuRootContext.Provider>
  );
}

function Panel({ items, onClose, anchor, level = 0, onCloseSub, autoFocus = false, minWidthClass = "min-w-[200px]" }: MenuPanelProps) {
  const root = useContext(MenuRootContext);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>(() => ("x" in anchor ? { left: anchor.x, top: anchor.y } : { left: anchor.rect.left, top: anchor.rect.bottom }));
  const [hi, setHi] = useState<number>(-1);
  const [openChild, setOpenChild] = useState<number | null>(null);
  const [childItems, setChildItems] = useState<MenuItem[]>([]);
  const [childRect, setChildRect] = useState<DOMRect | null>(null);
  const [subFocus, setSubFocus] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const navigable = (i: number) => {
    const it = items[i];
    return !!it && !it.separator && !it.disabled;
  };

  // 註冊到 root：子選單的 DOM 也要算「在選單裡面」
  useEffect(() => {
    const el = ref.current;
    if (!el || !root) return;
    return root.register(el);
  }, [root]);

  // 定位：先畫再量，超出視窗就往內收；子選單放右邊，右邊放不下就翻到左邊
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = window.innerWidth;
    const H = window.innerHeight;
    let left: number;
    let top: number;
    if ("x" in anchor) {
      left = anchor.x;
      top = anchor.y;
    } else if (anchor.side === "right") {
      left = anchor.rect.right - 2;
      top = anchor.rect.top - 4;
      if (left + r.width > W - 4) left = anchor.rect.left - r.width + 2;
    } else {
      left = anchor.rect.left;
      top = anchor.rect.bottom + 2;
    }
    left = Math.max(4, Math.min(left, W - r.width - 4));
    top = Math.max(4, Math.min(top, H - r.height - 4));
    setPos({ left, top });
  }, [anchor, items.length]);

  // 子選單用鍵盤打開時，焦點要進到它的第一列
  useEffect(() => {
    if (!autoFocus) return;
    const first = items.findIndex((_, i) => navigable(i));
    if (first >= 0) {
      setHi(first);
      itemRefs.current[first]?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const clearHover = () => {
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  useEffect(() => clearHover, []);

  const openSub = useCallback(
    (i: number, focusFirst: boolean) => {
      const it = items[i];
      if (!it?.children) return;
      const el = itemRefs.current[i];
      if (!el) return;
      setChildItems(resolveChildren(it));
      setChildRect(el.getBoundingClientRect());
      setOpenChild(i);
      setSubFocus(focusFirst);
    },
    [items],
  );

  const activate = (i: number) => {
    const it = items[i];
    if (!it || it.separator || it.disabled) return;
    if (it.children) {
      if (openChild === i) setOpenChild(null);
      else openSub(i, false);
      return;
    }
    onClose();
    it.onClick?.();
  };

  const move = (dir: 1 | -1) => {
    if (!items.length) return;
    let i = hi;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (navigable(i)) break;
    }
    setHi(i);
    itemRefs.current[i]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 子選單開著時鍵盤歸它管
    if (openChild != null) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        move(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        move(-1);
        return;
      case "Home":
      case "End": {
        e.preventDefault();
        e.stopPropagation();
        const order = e.key === "Home" ? items.map((_, i) => i) : items.map((_, i) => items.length - 1 - i);
        const i = order.find((k) => navigable(k));
        if (i != null) {
          setHi(i);
          itemRefs.current[i]?.focus();
        }
        return;
      }
      case "ArrowRight":
        if (hi >= 0 && items[hi]?.children) {
          e.preventDefault();
          e.stopPropagation();
          openSub(hi, true);
        }
        return;
      case "ArrowLeft":
        if (onCloseSub) {
          e.preventDefault();
          e.stopPropagation();
          onCloseSub();
        }
        return;
      case "Enter":
      case " ":
        if (hi >= 0) {
          e.preventDefault();
          e.stopPropagation();
          if (items[hi]?.children) openSub(hi, true);
          else activate(hi);
        }
        return;
      default: {
        // 首字跳轉（只對純文字標籤有效）
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        const ch = e.key.toLowerCase();
        const start = hi;
        for (let n = 1; n <= items.length; n++) {
          const i = (start + n) % items.length;
          const lab = items[i]?.label;
          if (navigable(i) && typeof lab === "string" && lab.toLowerCase().startsWith(ch)) {
            e.stopPropagation();
            setHi(i);
            itemRefs.current[i]?.focus();
            return;
          }
        }
      }
    }
  };

  return (
    <>
      <div
        ref={ref}
        role="menu"
        aria-activedescendant={hi >= 0 ? `menu-${level}-${hi}` : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`fixed z-50 ${minWidthClass} py-1 rounded-md bg-elevated border border-fg/10 shadow-e3 text-[13px] select-none outline-none`}
        style={{ left: pos.left, top: pos.top }}
        onContextMenu={(e) => e.preventDefault()}
        onMouseLeave={clearHover}
      >
        {items.map((it, i) =>
          it.separator ? (
            <div key={i} className="my-1 h-px bg-fg/10" />
          ) : (
            <button
              key={i}
              id={`menu-${level}-${i}`}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={it.disabled}
              title={it.title}
              data-cmd={it.dataId}
              aria-haspopup={it.children ? "menu" : undefined}
              aria-expanded={it.children ? openChild === i : undefined}
              onMouseEnter={() => {
                setHi(i);
                clearHover();
                if (it.children) {
                  hoverTimer.current = window.setTimeout(() => openSub(i, false), HOVER_INTENT_MS);
                } else if (openChild != null) {
                  // 滑到別的項目：稍等一下再收子選單，讓斜著滑進 flyout 的手勢過得去
                  hoverTimer.current = window.setTimeout(() => setOpenChild(null), HOVER_INTENT_MS * 2);
                }
              }}
              onClick={() => activate(i)}
              className={`w-full flex items-center gap-2 px-3 h-7 text-left disabled:opacity-40 disabled:pointer-events-none ${
                it.danger ? "text-danger hover:bg-danger/12" : "text-fg/85 hover:bg-accent/15"
              } ${it.muted ? "opacity-45" : ""} ${hi === i && !it.disabled ? (it.danger ? "bg-danger/12" : "bg-accent/15") : ""}`}
            >
              <span className="w-4 grid place-items-center text-fg/60">
                {it.checked ? <span className="text-accent">✓</span> : it.icon ? <Icon icon={it.icon} size={14} /> : null}
              </span>
              <span className="flex-1 truncate">{it.label}</span>
              {it.shortcut && !it.children && <span className="mono text-[11px] text-fg/35 ml-4">{it.shortcut}</span>}
              {it.children && <ChevronRight size={13} className="text-fg/40 ml-3" aria-hidden />}
            </button>
          ),
        )}
      </div>
      {openChild != null && childRect && (
        <Panel
          items={childItems}
          onClose={onClose}
          anchor={{ rect: childRect, side: "right" }}
          level={level + 1}
          autoFocus={subFocus}
          onCloseSub={() => {
            setOpenChild(null);
            itemRefs.current[openChild]?.focus();
          }}
        />
      )}
    </>
  );
}
