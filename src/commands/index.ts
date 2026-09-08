import { errMessage } from "../api";
import { toast } from "../ui";
import { installCommandReactivity } from "./guards";
import { registerCommands, setCommandHost } from "./registry";
import { CORE_COMMANDS } from "./core";
import { EFFECT_COMMANDS } from "./effectCommands";
import { CLIP_COMMANDS } from "./clipCommands";
import { registerEffectSpec } from "../effects/registry";
import { gainSpec } from "../effects/specs/gain";
import { fadesSpec, invertSpec } from "../effects/specs/fades";
import { matchLoudnessSpec, peakNormalizeSpec } from "../effects/specs/normalize";
import { REPAIR_SPECS } from "../effects/specs/repair";
import { TONE_SPECS } from "../effects/specs/tone";

/**
 * 把所有指令登記進註冊表。App 掛載時呼叫一次；熱更新重跑也沒關係（upsert）。
 */
export function installCommands(): () => void {
  setCommandHost({ info: toast.info, error: toast.error, errMessage });
  registerCommands([
    ...CORE_COMMANDS,
    ...EFFECT_COMMANDS,
    // 選取區間單獨匯入（把音檔放進選的這一段）
    ...CLIP_COMMANDS,
    ...registerEffectSpec(gainSpec),
    ...registerEffectSpec(peakNormalizeSpec),
    ...registerEffectSpec(matchLoudnessSpec),
    ...registerEffectSpec(fadesSpec),
    ...registerEffectSpec(invertSpec),
    // 修復類（範圍濾波：降噪 / 去爆音 / 去削波 / 去嗡聲 / DC）—— 輸出時 Rust punch-in
    ...REPAIR_SPECS.flatMap((s) => registerEffectSpec(s)),
    // 音色 / 動態 / 空間 / 時間（EQ / 壓縮 / 回音 / 殘響 / 反轉 / 變調）
    ...TONE_SPECS.flatMap((s) => registerEffectSpec(s)),
  ]);
  return installCommandReactivity();
}

export { runCommand, command, commandsIn, useEnabled, useCommandTick } from "./registry";
export type { Command, CommandGroup, Enabled, Surface } from "./types";
