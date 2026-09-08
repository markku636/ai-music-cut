import { FileAudio, FileJson, FolderOpen, Music, X } from "lucide-react";
import { MEDIA_EXTENSIONS, VIDEO_EXTENSIONS } from "../brand";
import { openMedia } from "../commands/appActions";
import { command, runCommand, useCommandTick } from "../commands/registry";
import { useT } from "../i18n";
import { baseName, kindOf, removeRecent } from "../project/recent";
import { openDialog } from "../store/dialogs";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useUi, type UiMode } from "../store/ui";
import { pickOpenFiles } from "../ui";
import Icon from "../ui/Icon";
import { Button } from "../ui/index";
import { START_CARDS } from "./startCards";

/**
 * 沒開檔時的畫面。簡易：問「你想做什麼？」的幾張卡片；專業：一句話 + 開檔鈕。
 * 兩邊都有拖放區與最近開啟。
 */
export default function StartScreen({ variant }: { variant: UiMode }) {
  const t = useT();
  useCommandTick();
  const simple = variant === "simple";
  const recent = useSettings((s) => s.s.recent_projects);
  const save = useSettings((s) => s.save);
  const dragOver = useUi((s) => s.dragOver);
  const setProfile = useUi((s) => s.setProfile);

  const pick = async (card?: (typeof START_CARDS)[number]) => {
    if (card) setProfile(card.profile);
    // 錄音不需要先開檔：直接開錄音對話框
    if (card?.id === "record" && card.after) {
      void runCommand(card.after, "startcard");
      return;
    }
    // 轉檔也不開進專案：選檔 → 直接帶進對話框（以前會先開進專案、再開一個空的轉檔框）
    if (card?.pickInto) {
      const list = await pickOpenFiles([
        { name: t("音訊 / 影片"), extensions: MEDIA_EXTENSIONS },
        { name: t("影片"), extensions: VIDEO_EXTENSIONS },
      ]);
      if (list.length) openDialog(card.pickInto, { paths: list });
      return;
    }
    const before = useProject.getState().activeMediaId;
    await openMedia();
    const after = useProject.getState().activeMediaId;
    if (card?.after && after && after !== before) void runCommand(card.after, "startcard");
  };

  const cards = START_CARDS.filter((c) => !c.requires || command(c.requires));

  return (
    <div className={`flex-1 min-h-0 overflow-auto p-6 flex flex-col items-center justify-center gap-6 transition-colors ${dragOver ? "bg-accent/10" : ""}`} data-testid="start-screen">
      <div className="w-full max-w-3xl space-y-5">
        <div className={`rounded-lg border-2 border-dashed p-6 text-center ${dragOver ? "border-accent bg-accent/10" : "border-fg/15"}`}>
          <div className="flex items-center justify-center gap-2 text-fg/60 text-sm">
            <Icon icon={Music} size={18} />
            {t("把 mp3 / wav / m4a 拖進來，或按上方「開啟音檔」。")}
          </div>
          {!simple && (
            <div className="mt-3">
              <Button variant="primary" icon={FolderOpen} onClick={() => void pick()} data-cmd="file.open">
                {t("開啟音檔")}
              </Button>
            </div>
          )}
        </div>

        {simple && (
          <div>
            <div className="text-lg font-semibold text-fg/90 mb-3">{t("你想做什麼？")}</div>
            <div className="grid grid-cols-2 gap-3">
              {cards.map((c) => {
                const secondary = c.secondary && command(c.secondary.command) ? c.secondary : null;
                return (
                  // 外框是 div：卡片本體與下方的第二個動作（合併…）都是 button，button 不能套 button
                  <div key={c.id} className="flex flex-col rounded-lg border border-fg/10 bg-elevated hover:bg-fg/5 hover:border-accent/40 transition-colors">
                    <button
                      type="button"
                      data-card={c.id}
                      onClick={() => void pick(c)}
                      className="flex-1 text-left rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-accent/60"
                    >
                      <div className="flex items-center gap-2 text-fg/90 font-medium">
                        <Icon icon={c.icon} size={18} className="text-accent" />
                        {t(c.title)}
                      </div>
                      <div className="mt-1 text-[12px] text-fg/50 leading-relaxed">{t(c.line)}</div>
                    </button>
                    {secondary && (
                      <button
                        type="button"
                        data-card={`${c.id}-secondary`}
                        onClick={() => {
                          setProfile(c.profile);
                          void runCommand(secondary.command, "startcard");
                        }}
                        className="text-left px-4 pb-3 text-[12px] text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent/60"
                      >
                        {t(secondary.label)}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {recent.length > 0 && (
          <div>
            <div className="text-[11px] text-fg/40 uppercase tracking-wide mb-2">{t("最近開啟")}</div>
            <div className="rounded-md border border-fg/10 divide-y divide-fg/5 bg-elevated">
              {recent.map((p) => (
                <div key={p} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-fg/5 group">
                  <Icon icon={kindOf(p) === "project" ? FileJson : FileAudio} size={15} className="text-fg/50 shrink-0" />
                  <button type="button" onClick={() => void openMedia(p)} title={p} className="flex-1 min-w-0 text-left truncate text-fg/85 hover:text-accent">
                    {baseName(p)}
                  </button>
                  <button
                    type="button"
                    onClick={() => void save({ recent_projects: removeRecent(recent, p) })}
                    title={t("從清單移除")}
                    className="opacity-0 group-hover:opacity-100 text-fg/40 hover:text-fg/80"
                  >
                    <Icon icon={X} size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {!simple && <div className="text-[11px] text-fg/35">Ctrl+O {t("開啟音檔")} · Ctrl+K {t("搜尋指令")} · F1 {t("快捷鍵")}</div>}
      </div>
    </div>
  );
}
