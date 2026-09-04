import { Languages } from "lucide-react";
import Icon from "../ui/Icon";
import { LANGUAGES, useLang, useT, type Lang } from "../i18n";

export default function LanguageMenu({ compact }: { compact: boolean }) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  return (
    <label className="flex items-center gap-1.5 text-xs text-fg/60" title={t("語言")}>
      {!compact && <Icon icon={Languages} size={14} />}
      <select
        value={lang}
        onChange={(e) => void setLang(e.target.value as Lang)}
        aria-label={t("語言")}
        className="h-7 rounded-sm bg-inset border border-fg/10 text-xs px-1.5 text-fg/80 focus-visible:outline-2 focus-visible:outline-accent/60"
      >
        {LANGUAGES.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
