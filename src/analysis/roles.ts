// 角色（Final Cut 的 Audio Roles），用在分軌輸出上。
//
// 原本的分軌是寫死的兩類：人聲一軌、「配樂與音效」一軌。但 podcast 真正會分開的是
// 「開場曲 / 片尾曲 / 廣告口播 / 環境音」—— 拿到成品的人要換掉的通常正是廣告那一段，
// 而它跟片尾曲混在同一個檔案裡就換不掉了。
//
// **角色是自由字串，不是列舉**：內建幾個常用的，使用者可以自己打。存進 overlay 自己身上，
// 所以不需要另一份「角色清單」要同步 —— 用到哪些角色是從 overlays 推導出來的。
// 舊專案的 overlay 沒有 role，就用它所在的 lane 當角色（配樂 / 音效），讀舊檔不會壞。

import type { Overlay, OverlayLane } from "./overlays";

export interface RolePreset {
  id: string;
  label: string;
  /** 新增時預設放哪一條 lane。 */
  lane: OverlayLane;
}

/** 內建角色。順序就是選單順序：常用的在前面。 */
export const BUILTIN_ROLES: RolePreset[] = [
  { id: "music", label: "配樂", lane: "music" },
  { id: "sfx", label: "音效", lane: "sfx" },
  { id: "intro", label: "開場曲", lane: "music" },
  { id: "outro", label: "片尾曲", lane: "music" },
  { id: "ad", label: "廣告口播", lane: "music" },
  { id: "ambience", label: "環境音", lane: "sfx" },
];

/** overlay 的角色。沒設定就退回它所在的 lane —— 舊專案讀進來不會是空的。 */
export function overlayRole(o: Pick<Overlay, "lane"> & { role?: string }): string {
  const r = (o.role ?? "").trim();
  return r || o.lane;
}

export function roleLabel(id: string): string {
  return BUILTIN_ROLES.find((r) => r.id === id)?.label ?? id;
}

/**
 * 這個專案實際用到哪些角色，依 BUILTIN_ROLES 的順序排，自訂的排最後（字典序）。
 * 順序要穩定：分軌輸出的檔名與進度都跟著它跑，每次順序不同會很難對照。
 */
export function rolesInUse(overlays: (Pick<Overlay, "lane"> & { role?: string })[]): string[] {
  const set = new Set(overlays.map(overlayRole));
  const builtin = BUILTIN_ROLES.map((r) => r.id).filter((id) => set.has(id));
  const custom = [...set].filter((id) => !BUILTIN_ROLES.some((r) => r.id === id)).sort();
  return [...builtin, ...custom];
}

export interface StemSpec {
  /** 檔名後綴，也是進度顯示的鍵。 */
  id: string;
  kind: "full" | "voice" | "role";
  /** kind==="role" 時的角色 id。 */
  role?: string;
  label: string;
}

/**
 * 要輸出哪幾軌。
 *
 * 沒有任何 overlay 時只出完整混音 —— 硬生一個全靜音的 stem 沒有意義，
 * 而且還要多跑一趟 loudnorm。
 */
export function stemPlan(roles: string[]): StemSpec[] {
  if (roles.length === 0) return [{ id: "full", kind: "full", label: "完整混音" }];
  return [
    { id: "full", kind: "full", label: "完整混音" },
    { id: "voice", kind: "voice", label: "人聲" },
    ...roles.map((role) => ({ id: role, kind: "role" as const, role, label: roleLabel(role) })),
  ];
}

/** `a.mp3` + "intro" → `a_intro.mp3`。完整混音就是原檔名。 */
export function stemPath(outPath: string, id: string): string {
  if (id === "full") return outPath;
  // 角色是自由字串，可能有空白或路徑分隔符 —— 檔名裡一律換成底線
  const safe = id.replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "") || "stem";
  const i = outPath.lastIndexOf(".");
  return i <= 0 ? `${outPath}_${safe}` : `${outPath.slice(0, i)}_${safe}${outPath.slice(i)}`;
}
