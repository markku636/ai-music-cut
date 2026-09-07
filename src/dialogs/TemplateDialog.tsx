import { useMemo, useState } from "react";
import { LayoutTemplate, Play, Trash2 } from "lucide-react";
import { applyTemplate, buildTemplate, parseTemplates, type ProjectTemplate } from "../analysis/template";
import { roleLabel, overlayRole } from "../analysis/roles";
import { Button, EmptyState, Input, Modal } from "../ui/index";
import { toast } from "../ui";
import { useT } from "../i18n";
import { useCleanup } from "../store/cleanup";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { formatMs } from "../time";

/**
 * 專案範本。
 *
 * 週更的節目每一集開頭都是同一首開場曲、結尾都是同一首片尾曲、目標響度一樣、
 * 修聲設定一樣。現在每一集都要從頭做一遍 —— 那是純粹的重複勞動。
 *
 * **只存跨集會重複的東西**：開場 / 片尾 / 固定音效、輸出目標、修聲、激進度。
 * 剪輯決策與逐字稿不存 —— 那是這一集的內容，跨集重用毫無意義而且危險。
 *
 * **片尾曲錨在結尾不是絕對時間**：每一集長度不同，存絕對時間的話套到短的一集
 * 會掉在節目之後、套到長的一集會壓在中間。
 */
export default function TemplateDialog({ mediaId, onClose }: { mediaId: string | null; onClose: () => void }) {
  const t = useT();
  const raw = useSettings((s) => s.s.project_templates);
  const save = useSettings((s) => s.save);
  const media = useProject((s) => s.media);
  const targetLufs = useProject((s) => s.targetLufs);
  const aggressiveness = useProject((s) => s.aggressiveness);
  const overlays = useDecisions((s) => (mediaId ? s.overlays[mediaId] : undefined));
  const addOverlays = useDecisions((s) => s.addOverlays);
  const [name, setName] = useState("");

  const templates = useMemo(() => parseTemplates(raw.map((x) => safeParse(x)).filter(Boolean)), [raw]);
  const active = media.find((m) => m.id === mediaId) ?? null;
  const durationMs = active?.probe?.duration_ms ?? 0;

  const persist = async (list: ProjectTemplate[]) => {
    await save({ project_templates: list.map((x) => JSON.stringify(x)) });
  };

  const saveCurrent = async () => {
    if (!mediaId || !name.trim()) return;
    const tpl = buildTemplate({
      label: name,
      overlays: overlays ?? [],
      pathOf: (id) => media.find((m) => m.id === id)?.path ?? null,
      durationMs,
      targetLufs,
      aggressiveness,
      cleanup: useCleanup.getState().get(mediaId),
    });
    if (templates.some((x) => x.id === tpl.id)) {
      await persist(templates.map((x) => (x.id === tpl.id ? tpl : x)));
      toast.success(t("已更新範本「{name}」", { name: tpl.label }));
    } else {
      await persist([...templates, tpl]);
      toast.success(t("已存成範本「{name}」（{n} 段）", { name: tpl.label, n: tpl.overlays.length }));
    }
    setName("");
  };

  const apply = (tpl: ProjectTemplate) => {
    if (!mediaId || !durationMs) return;
    const r = applyTemplate(tpl, durationMs, (path) => media.find((m) => m.path === path)?.id ?? null);
    addOverlays(mediaId, r.overlays, t("套用範本「{name}」", { name: tpl.label }));
    useProject.getState().setTargetLufs(tpl.targetLufs);
    useProject.getState().setAggressiveness(tpl.aggressiveness);
    if (r.missing > 0) {
      toast.error(t("有 {n} 段的來源檔還沒加進媒體清單，被跳過了", { n: r.missing }));
    } else {
      toast.success(t("已套用 {n} 段", { n: r.overlays.length }));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("專案範本")}
      icon={LayoutTemplate}
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("關閉")}
        </Button>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-[11px] leading-relaxed text-fg/50">
          {t("週更節目每一集的開場曲、片尾曲、目標響度、修聲設定都一樣。範本只存這些跨集重複的東西 —— 剪輯決策與逐字稿不存，那是這一集的內容。片尾曲會錨在結尾，換一集長度不同也會跟著移動。")}
        </p>

        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[11px] text-fg/50">
              {t("從這一集存成範本（{n} 段配樂 / 音效）", { n: (overlays ?? []).length })}
            </span>
            <Input
              value={name}
              placeholder={t("例如：AI 科技新鮮事")}
              disabled={!mediaId}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveCurrent()}
            />
          </label>
          <Button disabled={!mediaId || !name.trim()} onClick={() => void saveCurrent()}>
            {t("儲存")}
          </Button>
        </div>

        {templates.length === 0 ? (
          <EmptyState icon={LayoutTemplate} title={t("還沒有範本")} hint={t("把開場曲與片尾曲放好、設定好目標響度，再存成範本。")} />
        ) : (
          <div className="max-h-[40vh] space-y-1 overflow-y-auto">
            {templates.map((tpl) => (
              <div key={tpl.id} className="rounded-md border border-fg/10 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{tpl.label}</span>
                  <Button size="sm" variant="ghost" icon={Play} disabled={!mediaId || !durationMs} onClick={() => apply(tpl)}>
                    {t("套用到這一集")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Trash2}
                    onClick={() => {
                      void persist(templates.filter((x) => x.id !== tpl.id));
                      toast.info(t("已刪除範本「{name}」", { name: tpl.label }));
                    }}
                  >
                    {t("刪除")}
                  </Button>
                </div>
                <div className="mt-1 space-y-0.5 text-[11px] text-fg/45">
                  <div>{t("目標 {lufs} LUFS · 激進度 {a}", { lufs: tpl.targetLufs, a: tpl.aggressiveness })}</div>
                  {tpl.overlays.map((o, i) => (
                    <div key={i} className="truncate">
                      {t(roleLabel(overlayRole(o)))} ·{" "}
                      {o.anchor === "start"
                        ? t("開頭 +{t}", { t: formatMs(o.offsetMs, { millis: false }) })
                        : t("結尾 −{t}", { t: formatMs(-o.offsetMs, { millis: false }) })}{" "}
                      · {o.path.split(/[\\/]/).pop()}
                    </div>
                  ))}
                  {tpl.overlays.length === 0 && <div>{t("（沒有配樂 / 音效，只帶設定）")}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** 設定檔裡是 JSON 字串；壞掉的一律當不存在，不要讓對話框整個開不起來。 */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
