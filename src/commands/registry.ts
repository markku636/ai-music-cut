import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { t } from "../i18n";
import { chordKey, parseShortcut } from "./shortcut";
import type { Command, CommandGroup, Enabled, RunSource, Surface } from "./types";

/**
 * 指令註冊表。
 *
 * - 用 zustand store 存、以 id 為鍵：熱更新時 core.ts 會重跑一次 registerCommands，
 *   upsert 讓它冪等；用 module 陣列的話每次熱更新都會多一份。
 * - `runCommand` 是**唯一入口**：先問 enabled()，不行就 toast 出原因（同一句 1.5 秒內不重複），
 *   行就跑並接住例外。這一步把「不灰掉要解釋 / 不靜默失敗」做給所有表面。
 * - 這個檔案**不 import 任何 store 或 Tauri**，測試可以直接載。
 *   需要 store 的守門（先開檔 / 先分析…）在 guards.ts；toast 由 setCommandHost 注入。
 */

interface RegistryState {
  byId: Record<string, Command>;
  order: string[];
  version: number;
}

export const useCommands = create<RegistryState>(() => ({ byId: {}, order: [], version: 0 }));

export function registerCommands(list: Command[]): void {
  useCommands.setState((s) => {
    const byId = { ...s.byId };
    const order = s.order.slice();
    for (const c of list) {
      if (!byId[c.id]) order.push(c.id);
      byId[c.id] = c;
    }
    return { byId, order, version: s.version + 1 };
  });
}

/** 測試用：清空。 */
export function resetCommands(): void {
  useCommands.setState({ byId: {}, order: [], version: 0 });
}

export function command(id: string): Command | undefined {
  return useCommands.getState().byId[id];
}

export function allCommands(): Command[] {
  const s = useCommands.getState();
  return s.order.map((id) => s.byId[id]);
}

const DEFAULT_SURFACES: readonly Surface[] = ["menu", "palette"];

export function onSurface(c: Command, surface: Surface): boolean {
  return (c.surfaces ?? DEFAULT_SURFACES).includes(surface);
}

function pairRank(c: Command): number {
  return c.variant === "quick" ? 0 : c.variant === "dialog" ? 1 : 0;
}

/**
 * 某個群組在某個表面的指令，排序：section（首次出現順序）→ order → 同 pairId 的 quick 先於 dialog。
 * section 不用字串排序：那會把中文分段名打亂成看不出邏輯的順序。
 */
export function commandsIn(group: CommandGroup, surface?: Surface): Command[] {
  const list = allCommands().filter((c) => c.group === group && (!surface || onSurface(c, surface)));
  const sectionIndex = new Map<string, number>();
  for (const c of list) {
    const k = c.section ?? "";
    if (!sectionIndex.has(k)) sectionIndex.set(k, sectionIndex.size);
  }
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const sa = sectionIndex.get(a.c.section ?? "")!;
      const sb = sectionIndex.get(b.c.section ?? "")!;
      if (sa !== sb) return sa - sb;
      const oa = a.c.order ?? 0;
      const ob = b.c.order ?? 0;
      if (oa !== ob) return oa - ob;
      if (a.c.pairId && a.c.pairId === b.c.pairId) return pairRank(a.c) - pairRank(b.c);
      return a.i - b.i;
    })
    .map((x) => x.c);
}

/** 簡易面板的按鈕：有 simpleOrder 的、依格位排、最多 8 顆。 */
export function simplePanelCommands(): Command[] {
  return allCommands()
    .filter((c) => c.simple && c.simpleOrder != null)
    .sort((a, b) => (a.simpleOrder ?? 0) - (b.simpleOrder ?? 0))
    .slice(0, 8);
}

export function commandsWithShortcuts(): Command[] {
  return allCommands().filter((c) => c.shortcuts?.length);
}

/** 兩個指令綁到同一個 chord 是 bug（會雙擊發）。回傳衝突清單，測試用它守門。 */
export function duplicateChords(): { chord: string; ids: string[] }[] {
  const seen = new Map<string, string[]>();
  for (const c of allCommands()) {
    if (c.shortcutManual) continue;
    for (const s of c.shortcuts ?? []) {
      const k = chordKey(parseShortcut(s));
      const arr = seen.get(k) ?? [];
      arr.push(c.id);
      seen.set(k, arr);
    }
  }
  return [...seen.entries()].filter(([, ids]) => ids.length > 1).map(([chord, ids]) => ({ chord, ids }));
}

// ---- 執行 ----

export interface CommandHost {
  info: (text: string) => void;
  error: (text: string) => void;
  errMessage: (e: unknown) => string;
}

let host: CommandHost = {
  info: (m) => console.info(m),
  error: (m) => console.error(m),
  errMessage: (e) => (e instanceof Error ? e.message : String(e)),
};

export function setCommandHost(h: CommandHost): void {
  host = h;
}

const INFO_DEDUP_MS = 1500;
let lastInfo = { text: "", at: 0 };

function infoDedup(text: string) {
  const now = Date.now();
  if (lastInfo.text === text && now - lastInfo.at < INFO_DEDUP_MS) return;
  lastInfo = { text, at: now };
  host.info(text);
}

export interface RunResult {
  ran: boolean;
  why?: string;
}

/**
 * 執行指令。不能做 → toast 原因並回 {ran:false}；丟例外 → toast 錯誤。
 * `source` 只是記錄從哪個表面觸發的（之後量測 / 日誌用）。
 */
export async function runCommand(id: string, source: RunSource = "menu"): Promise<RunResult> {
  const c = command(id);
  if (!c) return { ran: false, why: "unknown" };
  return runCommandObject(c, source);
}

/** 直接拿 Command 物件執行（動態子指令 —— 最近開啟、語言、主題 —— 沒有登記在 byId）。 */
export async function runCommandObject(c: Command, _source: RunSource = "menu"): Promise<RunResult> {
  const en = c.enabled();
  if (!en.ok) {
    infoDedup(t(en.why));
    return { ran: false, why: en.why };
  }
  try {
    await c.run();
    return { ran: true };
  } catch (e) {
    host.error(host.errMessage(e));
    return { ran: false, why: "error" };
  }
}

// ---- 反應性 ----
//
// enabled() 讀的是各個 store 的 getState()，React 看不出相依。
// 用一個版本計數：guards.ts 訂閱那幾個 store，有變就 bump；畫指令的元件訂閱這個計數。
// 只有掛著的表面（工具列、開著的選單）會重算，代價是幾個 getState() 讀取。

const tickStore = create<{ n: number }>(() => ({ n: 0 }));

export function bumpCommandTick(): void {
  tickStore.setState((s) => ({ n: s.n + 1 }));
}

export function useCommandTick(): number {
  const tick = useSyncExternalStore(tickStore.subscribe, () => tickStore.getState().n, () => 0);
  const version = useSyncExternalStore(useCommands.subscribe, () => useCommands.getState().version, () => 0);
  return tick + version * 1_000_003;
}

export function useEnabled(c: Command | undefined): Enabled {
  useCommandTick();
  return c ? c.enabled() : { ok: false, why: "unknown" };
}

export const OK: Enabled = { ok: true };
