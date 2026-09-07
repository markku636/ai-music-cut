// 範圍濾波的 A/B 試聽：對**來源檔**直接切一段做 dry / wet，不走 Cutter。
//
// runRender + rangeMs 會從 0 解到選取結尾（cut_to_wav 是單趟前向串流），第 50 分鐘的一段要等 20 秒；
// 這裡讓 Rust 對來源 `-ss/-t`，15 秒的段 < 1 秒。試聽的是「來源 + 這個效果」而不是「成品」，
// 對判斷「降噪要不要這麼多」已經夠了 —— 接點與配樂不會影響嘶聲聽起來怎樣。
import { api } from "../api";
import { FX_RANK, toRenderFx, type RenderRangeFx } from "../analysis/fx/regions";
import type { AudioEffect, RangeEffectKind } from "../analysis/effects";
import { abWindow } from "../effects/preview";
import { t } from "../i18n";
import { useProject } from "../store/project";
import type { TimeSelection } from "../store/timeline";

function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 把效果排成 Rust 要的鏈（依 rank）；引擎不支援的種類直接報錯，不默默少掉。 */
export function chainOf(effects: readonly AudioEffect[]): RenderRangeFx[] {
  const sorted = [...effects].sort((a, b) => FX_RANK[a.kind as RangeEffectKind] - FX_RANK[b.kind as RangeEffectKind]);
  const out: RenderRangeFx[] = [];
  for (const e of sorted) {
    const fx = toRenderFx(e);
    if (!fx) throw new Error(t("這個效果這個版本還不能試聽：{kind}", { kind: e.kind }));
    out.push(fx);
  }
  return out;
}

/** 這一組（來源、範圍、鏈）的快取鍵：內容一樣就命中同一對檔案。 */
export function fxPreviewKey(src: string, win: TimeSelection, chain: RenderRangeFx[]): string {
  return hash32(JSON.stringify([src, Math.round(win.startMs), Math.round(win.endMs), chain]));
}

export async function previewRangeEffects(mediaId: string, effects: readonly AudioEffect[], range: TimeSelection): Promise<{ dry: string; wet: string }> {
  const media = useProject.getState().media.find((m) => m.id === mediaId);
  if (!media) throw new Error(t("找不到媒體"));
  const chain = chainOf(effects);
  if (!chain.length) throw new Error(t("沒有可以試聽的內容"));
  const win = abWindow(range);
  const key = fxPreviewKey(media.fingerprint || media.path, win, chain);
  return api.fxPreview(media.path, media.fingerprint || media.id, win.startMs, win.endMs, chain, key);
}
