// 輸出前的檢查清單（Auphonic / Hindenburg 交件前擋一下的那一層）。
//
// 這個 App 的驗收都在**輸出之後**：ASR 逐字比對、接點稽核、響度量測。那一層很有用，
// 但它要先花三分鐘編碼完才告訴你「你有 12 筆候選還沒決定」——
// 那些問題在按下輸出**之前**就看得出來。
//
// 三個原則：
// - **只講看得出來的事實**，不猜意圖。「剪掉了 38%」是事實，「你剪太多了」不是。
// - **除了會產出壞檔案的那一種，一律不擋**。剪輯的人常常就是要輸出一個半成品去聽，
//   跳出來擋住是最惹人厭的一種貼心。
// - **每一條都要能指向下一步**，不然它只是罵人。

import type { QcSummary } from "./audioQc";

export type PreflightSeverity = "blocker" | "warning" | "note";

/** UI 可以接的下一步。純函式不知道要怎麼做，只說「該去哪」。 */
export type PreflightAction = "review" | "conflicts" | "todos" | "chapters" | "duck" | "stems" | "listen";

export interface PreflightFinding {
  id: string;
  severity: PreflightSeverity;
  /** 一行講完的事實。 */
  title: string;
  /** 為什麼要在意。 */
  detail?: string;
  action?: PreflightAction;
  /** action = "listen" 時要跳到的來源時間。 */
  atMs?: number;
}

export interface PreflightContext {
  /** 還沒決定的候選數。 */
  pending: number;
  /** 兩個 agent 意見相反、等人裁決的數量。 */
  conflicts: number;
  /** 未完成的待辦數。 */
  openTodos: number;
  /** 章節標記數。 */
  chapters: number;
  /** 來源長度（ms）。 */
  srcMs: number;
  /** 成品長度（ms）。 */
  outMs: number;
  /** 配樂 / 音效片段數。 */
  overlays: number;
  /** 有配樂但沒有閃避控制點的片段數。 */
  musicWithoutDuck: number;
  /** 使用者勾了分軌輸出。 */
  stems: boolean;
  /** 這一集有沒有逐字稿（沒有的話很多檢查沒有意義）。 */
  hasTranscript: boolean;
  /**
   * 聲音體檢（analysis/audioQc.ts）。逐字稿看不出來的那些毛病。
   *
   * 沒有本機分析時是 undefined —— 那跟「掃過了、很乾淨」是兩回事，
   * 所以不能用零值代替，不然會變成「沒檢查」被講成「沒問題」。
   */
  qc?: QcSummary;
  /** 各挑一個代表位置，讓使用者點下去直接聽（來源時間）。 */
  qcAt?: { clipping?: number; levelJump?: number; deadAir?: number };
}

/** 剪掉超過這個比例就提一下 —— 只是事實，不是判斷。 */
export const CUT_RATIO_NOTE = 0.3;

/**
 * 比例的浮點容差。`1 - (src * 0.7) / src` 會算出 0.30000000000000004，
 * 剛好剪掉三成的專案就會被提醒一次 —— 使用者看到的是「門檻明明沒過卻跳出來」。
 */
const RATIO_EPS = 1e-9;

/**
 * 跑一遍檢查。回傳的順序就是畫面上的順序：擋下的、警告、提醒。
 * 同一級之內依「使用者多可能想處理它」排。
 */
