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

export type PreflightSeverity = "blocker" | "warning" | "note";

/** UI 可以接的下一步。純函式不知道要怎麼做，只說「該去哪」。 */
export type PreflightAction = "review" | "conflicts" | "todos" | "chapters" | "duck" | "stems";

export interface PreflightFinding {
  id: string;
  severity: PreflightSeverity;
  /** 一行講完的事實。 */
  title: string;
  /** 為什麼要在意。 */
  detail?: string;
  action?: PreflightAction;
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
