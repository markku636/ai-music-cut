import { errMessage } from "../api";
import { toast } from "../ui";
import { installCommandReactivity } from "./guards";
import { registerCommands, setCommandHost } from "./registry";
import { CORE_COMMANDS } from "./core";
import { EFFECT_COMMANDS } from "./effectCommands";

/**
 * 把所有指令登記進註冊表。App 掛載時呼叫一次；熱更新重跑也沒關係（upsert）。
 */
export function installCommands(): () => void {
  setCommandHost({ info: toast.info, error: toast.error, errMessage });
  registerCommands([...CORE_COMMANDS, ...EFFECT_COMMANDS]);
  return installCommandReactivity();
}

export { runCommand, command, commandsIn, useEnabled, useCommandTick } from "./registry";
export type { Command, CommandGroup, Enabled, Surface } from "./types";
