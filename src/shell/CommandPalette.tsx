import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { rank, type Searchable } from "../commands/fuzzy";
import { GROUP_LABEL, commandLabel } from "../commands/menuModel";
import { allCommands, onSurface, runCommandObject, useCommandTick } from "../commands/registry";
import { formatShortcut } from "../commands/shortcut";
import type { Command } from "../commands/types";
import { useT } from "../i18n";
import { useDialogs } from "../store/dialogs";
import Icon from "../ui/Icon";
import { Modal } from "../ui/index";

const RECENT_KEY = "aicut:paletteRecent";
const RECENT_MAX = 8;

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function pushRecent(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX)));
  } catch {
    /* ignore */
  }
}

interface Entry {
  key: string;
  cmd: Command;
  /** 子指令的父標題（「語言 › English」）。 */
  parent?: Command;
}

/**
 * 命令面板（Ctrl+K）。搜尋所有指令：翻譯後標題、繁中原文、關鍵字、快捷鍵都比。
 * 停用的指令照樣列出來（灰掉、右邊寫原因），Enter 下去會 toast 那句原因而不是沒反應。
 *
 * 用 ui/Modal：要它的 modal stack（Esc 只關最上層）、焦點陷阱與 modalCount（打字時字母快捷鍵靜音）。
 */
export default function CommandPalette({ onClose, query: initial = "" }: { onClose: () => void; query?: string }) {
  const t = useT();
  useCommandTick();
  const [q, setQ] = useState(initial);
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const c of allCommands()) {
      if (!onSurface(c, "palette") && !onSurface(c, "menu")) continue;
      if (c.children) {
        for (const k of c.children()) out.push({ key: k.id, cmd: k, parent: c });
      } else out.push({ key: c.id, cmd: c });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  const results = useMemo(() => {
    const items: Searchable[] = entries.map((e) => ({
      id: e.key,
      texts: [
        (e.parent ? `${commandLabel(e.parent)} › ` : "") + commandLabel(e.cmd),
        e.cmd.title,
        ...(e.cmd.keywords ?? []),
        ...(e.cmd.shortcuts ?? []).map(formatShortcut),
      ],
    }));
    const ranked = rank(q, items);
    const byKey = new Map(entries.map((e) => [e.key, e]));
    if (q.trim()) return ranked.map((r) => ({ e: byKey.get(r.id)!, ranges: r.field === 0 ? r.ranges : [] }));
    // 空查詢：最近用過的排前面
    const recent = readRecent();
    const order = new Map(recent.map((id, i) => [id, i]));
    return ranked
      .map((r) => ({ e: byKey.get(r.id)!, ranges: [] as [number, number][] }))
      .sort((a, b) => (order.get(a.e.key) ?? 999) - (order.get(b.e.key) ?? 999));
  }, [q, entries]);

  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const activate = (e: Entry) => {
    const en = e.cmd.enabled();
    if (!en.ok) {
      void runCommandObject(e.cmd, "palette"); // 會 toast 原因；面板留著
      return;
    }
    pushRecent(e.key);
    // 先關再跑：下一個對話框才會落在 modal stack 的最上層
    useDialogs.getState().close("palette");
    onClose();
    void runCommandObject(e.cmd, "palette");
  };

  return (
    <Modal open onClose={onClose} size="md" bodyClassName="" className="self-start mt-[10vh]">
      <div className="flex items-center gap-2 px-3 h-11 border-b border-fg/10">
        <Icon icon={Search} size={16} className="text-fg/40" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("輸入功能名稱…（例如「降噪」「輸出」「字幕」）")}
          data-testid="palette-input"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHi((h) => Math.min(results.length - 1, h + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((h) => Math.max(0, h - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const r = results[hi];
              if (r) activate(r.e);
            }
          }}
          className="flex-1 bg-transparent outline-none text-sm placeholder:text-fg/30"
        />
        <span className="mono text-[10px] text-fg/30">Esc</span>
      </div>
      <div ref={listRef} role="listbox" className="max-h-[50vh] overflow-auto py-1">
        {results.length === 0 && <div className="px-4 py-6 text-center text-xs text-fg/40">{t("沒有符合的功能")}</div>}
        {results.map((r, i) => {
          const en = r.e.cmd.enabled();
          const label = (r.e.parent ? `${commandLabel(r.e.parent)} › ` : "") + commandLabel(r.e.cmd);
          return (
            <button
              key={r.e.key}
              type="button"
              role="option"
              aria-selected={i === hi}
              data-i={i}
              data-cmd={r.e.key}
              onMouseEnter={() => setHi(i)}
              onClick={() => activate(r.e)}
              className={`w-full flex items-center gap-2.5 px-3 h-8 text-left text-[13px] ${i === hi ? "bg-accent/15" : ""} ${en.ok ? "text-fg/90" : "text-fg/40"}`}
            >
              <span className="w-4 grid place-items-center text-fg/50">{r.e.cmd.icon && <Icon icon={r.e.cmd.icon} size={14} />}</span>
              <span className="flex-1 truncate">
                <Highlight text={label} ranges={r.ranges} />
              </span>
              <span className="text-[10px] text-fg/35 uppercase tracking-wide shrink-0">{t(GROUP_LABEL[r.e.cmd.group])}</span>
              {en.ok ? (
                r.e.cmd.shortcuts?.length ? <span className="mono text-[11px] text-fg/35 shrink-0 w-24 text-right">{formatShortcut(r.e.cmd.shortcuts[0])}</span> : <span className="w-24 shrink-0" />
              ) : (
                <span className="text-[11px] text-warning/80 shrink-0 max-w-40 truncate" title={t(en.why)}>
                  {t(en.why)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

function Highlight({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (!ranges.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([a, b], i) => {
    if (a > pos) parts.push(text.slice(pos, a));
    parts.push(
      <mark key={i} className="bg-transparent text-accent font-semibold">
        {text.slice(a, b)}
      </mark>,
    );
    pos = b;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}
