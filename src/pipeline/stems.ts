// 分軌輸出（Final Cut 的 Roles → export stems）。
//
// 影片剪接的人要的是分開的軌：人聲一軌、配樂一軌，這樣他可以自己決定音樂在畫面
// 底下要多大聲，而不是拿到一個已經混死的檔案。
//
// **關鍵是三軌要用同一組響度量測。** 每一軌各自跑一次 loudnorm 的話，配樂 stem 會被
// 拉到跟人聲一樣大聲，各軌之間的相對音量就跟你核可的混音對不上了。所以先輸出完整混音、
// 拿到那一趟的量測值，再用同一組值輸出各軌。
//
// **不會逐樣本相加等於完整混音**：真實峰值限制器仍然是逐檔套用的，完整混音的峰值比
// 任何單軌都高，被壓的量也不一樣。這跟所有 DAW 的 stem 匯出一樣 —— stem 是給人重新
// 混音用的素材，不是母帶的代數分解。UI 上有講清楚，不要在這裡宣稱它會相加相等。
import type { LoudnormStats } from "../api";
import { stemPath, stemPlan, type StemSpec } from "../analysis/roles";
import { t } from "../i18n";
import { runRender, type RenderOptions } from "./render";

export interface StemResult {
  id: string;
  label: string;
  path: string;
}

export interface StemProgress {
  id: string;
  label: string;
  index: number;
  total: number;
}

/**
 * 輸出完整混音 + 各軌（依角色）。回傳實際產出的檔案。
 *
 * 沒有任何 overlay 時只會輸出完整混音 —— 硬生出一個全靜音的 stem 沒有意義，
 * 而且還要多跑一趟 loudnorm。
 */
export async function renderStems(
  mediaId: string,
  opts: RenderOptions,
  roles: string[],
  onStep?: (p: StemProgress) => void,
): Promise<StemResult[]> {
  const plan: StemSpec[] = stemPlan(roles);
  const out: StemResult[] = [];
  let measured: LoudnormStats | null = null;

  for (let i = 0; i < plan.length; i++) {
    const spec = plan[i];
    onStep?.({ id: spec.id, label: spec.label, index: i, total: plan.length });
    const done = await runRender(mediaId, {
      ...opts,
      outPath: stemPath(opts.outPath, spec.id),
      // 角色軌跟「配樂軌」一樣要把主聲軌靜音，差別只在留下哪些 overlays
      stem: spec.kind === "role" ? "music" : spec.kind,
      stemRole: spec.kind === "role" ? spec.role : null,
      // 第一趟（完整混音）自己量；之後沿用，各軌才加得回原本的混音
      loudnormMeasured: spec.kind === "full" ? null : measured,
    });
    if (!done.ok || !done.out_path) throw new Error(done.error ?? t("輸出失敗"));
    if (spec.kind === "full") measured = done.measured ?? null;
    out.push({ id: spec.id, label: spec.label, path: done.out_path });
  }
  return out;
}
