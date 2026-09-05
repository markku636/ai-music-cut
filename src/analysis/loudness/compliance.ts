// 交付前的響度守門：輸出完成後用 ffmpeg 回報的實測值判斷這個檔能不能直接上架。
// 平台會依 integrated loudness 自動調整增益，超標的 true peak 則會在轉檔時破音，所以兩個都要看。
export interface ComplianceInput {
  /** 成品實測整合響度（LUFS）。 */
  outputLufs: number | null;
  /** 成品實測 true peak（dBTP）。 */
  outputTp: number | null;
  targetLufs: number;
  /** 允許的 true peak 上限（dBTP，預設 −1.5）。 */
  truePeakDbtp?: number;
  /** loudnorm 回報的模式：linear = 只做增益、dynamic = 動態壓縮（音樂通常不希望）。 */
  normalizationType?: string | null;
}

export type ComplianceLevel = "ok" | "warn" | "fail";

export interface ComplianceCheck {
  level: ComplianceLevel;
  label: string;
  detail: string;
}

export interface ComplianceReport {
  level: ComplianceLevel;
  checks: ComplianceCheck[];
  summary: string;
}

/** 整合響度容許誤差（LU）：±0.5 內視為達標，±1.5 內只警告。 */
export const LUFS_OK = 0.5;
export const LUFS_WARN = 1.5;

export function checkCompliance(i: ComplianceInput): ComplianceReport {
  const ceiling = i.truePeakDbtp ?? -1.5;
  const checks: ComplianceCheck[] = [];

  if (i.outputLufs == null) {
    checks.push({ level: "warn", label: "整合響度", detail: "沒有量到（ffmpeg 未回報）" });
  } else {
    const d = i.outputLufs - i.targetLufs;
    const ad = Math.abs(d);
    checks.push({
      level: ad <= LUFS_OK ? "ok" : ad <= LUFS_WARN ? "warn" : "fail",
      label: "整合響度",
      detail: `${i.outputLufs.toFixed(1)} LUFS（目標 ${i.targetLufs}，差 ${d >= 0 ? "+" : ""}${d.toFixed(1)} LU）`,
    });
  }

  if (i.outputTp == null) {
    checks.push({ level: "warn", label: "真實峰值", detail: "沒有量到" });
  } else {
    checks.push({
      level: i.outputTp <= ceiling + 0.05 ? "ok" : i.outputTp <= 0 ? "warn" : "fail",
      label: "真實峰值",
      detail: `${i.outputTp.toFixed(1)} dBTP（上限 ${ceiling}）`,
    });
  }

  if (i.normalizationType === "dynamic") {
    checks.push({
      level: "warn",
      label: "正規化模式",
      detail: "loudnorm 退回 dynamic（動態壓縮）：來源動態範圍超出設定，音樂可能被壓扁",
    });
  }

  const level: ComplianceLevel = checks.some((c) => c.level === "fail") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "ok";
  const summary =
    level === "ok"
      ? `響度與峰值都達標（${i.outputLufs?.toFixed(1) ?? "?"} LUFS / ${i.outputTp?.toFixed(1) ?? "?"} dBTP）`
      : level === "warn"
        ? `勉強可用，有 ${checks.filter((c) => c.level === "warn").length} 項要注意`
        : `未達標：${checks.filter((c) => c.level === "fail").map((c) => c.label).join("、")}`;
  return { level, checks, summary };
}
