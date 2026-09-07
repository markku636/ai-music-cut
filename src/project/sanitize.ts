// 專案檔裡 `analysis` 那一段的防禦性解析。
//
// `parseProjectFile` 把 media 與 settings 驗得很仔細，但 `analysis` 是**直接 cast**
// 過去的：剪輯決策、切點、標記、效果、配樂全在裡面，而它們會原封不動進到 store。
//
// 那些資料不是只有本機產生的：專案檔會在機器之間複製、會被手改、會被不同版本的 App
// 寫過。壞掉的欄位進了 store 之後，症狀出現的地方離原因很遠 ——
// `splits: [{ ms: "abc" }]` 不會當場報錯，而是讓 EDL 算出 NaN 的時間，
// 於是整條時間軸靜靜地壞掉，看起來像波形壞了。
//
// **壞掉的條目丟掉，不要整份拒絕開啟。** 少一個標記是可以接受的；因為一個壞欄位就
// 打不開整個專案不行 —— 那是使用者一整集的工作。丟掉幾筆會回報數量，讓人知道發生過。

import { CLEANUP_OFF, normalizeCleanup, type CleanupSpec } from "../analysis/cleanup";
import type { AudioEffect, EffectKind } from "../analysis/effects";
import type { Overlay, OverlayLane } from "../analysis/overlays";
import { parseSpeakerState, type SpeakerState } from "../analysis/speakers";
import type { Candidate, Decision, DecisionMap, DecisionState, Marker, MarkerKind, SplitPoint } from "../analysis/types";

const EFFECT_KINDS: readonly EffectKind[] = ["mute", "gain", "fade_in", "fade_out"];
const MARKER_KINDS: readonly MarkerKind[] = ["standard", "chapter", "todo"];
const DECISION_STATES: readonly DecisionState[] = ["auto", "accepted", "rejected", "pending"];
const LANES: readonly OverlayLane[] = ["music", "sfx"];

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function fin(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function str(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
/** 時間區間：兩端都要是有限數，而且結尾要在起點之後。 */
function span(o: Record<string, unknown>, a = "startMs", b = "endMs"): boolean {
  return fin(o[a]) && fin(o[b]) && (o[b] as number) > (o[a] as number);
}

export interface SanitizeReport {
  /** 每一類丟掉幾筆。全 0 表示這份檔案是乾淨的。 */
  dropped: Record<string, number>;
  total: number;
}

export function emptyReport(): SanitizeReport {
  return { dropped: {}, total: 0 };
}

function drop(r: SanitizeReport, key: string, n = 1): void {
  if (n <= 0) return;
  r.dropped[key] = (r.dropped[key] ?? 0) + n;
  r.total += n;
}

export function sanitizeCandidates(v: unknown, r: SanitizeReport): Candidate[] {
  if (!Array.isArray(v)) {
    drop(r, "candidates", v == null ? 0 : 1);
    return [];
  }
  const out: Candidate[] = [];
  for (const x of v) {
    const o = rec(x);
    if (!o || !str(o.id) || !str(o.kind) || !span(o) || !Array.isArray(o.wordIds)) {
      drop(r, "candidates");
      continue;
    }
    out.push(x as Candidate);
  }
  return out;
}

/** 決策表的鍵是候選 id；指不到任何候選的鍵會讓「還有幾筆待決」永遠算不對。 */
export function sanitizeDecisions(v: unknown, known: Set<string>, r: SanitizeReport): DecisionMap {
  const o = rec(v);
  if (!o) {
    drop(r, "decisions", v == null ? 0 : 1);
    return {};
  }
  const out: DecisionMap = {};
  for (const [k, d] of Object.entries(o)) {
    const dd = rec(d);
    if (!dd || !DECISION_STATES.includes(dd.state as DecisionState) || !known.has(k)) {
      drop(r, "decisions");
      continue;
    }
    out[k] = d as Decision;
  }
  return out;
}

export function sanitizeEffects(v: unknown, r: SanitizeReport): AudioEffect[] {
  if (!Array.isArray(v)) {
    drop(r, "effects", v == null ? 0 : 1);
    return [];
  }
  const out: AudioEffect[] = [];
  for (const x of v) {
    const o = rec(x);
    if (!o || !str(o.id) || !EFFECT_KINDS.includes(o.kind as EffectKind) || !span(o)) {
      drop(r, "effects");
      continue;
    }
    // gain 的 db 壞掉就當 0（靜靜套一個 NaN 增益會讓整段變成無聲）
    out.push({ ...(x as AudioEffect), db: fin(o.db) ? (o.db as number) : undefined });
  }
  return out;
}

export function sanitizeSplits(v: unknown, r: SanitizeReport): SplitPoint[] {
  if (!Array.isArray(v)) {
    drop(r, "splits", v == null ? 0 : 1);
    return [];
  }
  const out: SplitPoint[] = [];
  for (const x of v) {
    const o = rec(x);
    if (!o || !str(o.id) || !fin(o.ms) || (o.ms as number) < 0) {
      drop(r, "splits");
      continue;
    }
    out.push({ id: o.id as string, ms: o.ms as number, gapMs: fin(o.gapMs) && (o.gapMs as number) > 0 ? (o.gapMs as number) : undefined });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

export function sanitizeMarkers(v: unknown, r: SanitizeReport): Marker[] {
  if (!Array.isArray(v)) {
    drop(r, "markers", v == null ? 0 : 1);
    return [];
  }
  const out: Marker[] = [];
  for (const x of v) {
    const o = rec(x);
    if (!o || !str(o.id) || !fin(o.ms) || (o.ms as number) < 0 || !MARKER_KINDS.includes(o.kind as MarkerKind)) {
      drop(r, "markers");
      continue;
    }
    out.push({ ...(x as Marker), title: typeof o.title === "string" ? (o.title as string) : "" });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

export function sanitizeOverlays(v: unknown, r: SanitizeReport): Overlay[] {
  if (!Array.isArray(v)) {
    drop(r, "overlays", v == null ? 0 : 1);
    return [];
  }
  const out: Overlay[] = [];
  for (const x of v) {
    const o = rec(x);
    if (!o || !str(o.id) || !str(o.mediaId) || !LANES.includes(o.lane as OverlayLane)) {
      drop(r, "overlays");
      continue;
    }
    if (!fin(o.outStartMs) || !span(o, "srcInMs", "srcOutMs")) {
      drop(r, "overlays");
      continue;
    }
    const points = Array.isArray(o.points) ? o.points.filter((p) => { const q = rec(p); return q && fin(q.ms) && fin(q.db); }) : [];
    out.push({ ...(x as Overlay), gainDb: fin(o.gainDb) ? (o.gainDb as number) : 0, points } as Overlay);
  }
  return out;
}

export function sanitizeCleanup(v: unknown, r: SanitizeReport): CleanupSpec | undefined {
  if (v == null) return undefined;
  const o = rec(v);
  if (!o) {
    drop(r, "cleanup");
    return undefined;
  }
  // normalizeCleanup 本來就會夾住範圍；這裡只擋掉「根本不是物件」的情況
  return normalizeCleanup({ ...CLEANUP_OFF, ...(o as Partial<CleanupSpec>) });
}

export function sanitizeSpeakers(v: unknown, r: SanitizeReport): SpeakerState | undefined {
  if (v == null) return undefined;
  const s = parseSpeakerState(v);
  if (!s) {
    drop(r, "speakers");
    return undefined;
  }
  return s;
}
