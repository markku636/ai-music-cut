import { Sparkles, TrendingDown, TrendingUp, Volume2, VolumeX, Wand2 } from "lucide-react";
import { describeCleanup, estimateCleanup } from "../analysis/cleanup";
import { t } from "../i18n";
import { useCleanup } from "../store/cleanup";
import { openDialog } from "../store/dialogs";
import { useProject } from "../store/project";
import { useTranscript } from "../store/transcript";
import { addEffectOnSelection } from "../timeline/selectionActions";
import { toast } from "../ui";
import { activeId, needsMedia, needsSelection } from "./guards";
import { OK } from "./registry";
import type { Command } from "./types";

/**
 * 效果 / 修復類指令。
 *
 * R1 先登記現有的四種增益效果與整檔修聲；之後 effects/spec 進來，
 * 這裡的增益幾檔會改由 registerEffectSpec 產生（quick / dialog 成對）。
 */

const GAIN_STEPS = [6, 3, -3, -6, -12];

export const EFFECT_COMMANDS: Command[] = [
  {
    id: "effect.mute",
    title: "靜音",
    group: "effect",
    section: "音量",
    icon: VolumeX,
    surfaces: ["menu", "palette", "context"],
    enabled: needsSelection,
    run: () => void addEffectOnSelection("mute"),
  },
  {
    id: "effect.fadeIn",
    title: "淡入",
    group: "effect",
    section: "淡入淡出",
    icon: TrendingUp,
    surfaces: ["menu", "palette", "context"],
    enabled: needsSelection,
    run: () => void addEffectOnSelection("fade_in"),
  },
  {
    id: "effect.fadeOut",
    title: "淡出",
    group: "effect",
    section: "淡入淡出",
    icon: TrendingDown,
    surfaces: ["menu", "palette", "context"],
    enabled: needsSelection,
    run: () => void addEffectOnSelection("fade_out"),
  },
  ...GAIN_STEPS.map<Command>((db) => ({
    id: `effect.gain.${db > 0 ? "p" : "m"}${Math.abs(db)}`,
    title: "增益 {db} dB",
    titleParams: { db: db > 0 ? `+${db}` : String(db) },
    group: "effect",
    section: "音量",
    icon: Volume2,
    surfaces: ["menu", "palette", "context"],
    enabled: needsSelection,
    run: () => void addEffectOnSelection("gain", db),
  })),
  {
    id: "repair.cleanup.quick",
    title: "降噪整集（建議值）",
    group: "repair",
    section: "噪音",
    icon: Sparkles,
    pairId: "cleanup",
    variant: "quick",
    surfaces: ["menu", "palette", "context"],
    keywords: ["denoise", "noise", "clean"],
    enabled: () => {
      const m = needsMedia();
      if (!m.ok) return m;
      const id = activeId();
      return id && useTranscript.getState().local[id] ? OK : { ok: false, why: "還沒有波形分析，量不到底噪" };
    },
    run: () => {
      const id = activeId();
      if (!id) return;
      const est = estimateCleanup(useTranscript.getState().local[id] ?? null);
      useCleanup.getState().set(id, est.suggested);
      useProject.getState().markDirty();
      toast.success(t("修聲已套用：{d}").replace("{d}", describeCleanup(est.suggested)));
    },
  },
  {
    id: "repair.cleanup.dialog",
    title: "修聲（降噪 / 去隆隆 / 齒音）…",
    group: "repair",
    section: "噪音",
    icon: Wand2,
    pairId: "cleanup",
    variant: "dialog",
    surfaces: ["menu", "palette", "context"],
    keywords: ["denoise", "noise", "cleanup", "deess"],
    enabled: needsMedia,
    run: () => openDialog("cleanup"),
  },
];
