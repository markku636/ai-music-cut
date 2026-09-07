import { useEffect, useRef, useState } from "react";
import { Headphones } from "lucide-react";
import { roleLabel, rolesInUse } from "../analysis/roles";
import { useT } from "../i18n";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useRoleMix } from "../store/roleMix";
import { IconButton } from "../ui/index";
import { describeMix, isAudible, isDefault, VOICE_ROLE } from "./roleMix";

/**
 * 角色監聽（獨奏 / 靜音）。
 *
 * 分軌檔案有了，但「音樂是不是壓過人聲」得當場切著聽才判斷得出來 ——
 * 不然要先輸出四個檔再拉進別的軟體，那個來回是整條路上最慢的一段。
 *
 * **只影響監聽，不影響輸出**，所以按鈕上會標出來；有動過任何開關時圖示會亮，
 * 不然「怎麼沒聲音」會變成一個很難查的問題。
 */
export default function RoleMixMenu() {
  const t = useT();
  const mediaId = useProject((s) => s.activeMediaId);
  const overlays = useDecisions((s) => (mediaId ? s.overlays[mediaId] : undefined));
  const mix = useRoleMix((s) => s.mix);
  const toggleMute = useRoleMix((s) => s.toggleMute);
  const toggleSolo = useRoleMix((s) => s.toggleSolo);
  const reset = useRoleMix((s) => s.reset);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const roles = rolesInUse(overlays ?? []);
  // 沒有配樂 / 音效時只有主聲軌一個角色，獨奏它沒有意義
  if (roles.length === 0) return null;

  const rows = [VOICE_ROLE, ...roles];
  const label = (r: string) => (r === VOICE_ROLE ? t("人聲") : t(roleLabel(r)));
  const summary = describeMix(mix, roles, label);

  return (
    <span ref={ref} className="relative flex items-center">
      <IconButton
        icon={Headphones}
        label={summary ? t("角色監聽：{s}", { s: summary }) : t("角色監聽（獨奏 / 靜音，只影響試聽）")}
        active={!isDefault(mix)}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="absolute bottom-8 right-0 z-30 w-56 rounded-md border border-fg/10 bg-bg p-1.5 text-[12px] shadow-lg">
          <div className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-fg/35">{t("角色監聽")}</div>
          {rows.map((r) => {
            const on = isAudible(r, mix);
            const soloed = mix.solo.includes(r);
            const muted = mix.muted.includes(r);
            return (
              <div key={r} className={`flex items-center gap-1 rounded-sm px-1.5 py-1 ${on ? "" : "opacity-45"}`}>
                <span className="min-w-0 flex-1 truncate">{label(r)}</span>
                <button
                  type="button"
                  title={t("獨奏")}
                  aria-pressed={soloed}
                  onClick={() => toggleSolo(r)}
                  className={`h-5 w-5 rounded-sm text-[10px] font-bold ${soloed ? "bg-accent/25 text-accent" : "text-fg/40 hover:bg-fg/10"}`}
                >
                  S
                </button>
                <button
                  type="button"
                  title={t("靜音")}
                  aria-pressed={muted}
                  onClick={() => toggleMute(r)}
                  className={`h-5 w-5 rounded-sm text-[10px] font-bold ${muted ? "bg-warning/25 text-warning" : "text-fg/40 hover:bg-fg/10"}`}
                >
                  M
                </button>
              </div>
            );
          })}
          <div className="mt-1 flex items-center gap-2 border-t border-fg/8 px-1.5 pt-1.5">
            <span className="text-[10px] leading-snug text-fg/40">{t("只影響試聽，輸出不受影響。")}</span>
            {!isDefault(mix) && (
              <button type="button" onClick={reset} className="ml-auto shrink-0 text-[11px] text-accent hover:underline">
                {t("全部恢復")}
              </button>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
