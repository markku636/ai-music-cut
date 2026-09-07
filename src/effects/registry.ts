import { isCleanupActive } from "../analysis/cleanup";
import { needsMedia, needsSelection } from "../commands/guards";
import type { Command, Enabled } from "../commands/types";
import { t } from "../i18n";
import { useCleanup } from "../store/cleanup";
import { openDialog } from "../store/dialogs";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useTimeline, type TimeSelection } from "../store/timeline";
import { useTranscript } from "../store/transcript";
import { toast } from "../ui";
import { resolveValues, type EffectApplication, type EffectContext, type EffectSpec } from "./spec";

/**
 * 效果 spec 的登記處。`registerEffectSpec(spec)` 回傳它產生的指令：
 * - `${id}.dialog`：開 EffectDialog
 * - `${id}.preset.<p>`：直接套 preset（增益 +6 / −6 那種一鍵）
 * - `${id}.quick`：有 suggest 才有 —— 用建議值直接套
 * 選單 / 右鍵 / 命令面板 / 簡易面板都只看指令表，所以之後加一個效果只要寫一支 spec。
 */

const specs = new Map<string, EffectSpec>();

export function effectSpec(id: string): EffectSpec | undefined {
  return specs.get(id);
}

export function allEffectSpecs(): EffectSpec[] {
  return [...specs.values()];
}

export function effectContext(mediaId: string): EffectContext {
  const p = useProject.getState();
  const media = p.media.find((m) => m.id === mediaId);
  const tr = useTranscript.getState();
  return {
    mediaId,
    local: tr.local[mediaId] ?? null,
    transcript: tr.byMedia[mediaId] ?? null,
    selection: useTimeline.getState().selection,
    durationMs: media?.probe?.duration_ms ?? tr.byMedia[mediaId]?.durationMs ?? 0,
  };
}

/** 依 scope 決定作用範圍；拿不到（要選取卻沒選）回 null。 */
export function rangeFor(spec: EffectSpec, ctx: EffectContext): TimeSelection | null {
  if (spec.scope === "selection") return ctx.selection;
  if (spec.scope === "either" && ctx.selection) return ctx.selection;
  return ctx.durationMs > 0 ? { startMs: 0, endMs: ctx.durationMs } : null;
}

function enabledFor(spec: EffectSpec): () => Enabled {
  return spec.scope === "selection" ? needsSelection : needsMedia;
}

export async function applyEffect(app: EffectApplication, mediaId: string): Promise<void> {
  const text = t("已套用：{label}", { label: app.label });
  if (app.kind === "effects") {
    const before = useDecisions.getState().past.length;
    useDecisions.getState().addEffects(mediaId, app.effects, app.label);
    const after = useDecisions.getState().past.length;
    // 復原鈕只退自己這一筆：之後又做了別的事就改成提示，不然會退錯
    toast.undo(text, () => {
      const d = useDecisions.getState();
      if (d.past.length === after && after > before) d.undo();
      else toast.info(t("後面還有別的修改，請用「復原」一步一步退回"));
    });
  } else if (app.kind === "cleanup") {
    const prev = useCleanup.getState().byMedia[mediaId] ?? null;
    useCleanup.getState().set(mediaId, isCleanupActive(app.spec) ? app.spec : null);
    useProject.getState().markDirty();
    toast.undo(text, () => {
      useCleanup.getState().set(mediaId, prev);
      useProject.getState().markDirty();
    });
  } else {
    await app.apply();
    toast.success(text);
  }
}

function applyNow(spec: EffectSpec, values: ReturnType<typeof resolveValues>): void {
  const id = useProject.getState().activeMediaId;
  if (!id) return;
  const ctx = effectContext(id);
  const range = rangeFor(spec, ctx);
  if (!range) return;
  const err = spec.validate?.(values, ctx);
  if (err) {
    toast.info(t(err));
    return;
  }
  void applyEffect(spec.build(values, range, ctx), id);
}

export function commandsForSpec(spec: EffectSpec): Command[] {
  const base = { group: spec.group, section: spec.section, icon: spec.icon, surfaces: ["menu", "palette", "context"] as Command["surfaces"], keywords: spec.keywords };
  const cmds: Command[] = [];
  if (spec.suggest) {
    cmds.push({
      ...base,
      id: `${spec.id}.quick`,
      title: "{name}（建議值）",
      titleParams: { name: t(spec.title) },
      pairId: spec.id,
      variant: "quick",
      simple: true,
      simpleLabel: spec.simpleLabel,
      simpleHint: spec.simpleHint,
      simpleOrder: spec.simpleOrder,
      enabled: enabledFor(spec),
      run: () => {
        const id = useProject.getState().activeMediaId;
        if (!id) return;
        const ctx = effectContext(id);
        const range = rangeFor(spec, ctx);
        if (!range) return;
        const sug = spec.suggest!(ctx, range);
        applyNow(spec, resolveValues(spec, spec.presets[0] ?? null, sug?.values ?? null));
      },
    });
  }
  for (const p of spec.presets) {
    cmds.push({
      ...base,
      id: `${spec.id}.preset.${p.id}`,
      title: p.label,
      titleParams: p.labelParams,
      enabled: enabledFor(spec),
      run: () => applyNow(spec, resolveValues(spec, p)),
    });
  }
  cmds.push({
    ...base,
    id: `${spec.id}.dialog`,
    title: "{name}…",
    titleParams: { name: t(spec.title) },
    pairId: spec.id,
    variant: "dialog",
    enabled: enabledFor(spec),
    run: () => {
      const id = useProject.getState().activeMediaId;
      if (!id) return;
      const range = rangeFor(spec, effectContext(id));
      openDialog("effect", { specId: spec.id, range });
    },
  });
  return cmds;
}

export function registerEffectSpec(spec: EffectSpec): Command[] {
  specs.set(spec.id, spec);
  return commandsForSpec(spec);
}
