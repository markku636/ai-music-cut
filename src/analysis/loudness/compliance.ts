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

/** 沒打到目標時，真正的原因。 */
export type MissCause = "headroom" | "too_loud" | "quiet" | null;

export interface MissExplanation {
  cause: MissCause;
  /** 差了幾 LU（負數＝偏小聲）。 */
  deltaLu: number;
  title: string;
  detail: string;
}

/** 峰值離上限這麼近就算「被上限擋住了」。 */
const AT_CEILING_DB = 0.3;

/**
 * 為什麼沒打到目標。
 *
 * 這件事一定要講出來，因為**最常見的原因不是 bug，是物理限制**：來源很小聲但峰值很尖
 * 的時候，要拉到目標響度就會超過真實峰值上限，loudnorm 只好少拉一點。這時候顯示
 * 「−17.3 LUFS」而不解釋，使用者會以為工具壞了，然後去改一個改不動的設定。
 *
 * 分得出來的依據：**輸出偏小聲、而且峰值就貼在上限上** → 是上限擋住的，不是沒拉。
 */
export function explainMiss(i: ComplianceInput): MissExplanation | null {
  if (i.outputLufs == null) return null;
  const ceiling = i.truePeakDbtp ?? -1.5;
  const delta = i.outputLufs - i.targetLufs;
  if (Math.abs(delta) <= LUFS_OK) return null;

  if (delta < 0 && i.outputTp != null && i.outputTp >= ceiling - AT_CEILING_DB) {
    return {
      cause: "headroom",
      deltaLu: delta,
      title: "被真實峰值上限擋住了，不是沒拉上去",
      detail: `再往上拉就會超過 ${ceiling} dBTP（目前 ${i.outputTp.toFixed(1)}）。這通常代表來源整體很小聲但有幾個很尖的峰 —— 下次錄音時把輸入增益調高、離麥近一點會比在後製硬拉好。也可以先修聲把突發雜音壓掉，峰值降下來就拉得動了。`,
    };
  }
  if (delta > 0) {
    return {
      cause: "too_loud",
      deltaLu: delta,
      title: "比目標大聲",
      detail: `平台會自動調降，聽感上不會更大聲，但動態會被壓掉一些。檢查一下配樂是不是太大聲。`,
    };
  }
  return {
    cause: "quiet",
    deltaLu: delta,
    title: "比目標小聲",
    detail: `峰值還有空間（${i.outputTp == null ? "沒量到" : `${i.outputTp.toFixed(1)} dBTP，上限 ${ceiling}`}），所以不是上限擋住的。可能是這一集大部分時間都很安靜，或逐段平衡被關掉了。`,
  };
}
