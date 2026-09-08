// 聲音體檢（audioQc）的發現 → 一鍵修：削波 → 去削波效果（前後各 100 ms）；直流偏移 → 整檔 DC 修正。
// 音量突變與長空白不是「效果」能修的（一個靠逐段平衡、一個是剪輯決策），這裡不碰。
import type { QcFinding } from "../audioQc";
import { effectId, type AudioEffect } from "../effects";

export const CLIP_PAD_MS = 100;

export interface RepairPlan {
  /** "clipping" | "dc_offset" */
  kind: "clipping" | "dc_offset";
  effects: AudioEffect[];
  label: string;
}

/** 相鄰 / 重疊的削波區段合併（各加 pad），一段一個 declip。 */
export function declipRanges(findings: readonly QcFinding[], durationMs: number, padMs = CLIP_PAD_MS): { startMs: number; endMs: number }[] {
  const ranges = findings
    .filter((f) => f.kind === "clipping")
    .map((f) => ({ startMs: Math.max(0, f.startMs - padMs), endMs: Math.min(durationMs, f.endMs + padMs) }))
    .sort((a, b) => a.startMs - b.startMs);
  const out: { startMs: number; endMs: number }[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ ...r });
  }
  return out.filter((r) => r.endMs - r.startMs >= 20);
}

export function repairsForQc(findings: readonly QcFinding[], durationMs: number): RepairPlan[] {
  const out: RepairPlan[] = [];
  const clips = declipRanges(findings, durationMs);
  if (clips.length) {
    const params = { threshold: 10 };
    out.push({
      kind: "clipping",
      effects: clips.map((r) => ({ id: effectId("declip", r.startMs, r.endMs, undefined, params), kind: "declip", startMs: r.startMs, endMs: r.endMs, params, origin: "qc" })),
      label: `修：去削波 ${clips.length} 處`,
    });
  }
  if (findings.some((f) => f.kind === "dc_offset") && durationMs > 0) {
    const params = { shift: 0 };
    out.push({
      kind: "dc_offset",
      effects: [{ id: effectId("dc", 0, durationMs, undefined, params), kind: "dc", startMs: 0, endMs: durationMs, params, origin: "qc" }],
      label: "修：DC 偏移",
    });
  }
  return out;
}

/** 這一類的修復是否已經在效果清單裡（避免重複加、也讓按鈕變成「已修」）。 */
export function alreadyRepaired(kind: RepairPlan["kind"], plan: RepairPlan | undefined, effects: readonly AudioEffect[]): boolean {
  if (!plan) return false;
  if (kind === "dc_offset") return effects.some((e) => e.kind === "dc");
  return plan.effects.every((p) => effects.some((e) => e.kind === "declip" && e.startMs <= p.startMs + 1 && e.endMs >= p.endMs - 1));
}