export function preflight(ctx: PreflightContext): PreflightFinding[] {
  const out: PreflightFinding[] = [];

  // --- 會產出壞檔案的 ---
  if (ctx.outMs <= 0) {
    out.push({
      id: "empty",
      severity: "blocker",
      title: "成品長度是 0",
      detail: "所有東西都被剪掉了。先還原一些決策再輸出。",
      action: "review",
    });
  }

  // --- 很可能不是你要的 ---
  if (ctx.conflicts > 0) {
    out.push({
      id: "conflicts",
      severity: "warning",
      title: `${ctx.conflicts} 筆剪輯與審核意見相反`,
      detail: "兩個 agent 對這幾刀看法不同，所以留給你裁決。輸出的話會照剪輯那邊走。",
      action: "conflicts",
    });
  }
  if (ctx.pending > 0) {
    out.push({
      id: "pending",
      severity: "warning",
      title: `${ctx.pending} 筆候選還沒決定`,
      detail: "沒決定的一律**不剪**。這通常是對的，但如果你以為它們會被剪掉就不是。",
      action: "review",
    });
  }
  if (ctx.openTodos > 0) {
    out.push({
      id: "todos",
      severity: "warning",
      title: `${ctx.openTodos} 個待辦還沒完成`,
      detail: "你自己標記的「這裡要處理」。",
      action: "todos",
    });
  }

  // --- 提醒 ---
  if (ctx.stems && ctx.overlays === 0) {
    out.push({
      id: "stems-empty",
      severity: "note",
      title: "勾了分軌但這一集沒有配樂 / 音效",
      detail: "分軌會只輸出完整混音，沒有東西可以拆。",
      action: "stems",
    });
  }
  if (ctx.musicWithoutDuck > 0) {
    out.push({
      id: "duck",
      severity: "note",
      title: `${ctx.musicWithoutDuck} 段配樂沒有做人聲閃避`,
      detail: "整段固定音量的話，講話時音樂會一直頂著。右鍵配樂可以自動算閃避。",
      action: "duck",
    });
  }
  if (ctx.hasTranscript && ctx.chapters === 0) {
    out.push({
      id: "chapters",
      severity: "note",
      title: "沒有章節",
      detail: "章節會寫進 mp3 / m4a，Apple Podcasts 與 Spotify 讀得到。節目筆記可以一鍵產。",
      action: "chapters",
    });
  }
  // --- 聲音本身（逐字稿看不出來的） ---
  const qc = ctx.qc;
  if (qc) {
    if (qc.clipping > 0) {
      out.push({
        id: "qc-clipping",
        severity: "warning",
        title: `${qc.clipping} 處波形打到滿刻度（共 ${Math.round(qc.clippingMs)} ms）`,
        // 只講量到的事實：桶化過的峰值資料證明不了「確定削波」，但打到頂就是打到頂。
        detail: "前級或錄音介面開太大時會這樣，聽起來是破音。修聲救不回來，通常要請對方重錄那一段或接受它。",
        action: "listen",
        atMs: ctx.qcAt?.clipping,
      });
    }
    if (qc.levelJumps > 0) {
      out.push({
        id: "qc-jump",
        severity: "warning",
        title: `${qc.levelJumps} 處音量突然變化（最大 ${Math.abs(qc.maxJumpLu).toFixed(1)} LU）`,
        detail: "麥克風被撞到、有人換了位置，或某一段被單獨調過。輸出的響度正規化是整集一個增益，救不了段落之間的落差。",
        action: "listen",
        atMs: ctx.qcAt?.levelJump,
      });
    }
    if (Math.abs(qc.dcPercent) > 0) {
      out.push({
        id: "qc-dc",
        severity: "note",
        title: `直流偏移約 ${Math.abs(qc.dcPercent).toFixed(1)}%`,
        detail: "波形的中線不在零。聽不出來，但會吃掉動態餘裕、讓剪接點容易爆音。修聲的高通濾波（去隆隆聲）順便會把它處理掉。",
        action: "duck",
      });
    }
    if (qc.deadAir > 0) {
      out.push({
        id: "qc-dead-air",
        severity: "note",
        title: `成品裡有 ${qc.deadAir} 段長空白（最長 ${(qc.longestDeadAirMs / 1000).toFixed(1)} 秒）`,
        detail: "剪完之後還留著的無聲段落。有時候是刻意的停頓，有時候是漏剪。",
        action: "listen",
        atMs: ctx.qcAt?.deadAir,
      });
    }
  }

  const ratio = ctx.srcMs > 0 ? 1 - ctx.outMs / ctx.srcMs : 0;
  if (ratio > CUT_RATIO_NOTE + RATIO_EPS) {
    out.push({
      id: "cut-ratio",
      severity: "note",
      title: `剪掉了 ${Math.round(ratio * 100)}%`,
      detail: "只是告訴你數字。粗剪剪掉三成很正常，但如果你沒預期到就值得先聽一遍。",
      action: "review",
    });
  }

  return out;
}

/** 有沒有會擋住輸出的問題。 */
export function hasBlocker(findings: PreflightFinding[]): boolean {
  return findings.some((f) => f.severity === "blocker");
}

export interface PreflightSummary {
  blockers: number;
  warnings: number;
  notes: number;
}

export function summarize(findings: PreflightFinding[]): PreflightSummary {
  return {
    blockers: findings.filter((f) => f.severity === "blocker").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    notes: findings.filter((f) => f.severity === "note").length,
  };
}
