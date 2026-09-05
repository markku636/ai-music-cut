import { Scissors, ShieldQuestion } from "lucide-react";
import type { Decision } from "../analysis/types";
import { useT } from "../i18n";

const VERDICT_LABEL: Record<string, string> = { cut: "剪", keep: "留", unsure: "不確定" };
const VERDICT_CLASS: Record<string, string> = {
  cut: "text-kind-filler",
  keep: "text-success",
  unsure: "text-fg/45",
};

/**
 * 兩個 agent 的意見小標籤：`✂ 剪輯：剪`＋`⏸ 審核：留`。
 * 只在真的有意見時出現 —— 沒開審核的專案不該看到多餘的 UI。
 */
export default function OpinionChips({ decision }: { decision: Decision | undefined }) {
  const t = useT();
  const o = decision?.opinions;
  if (!o?.editor && !o?.reviewer) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
      {o.editor && (
        <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-xs bg-fg/5" title={o.editor.reason}>
          <Scissors size={9} className="opacity-60" />
          {t("剪輯")}：<span className={VERDICT_CLASS[o.editor.verdict]}>{t(VERDICT_LABEL[o.editor.verdict])}</span>
        </span>
      )}
      {o.reviewer && (
        <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-xs bg-fg/5" title={o.reviewer.reason}>
          <ShieldQuestion size={9} className="opacity-60" />
          {t("審核")}：<span className={VERDICT_CLASS[o.reviewer.verdict]}>{t(VERDICT_LABEL[o.reviewer.verdict])}</span>
        </span>
      )}
      {decision?.conflict && <span className="px-1 py-0.5 rounded-xs bg-warning/20 text-warning">{t("分歧")}</span>}
      {decision?.conflict && o.reviewer?.reason && <span className="text-warning/80">{o.reviewer.reason}</span>}
    </div>
  );
}
