import { Keyboard } from "lucide-react";
import { Button, Modal } from "../ui/index";
import { useT } from "../i18n";

const ROWS: [string, string][] = [
  ["Space", "播放 / 暫停（有選取時：播放選取）"],
  ["V / S / T", "時間軸工具：定位 / 選取 / 修剪（抓接縫左右推）"],
  ["B", "刀片：在播放線切一刀（同一位置再按一次＝移除切點）"],
  ["N", "吸附開關（接縫 / 標記 / 句界 / 字界 / 拍點）"],
  ["M / Shift+M / Alt+M", "下標記 / 下章節（會寫進成品檔案）/ 下待辦"],
  ["Alt+[ / Alt+]", "上一個 / 下一個標記"],
  ["Alt+Shift+[ / ]", "上一個 / 下一個換人處（多人節目）"],
  ["Delete", "有選取：剪掉選取；否則拒絕選取的候選"],
  ["Shift+Delete", "提起：留白靜音，不關洞（時間感不變）"],
  ["Z / Esc", "縮放到選取 / 清除選取"],
  ["Home / End", "跳到開頭 / 結尾"],
  ["J / K / L", "轉盤：倒退 / 停 / 前進，連按加速 1x → 2x → 4x（J 與 L 互相抵銷；按住 K 再點是 0.5x 慢速）"],
  ["I / O", "標入點 / 出點（Shift：跳到入點 / 出點；Alt+X 清除）"],
  ["← / →", "±1 秒（Shift：±5 秒；Alt：微調 ±10 ms，Alt+Shift：±1 ms）"],
  ["[ / ]", "上一個 / 下一個候選（精準修剪器開著時：上下一個接縫）"],
  ["A / R", "接受 / 拒絕選取的候選"],
  ["P", "預聽選取的候選（前後各 1 秒）"],
  ["Ctrl+Z / Ctrl+Y", "復原 / 重做"],
  ["Ctrl+A", "全選（整段變成時間選取）"],
  ["Ctrl+F", "在逐字稿裡找字（找到可整集一次剪掉）"],
  ["Ctrl+X", "剪下選取（放進剪貼簿並剪掉）"],
  ["Ctrl+C", "複製選取（不動剪輯）"],
  ["Ctrl+V", "貼到播放線"],
  ["Ctrl+Shift+V", "把選取搬到播放線（剪下 + 貼上）"],
  ["Shift+S", "滑過波形就聽得到（skimming）開關"],
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
