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
import { resolveValues, type EffectApplication, type EffectContext, type EffectSpec, type Suggestion } from "./spec";

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

/**
 * 套用一個效果並給復原提示。`note` 是建議值的一句話（量到什麼、是不是估的），
 * 接在提示後面 —— 使用者才看得出「為什麼是這個數字」。
 */
export async function applyEffect(app: EffectApplication, mediaId: string, note?: string): Promise<void> {
  const applied = t("已套用：{label}", { label: app.label });
  const text = note ? `${applied} · ${note}` : applied;
  if (app.kind === "effects") {
    // 沒有東西要套（例如降噪建議 0 dB）：store 不會進 undo，這裡也不能假裝套了
    if (!app.effects.length) {
      toast.info(t("量起來不需要處理"));
      return;
    }
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

function applyNow(spec: EffectSpec, values: ReturnType<typeof resolveValues>, note?: string): void {
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
  void applyEffect(spec.build(values, range, ctx), id, note);
}

/** 建議值的一句話：量到什麼；不是實測就講明白（summary 可能已翻譯，t() 對翻過的字串是 identity）。 */
function suggestionNote(sug: Suggestion): string {
  const parts = [t(sug.summary)];
  if (sug.confidence === "heuristic") parts.push(t("估計值，非實測"));
  else if (sug.confidence === "default") parts.push(t("未量測，用一般值"));
  return parts.join(" · ");
}

/**
 * 建議值本身就是「不用處理」（降噪 0 dB）？clamp 會把 0 拉到滑桿下限再套下去，
 * 所以拿**原始**建議值先問一次 build：產不出效果就是 no-op。
 */
function suggestionIsNoop(spec: EffectSpec, sug: Suggestion, values: ReturnType<typeof resolveValues>, range: TimeSelection, ctx: EffectContext): boolean {
  const raw = { ...values };
  for (const [k, v] of Object.entries(sug.values)) if (v != null) raw[k] = v;
  const probe = spec.build(raw, range, ctx);
  return probe.kind === "effects" && !probe.effects.length;
}

export function commandsForSpec(spec: EffectSpec): Command[] {
  const base = { group: spec.group, section: spec.section, icon: spec.icon, surfaces: ["menu", "palette", "context"] as Command["surfaces"], keywords: spec.keywords };
  const cmds: Command[] = [];
  // 沒有參數、沒有預設、沒有建議值：開對話框只是多一步，直接給一顆指令
  if (!spec.params.length && !spec.presets.length && !spec.suggest) {
    return [
      {
        ...base,
        id: spec.id,
        title: spec.title,
        simple: !!spec.simpleLabel,
        simpleLabel: spec.simpleLabel,
        simpleHint: spec.simpleHint,
        simpleOrder: spec.simpleOrder,
        enabled: enabledFor(spec),
        run: () => applyNow(spec, resolveValues(spec)),
      },
    ];
  }
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
        const values = resolveValues(spec, spec.presets[0] ?? null, sug?.values ?? null);
        if (sug && suggestionIsNoop(spec, sug, values, range, ctx)) {
          toast.info(t("量起來不需要處理"));
          return;
        }
        // 復原提示帶上建議的理由與可信度，不然「（建議值）」套完只看到一個數字
        applyNow(spec, values, sug ? suggestionNote(sug) : undefined);
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
