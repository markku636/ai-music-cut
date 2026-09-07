import MenuPanel, { type MenuItem } from "../ui/MenuPanel";

export type { MenuItem } from "../ui/MenuPanel";

export interface WaveContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * 通用右鍵選單（fixed 定位，超出視窗自動往內收）。點外面 / Esc / 捲動關閉。
 * 本體在 ui/MenuPanel（子選單、鍵盤導覽都在那裡）；這裡只是保留原本的 {x, y} 介面。
 */
export default function WaveContextMenu({ x, y, items, onClose }: WaveContextMenuProps) {
  return <MenuPanel anchor={{ x, y }} items={items} onClose={onClose} />;
}
