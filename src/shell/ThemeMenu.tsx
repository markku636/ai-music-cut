import { Palette } from "lucide-react";
import Icon from "../ui/Icon";
import { useT } from "../i18n";
import { useTheme } from "../theme";
import { THEMES, type ThemeId } from "../themes";

export default function ThemeMenu({ compact }: { compact: boolean }) {
  const t = useT();
  const themeId = useTheme((s) => s.themeId);
  const setThemeId = useTheme((s) => s.setThemeId);
  return (
    <label className="flex items-center gap-1.5 text-xs text-fg/60" title={t("主題")}>
      {!compact && <Icon icon={Palette} size={14} />}
      <select
        value={themeId}
        onChange={(e) => setThemeId(e.target.value as ThemeId)}
        aria-label={t("主題")}
        className="h-7 rounded-sm bg-inset border border-fg/10 text-xs px-1.5 text-fg/80 focus-visible:outline-2 focus-visible:outline-accent/60"
      >
        {THEMES.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
    </label>
  );
}
