import { Lightbulb } from "lucide-react";
import { useT } from "../i18n";
import { selectActiveMedia, useProject } from "../store/project";
import { useUi } from "../store/ui";
import Icon from "../ui/Icon";

const HINTS: Record<string, string[]> = {
  "simple.workspace": ["在波形上拖一段，再按右邊的按鈕，或按右鍵", "逐字稿裡劃線的字＝會被剪掉；雙擊可以還原", "做錯了按最上面的「復原」"],
};

/**
 * 首次提示：開第一個檔之後在面板底部出現一次，三句話，按「知道了」就永遠不再出現。
 * 沒有 overlay、沒有步驟導覽 —— 那種東西小白只會一路按下一步。
 */
export default function HintCard({ id }: { id: string }) {
  const t = useT();
  const active = useProject(selectActiveMedia);
  const seen = useUi((s) => s.hintsSeen.includes(id));
  const markHintSeen = useUi((s) => s.markHintSeen);
  const bullets = HINTS[id];
  if (!active || seen || !bullets) return null;
  return (
    <div className="mt-3 rounded-md border border-accent/30 bg-accent/5 p-3 text-[12px] leading-relaxed text-fg/75" data-testid={`hint-${id}`}>
      <div className="flex items-center gap-1.5 text-accent mb-1">
        <Icon icon={Lightbulb} size={14} />
        <span className="font-medium">{t("第一次用？")}</span>
      </div>
      <ul className="list-disc pl-4 space-y-0.5">
        {bullets.map((b) => (
          <li key={b}>{t(b)}</li>
        ))}
      </ul>
      <button type="button" onClick={() => markHintSeen(id)} className="mt-2 text-[11px] text-accent hover:underline">
        {t("知道了")}
      </button>
    </div>
  );
}
