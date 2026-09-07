// 輸出預設集（Premiere / Audition 的 Export Presets）。
//
// 每一集輸出前都要重複做同樣四個決定：格式、目標響度、要不要逐段平衡、要不要分軌。
// 實際上它們只有幾種固定組合 —— 平台規範是別人訂的，不是每次要想的東西。
//
// **內建的不存進設定檔**：只存使用者自己另存的那幾個。全部存下來的話，
// 之後平台改了規範（Spotify 從 −14 改掉之類）、或我們修正了某個內建值，
// 舊使用者會被凍在舊版本而且完全無感 —— 跟提示詞覆寫、贅字詞表同一個道理。

import type { RenderFormat } from "../pipeline/render";

export interface ExportPreset {
  id: string;
  label: string;
  format: RenderFormat;
  targetLufs: number;
  /** 逐段音量平衡。 */
  leveling: boolean;
  /** 同時輸出分軌（沒有 overlay 時這個選項本來就不會生效）。 */
  stems: boolean;
  /** 內建的（不可刪、不進設定檔）。 */
  builtin?: boolean;
  /** 為什麼是這些值 —— 使用者要判斷該選哪一個。 */
  note?: string;
}

/**
 * 內建預設。數字是平台自己公布的規範，不是我們調出來的。
 * 真實峰值一律 −1.5 dBTP（見 render.ts），所以預設裡不放。
 */
export const BUILTIN_PRESETS: ExportPreset[] = [
  {
    id: "podcast",
    label: "Podcast（Apple / Spotify 播客）",
    format: "mp3",
    targetLufs: -16,
    leveling: true,
    stems: false,
    builtin: true,
    note: "立體聲 podcast 的通用值。單聲道節目改用 −19。",
  },
  {
    id: "music-platform",
    label: "音樂平台（Spotify / YouTube）",
    format: "mp3",
    targetLufs: -14,
    leveling: false,
    stems: false,
    builtin: true,
    note: "串流平台會自己正規化到 −14；逐段平衡關掉，音樂的動態要留著。",
  },
  {
    id: "broadcast",
    label: "廣播（EBU R128）",
    format: "wav",
    targetLufs: -23,
    leveling: true,
    stems: false,
    builtin: true,
    note: "電台與電視的交件規範。用 wav 是因為交件通常不收失真壓縮。",
  },
  {
    id: "editorial",
    label: "交給剪接（分軌 wav）",
    format: "wav",
    targetLufs: -16,
    leveling: true,
    stems: true,
    builtin: true,
    note: "人聲一軌、每個角色各一軌，讓影片端自己決定音樂多大聲。",
  },
];

/** 預設集的可比較部分 —— 用來判斷目前的設定跟哪一個預設一致。 */
export type PresetShape = Pick<ExportPreset, "format" | "targetLufs" | "leveling" | "stems">;

export function sameShape(a: PresetShape, b: PresetShape): boolean {
  return a.format === b.format && a.targetLufs === b.targetLufs && a.leveling === b.leveling && a.stems === b.stems;
}

/**
 * 目前的設定對應哪一個預設（找不到回 null＝「自訂」）。
 * 內建的優先：使用者另存了一個跟內建一模一樣的，顯示內建的名字比較不會混淆。
 */
export function matchPreset(cur: PresetShape, user: ExportPreset[]): ExportPreset | null {
  return BUILTIN_PRESETS.find((p) => sameShape(p, cur)) ?? user.find((p) => sameShape(p, cur)) ?? null;
}

/** 內建 + 使用者的，內建排前面。 */
export function allPresets(user: ExportPreset[]): ExportPreset[] {
  return [...BUILTIN_PRESETS, ...user];
}

/** 從名稱做一個穩定的 id；撞名時加序號，不會蓋掉別人。 */
export function presetId(label: string, existing: ExportPreset[]): string {
  const base = label.trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").toLowerCase() || "preset";
  if (!existing.some((p) => p.id === base)) return base;
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}`;
    if (!existing.some((p) => p.id === cand)) return cand;
  }
}

/**
 * 另存一個使用者預設。同名的就覆蓋（使用者按第二次「另存」通常是想改掉它）。
 * 內建的名稱不能被佔用 —— 不然清單裡會有兩個「Podcast」。
 */
export function saveUserPreset(user: ExportPreset[], label: string, shape: PresetShape): ExportPreset[] {
  const name = label.trim();
  if (!name) return user;
  if (BUILTIN_PRESETS.some((p) => p.label === name)) return user;
  const existing = user.find((p) => p.label === name);
  if (existing) return user.map((p) => (p.label === name ? { ...p, ...shape } : p));
  return [...user, { id: presetId(name, allPresets(user)), label: name, ...shape }];
}

export function removeUserPreset(user: ExportPreset[], id: string): ExportPreset[] {
  return user.filter((p) => p.id !== id);
}

/** 從設定檔讀回來時擋掉壞資料 —— 手改過的設定檔不該讓輸出對話框整個掛掉。 */
export function parseUserPresets(raw: unknown): ExportPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: ExportPreset[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const p = x as Partial<ExportPreset>;
    if (typeof p.id !== "string" || typeof p.label !== "string") continue;
    if (p.format !== "mp3" && p.format !== "m4a" && p.format !== "wav") continue;
    const lufs = typeof p.targetLufs === "number" ? p.targetLufs : (x as { target_lufs?: unknown }).target_lufs;
    if (typeof lufs !== "number" || !Number.isFinite(lufs)) continue;
    out.push({
      id: p.id,
      label: p.label,
      format: p.format,
      targetLufs: lufs,
      leveling: p.leveling !== false,
      stems: p.stems === true,
    });
  }
  return out;
}
