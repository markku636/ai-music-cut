// 配樂 / 音效的即時試聽。
//
// 沒有這一層的話，放了一段墊樂只能「輸出成品才聽得到」—— 那不叫剪輯，那叫猜。
//
// 做法：每個片段一個自己的 `<audio>`，跟著主聲軌的播放位置對時。三件事要注意：
//
// 1. **時間軸不一樣。** 主聲軌播的是**來源**時間（而且會跳過剪掉的段落），
//    墊樂的位置卻是釘在**成品**時間上。所以每一幀都要把主聲軌的來源時間換算成
//    成品時間，才知道墊樂現在該播到哪。
// 2. **不能每幀都 seek。** `currentTime = x` 會讓解碼器重新定位，逐幀寫入等於一直卡頓。
//    只有偏移超過 DRIFT_MS 才校正（跳播、拖曳播放線之後會發生）。
// 3. **這是監聽，不是成品。** 兩個 `<audio>` 不可能對到樣本；成品的精準混音在
//    Rust 那一趟（mix.rs）。這裡對到幾十毫秒就夠判斷「音樂進得太早 / 壓得不夠」。
import { envelopeGain, type Overlay } from "../analysis/overlays";
import { overlayRole } from "../analysis/roles";
import { EMPTY_MIX, isAudible, type RoleMix } from "./roleMix";

/** 偏移超過這麼多才校正。太小會一直 seek（卡頓），太大聽起來會鬆。 */
const DRIFT_MS = 90;

interface Voice {
  el: HTMLAudioElement;
  overlay: Overlay;
}

const voices = new Map<string, Voice>();
let srcOf: (mediaId: string) => string | null = () => null;

/** 由 App 提供 mediaId → 可播放 URL（Tauri 的 convertFileSrc）。 */
export function setOverlaySrcResolver(fn: (mediaId: string) => string | null) {
  srcOf = fn;
}

function ensureVoice(o: Overlay): Voice | null {
  const cur = voices.get(o.id);
  if (cur) {
    cur.overlay = o;
    return cur;
  }
  const url = srcOf(o.mediaId);
  if (!url) return null;
  const el = new Audio(url);
  el.preload = "auto";
  el.volume = 0;
  const v: Voice = { el, overlay: o };
  voices.set(o.id, v);
  return v;
}

function stopVoice(id: string) {
  const v = voices.get(id);
  if (!v) return;
  v.el.pause();
  v.el.src = "";
  voices.delete(id);
}

/** 全部停掉（切換媒體、暫停、卸載時）。 */
export function stopAllOverlays() {
  for (const id of [...voices.keys()]) stopVoice(id);
}

export interface MonitorState {
  /** 主聲軌目前的**成品**時間。 */
  outMs: number;
  playing: boolean;
  /** 主聲軌的播放速率（轉盤 / 變速時要跟著）。 */
  rate: number;
  /** 角色的獨奏 / 靜音（只影響監聽，不影響輸出）。 */
  mix?: RoleMix;
}

/**
 * 對一幀。回傳目前有幾個片段在發聲（測試 / 狀態列用）。
 *
 * 純粹以「主聲軌現在在成品的哪裡」驅動，所以跳播、拖曳、轉盤都不必特別處理 ——
 * 位置一變，下一幀就會校正回來。
 */
export function tickOverlays(overlays: Overlay[], st: MonitorState): number {
  const wanted = new Set<string>();
  let audible = 0;

  for (const o of overlays) {
    const len = Math.max(0, o.srcOutMs - o.srcInMs);
    const rel = st.outMs - o.outStartMs;
    if (len <= 0 || rel < -200 || rel > len) continue;
    wanted.add(o.id);
    const v = ensureVoice(o);
    if (!v) continue;

    // 被靜音 / 沒被獨奏的角色直接壓成 0；片段本身照樣對時，
    // 這樣切回來的當下就是對的位置，不會要等下一次校正
    const roleOn = isAudible(overlayRole(o), st.mix ?? EMPTY_MIX);
    const gain = rel < 0 || !roleOn ? 0 : envelopeGain(o, rel, len);
    v.el.volume = Math.min(1, Math.max(0, gain));
    if (gain > 0.0005) audible++;

    const wantSec = (o.srcInMs + Math.max(0, rel)) / 1000;
    if (!st.playing) {
      if (!v.el.paused) v.el.pause();
      // 暫停時也把位置對好，這樣按下播放不會先聽到上一次停住的地方
      if (Math.abs(v.el.currentTime - wantSec) * 1000 > DRIFT_MS) v.el.currentTime = wantSec;
      continue;
    }
    if (Math.abs(v.el.currentTime - wantSec) * 1000 > DRIFT_MS) v.el.currentTime = wantSec;
    if (v.el.playbackRate !== st.rate) v.el.playbackRate = st.rate;
    if (v.el.paused) void v.el.play().catch(() => {});
  }

  // 播過頭的片段要收掉，不然音樂會一直在背景跑
  for (const id of [...voices.keys()]) if (!wanted.has(id)) stopVoice(id);
  return audible;
}

/** 測試用。 */
export function __voiceCount(): number {
  return voices.size;
}
