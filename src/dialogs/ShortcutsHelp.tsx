import { Keyboard } from "lucide-react";
import { Button, Modal } from "../ui/index";
import { useT } from "../i18n";

const ROWS: [string, string][] = [
  ["Space", "播放 / 暫停（有選取時：播放選取）"],
  ["V / S", "時間軸工具：定位 / 選取（拖曳選一段）"],
  ["Delete", "有選取：剪掉選取；否則拒絕選取的候選"],
  ["Z / Esc", "縮放到選取 / 清除選取"],
  ["Home / End", "跳到開頭 / 結尾"],
  ["J / K / L", "倒退 5 秒 / 暫停 / 播放（重複按 L 切換速率）"],
  ["← / →", "±1 秒（Shift：±5 秒）"],
  ["[ / ]", "上一個 / 下一個候選"],
  ["A / R", "接受 / 拒絕選取的候選"],
  ["P", "預聽選取的候選（前後各 1 秒）"],
  ["Ctrl+Z / Ctrl+Y", "復原 / 重做"],
  ["Ctrl+O / Ctrl+S", "開啟音檔 / 儲存專案"],
  ["Ctrl+= / Ctrl+- / Ctrl+0", "時間軸縮放 / 適配"],
  ["Ctrl+滾輪 / 滾輪", "以游標為中心縮放 / 放大後水平捲動"],
  ["雙擊波形上的色塊", "剪 ↔ 不剪；拖色塊邊緣可調整範圍"],
  ["Shift+點逐字稿的字", "從上一個點的字選到這個字"],
  ["F1", "本說明"],
];

export default function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Modal open onClose={onClose} title={t("快捷鍵")} icon={Keyboard} size="sm" footer={<Button variant="primary" onClick={onClose}>{t("關閉")}</Button>}>
      <table className="w-full text-sm">
        <tbody>
          {ROWS.map(([k, v]) => (
            <tr key={k} className="border-b border-fg/5">
              <td className="py-1.5 pr-3 mono text-fg/80 whitespace-nowrap">{k}</td>
              <td className="py-1.5 text-fg/60">{t(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
