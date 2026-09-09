// 片頭 / 片尾音樂放在成品的哪裡，以及那會造成什麼。
//
// 片頭很簡單：從 0 開始。片尾是 `成品長度 − 音樂長度`，讓音樂**收在節目結束的那一刻**。
//
// 會咬人的是「音樂比節目還長」：相減是負的，夾成 0 之後音樂從頭蓋到尾 ——
// 使用者選的是「片尾」，拿到的是一整集的墊樂，而且沒有任何提示。
// 30 秒的試剪配上一首 3 分鐘的歌就會踩到，那正是第一次用的人會做的事。
//
// 這裡不替使用者決定要怎麼辦（截斷音樂？往後推？都各有道理），
// 只把「會放在哪、蓋住多少、成品會變多長」算清楚，讓對話框在按下去**之前**講出來。

export type BedWhere = "intro" | "outro";

export interface BedPlacement {
  /** 成品時間軸上的起訖。終點可能超過節目長度 —— 那時候成品會跟著變長。 */
  outStartMs: number;
  outEndMs: number;
  /** 成品會因此變長多久（0 = 不會）。 */
  extendsOutputMs: number;
  /** 蓋住節目多少比例（0..1）。1 = 從頭蓋到尾。 */
  coverage: number;
  /** 音樂比節目還長。片尾會被夾到 0，變成整集的墊樂。 */
  longerThanEpisode: boolean;
}

export function placeBed(where: BedWhere, bedDurMs: number, outLenMs: number): BedPlacement {
  const bed = Math.max(0, bedDurMs);
  const out = Math.max(0, outLenMs);
  const longerThanEpisode = bed > out && out > 0;
  const outStartMs = where === "intro" ? 0 : Math.max(0, Math.round(out - bed));
  const outEndMs = outStartMs + bed;
  const overlap = Math.max(0, Math.min(outEndMs, out) - Math.min(outStartMs, out));
  return {
    outStartMs,
    outEndMs,
    extendsOutputMs: Math.max(0, outEndMs - out),
    coverage: out > 0 ? Math.min(1, overlap / out) : 0,
    longerThanEpisode,
  };
}
