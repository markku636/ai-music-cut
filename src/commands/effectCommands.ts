import { Sparkles, TrendingDown, TrendingUp, VolumeX, Wand2 } from "lucide-react";
import { effectId, type AudioEffect } from "../analysis/effects";
import { useDecisions } from "../store/decisions";
import { useTimeline } from "../store/timeline";
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
 * 沒有參數的效果 / 修復類指令（靜音、淡入淡出、整檔修聲）。
 * 有參數的（增益…）寫成 effects/specs 的 EffectSpec，由 registerEffectSpec 產生指令。
 */

/** 淡入淡出的長度：最多 1.5 秒，短的選取取四分之一。 */
const FADE_MAX_MS = 1500;

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
  {
    id: "effect.fadeBoth",
    title: "淡入淡出",
    group: "effect",
    section: "淡入淡出",
    icon: TrendingUp,
    surfaces: ["menu", "palette", "context", "simple"],
    simple: true,
    simpleLabel: "淡入淡出",
    simpleHint: "開頭慢慢變大聲、結尾慢慢變小聲",
    enabled: needsSelection,
    run: () => {
      const id = activeId();
      const sel = useTimeline.getState().selection;
      if (!id || !sel) return;
      const len = Math.min(FADE_MAX_MS, Math.floor((sel.endMs - sel.startMs) / 4));
      if (len < 20) return;
      const list: AudioEffect[] = [
        { id: effectId("fade_in", sel.startMs, sel.startMs + len), kind: "fade_in", startMs: sel.startMs, endMs: sel.startMs + len },
        { id: effectId("fade_out", sel.endMs - len, sel.endMs), kind: "fade_out", startMs: sel.endMs - len, endMs: sel.endMs },
      ];
      // 一筆 undo：淡入 + 淡出是一個動作
      useDecisions.getState().addEffects(id, list, "淡入淡出");
    },
  },
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
