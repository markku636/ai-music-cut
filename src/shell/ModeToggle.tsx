import { useT } from "../i18n";
import { useUi, type UiMode } from "../store/ui";
import { Segmented } from "../ui/index";

/** 簡易 / 專業切換。兩個殼的右上角都有一顆，切過去畫面整個換，但檔案、剪輯、選取都還在。 */
export default function ModeToggle() {
  const t = useT();
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);
  return (
    <div data-testid="mode-toggle">
      <Segmented<UiMode>
        size="sm"
        value={mode}
        onChange={setMode}
        ariaLabel={t("介面模式")}
        options={[
          { value: "simple", label: t("簡易"), title: t("簡易模式：右邊幾顆白話按鈕 + 右鍵，適合第一次用") },
          { value: "pro", label: t("專業"), title: t("專業模式：側欄、精準修剪、快捷鍵與命令面板") },
        ]}
      />
    </div>
  );
}
