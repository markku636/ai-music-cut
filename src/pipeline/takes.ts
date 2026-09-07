// 替代 take 接到 App 狀態上：從逐字稿找出重錄的幾次嘗試，挑一個留下。
//
// 偵測本身是純函式（analysis/takes.ts）。這裡負責找資料、快取、以及把「留這一次」
// 翻譯成剪輯決策 —— 用 addManualCuts 合成**一次 commit**，
// 留一個 take 卻要按三次 Ctrl+Z 才收得回去是不合理的。
import { findTakes, cutsForKeeping, DEFAULT_TAKES, type TakeGroup } from "../analysis/takes";
import { useDecisions } from "../store/decisions";
import { useTranscript } from "../store/transcript";
import { formatMs } from "../time";

const cache = new Map<string, { key: unknown; groups: TakeGroup[] }>();

/** 這一集的替代 take。沒有逐字稿就回空陣列（不是錯誤 —— 還沒分析而已）。 */
export function takesFor(mediaId: string | null | undefined): TakeGroup[] {
  if (!mediaId) return [];
  const tr = useTranscript.getState().byMedia[mediaId];
  if (!tr) return [];
  const hit = cache.get(mediaId);
  if (hit && hit.key === tr) return hit.groups;
  const groups = findTakes(tr.sentences, tr.words, DEFAULT_TAKES);
  cache.set(mediaId, { key: tr, groups });
  return groups;
}

export function clearTakesCache(mediaId?: string): void {
  if (mediaId) cache.delete(mediaId);
  else cache.clear();
}

export interface KeepTakeResult {
  /** 剪掉了幾段。 */
  cut: number;
  /** 省下多少毫秒。 */
  savedMs: number;
}

/**
 * 留下第 keepIndex 次嘗試，其餘剪掉（一次 undo）。
 *
 * keepIndex 超出範圍時 `cutsForKeeping` 回空陣列 —— 什麼都不做，
 * 而不是把整組剪光。那是這個功能最糟的失敗模式。
 */
export function keepTake(mediaId: string, groupId: string, keepIndex: number): KeepTakeResult {
  const group = takesFor(mediaId).find((g) => g.id === groupId);
  if (!group) return { cut: 0, savedMs: 0 };
  const ranges = cutsForKeeping(group, keepIndex);
  if (!ranges.length) return { cut: 0, savedMs: 0 };

  const tr = useTranscript.getState().byMedia[mediaId];
  const cuts = ranges.map((r) => {
    const attempt = group.attempts.find((a) => a.startMs === r.startMs && a.endMs === r.endMs);
    const sentence = tr?.sentences.find((s) => s.id === attempt?.sentenceId);
    return {
      startMs: r.startMs,
      endMs: r.endMs,
      wordIds: sentence?.wordIds ?? [],
      sentenceId: sentence?.id ?? -1,
    };
  });

  const kept = group.attempts[keepIndex];
  const n = useDecisions
    .getState()
    .addManualCuts(
      mediaId,
      cuts,
      `重錄：留下第 ${keepIndex + 1} 次（${formatMs(kept.startMs, { millis: false })}）`,
      `替代 take：留第 ${keepIndex + 1} 次`,
    );
  return { cut: n, savedMs: ranges.reduce((s, r) => s + (r.endMs - r.startMs), 0) };
}
