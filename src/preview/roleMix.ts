// 角色的獨奏 / 靜音（監聽用）。
//
// 分軌檔案有了，但「音樂是不是壓過人聲」得在 App 裡當場切著聽才判斷得出來 ——
// 不然得先輸出四個檔再拉進別的軟體，那個來回是整條路上最慢的一段。
//
// **這只影響監聽，不影響輸出。** 所以它不進專案檔、不進 undo：
// 把「我剛剛在檢查音樂」存成專案狀態，下次打開會變成一個很難查的「怎麼沒聲音」。
//
// 獨奏 / 靜音的規則是所有 DAW 都一樣的那一套，寫死在這裡並且測起來：
// **有任何東西獨奏時，只有獨奏的發聲**（靜音在這時候不重要）；沒有獨奏時才看靜音。

/** 主聲軌在這裡也算一個角色 —— 「只聽音樂」跟「只聽人聲」一樣常用。 */
export const VOICE_ROLE = "voice";

export interface RoleMix {
  muted: string[];
  solo: string[];
}

export const EMPTY_MIX: RoleMix = { muted: [], solo: [] };

/** 這個角色現在發不發聲。 */
export function isAudible(role: string, mix: RoleMix): boolean {
  if (mix.solo.length > 0) return mix.solo.includes(role);
  return !mix.muted.includes(role);
}

/** 主聲軌的增益倍率（0 或 1）。接到 previewGain 上。 */
export function mainGainFactor(mix: RoleMix): number {
  return isAudible(VOICE_ROLE, mix) ? 1 : 0;
}

/** 有沒有動過任何開關（UI 用來決定要不要顯示「全部恢復」）。 */
export function isDefault(mix: RoleMix): boolean {
  return mix.muted.length === 0 && mix.solo.length === 0;
}

function toggle(list: string[], role: string): string[] {
  return list.includes(role) ? list.filter((r) => r !== role) : [...list, role].sort();
}

export function toggleMute(mix: RoleMix, role: string): RoleMix {
  return { ...mix, muted: toggle(mix.muted, role) };
}

export function toggleSolo(mix: RoleMix, role: string): RoleMix {
  return { ...mix, solo: toggle(mix.solo, role) };
}

/**
 * 丟掉已經不存在的角色。
 *
 * 刪掉最後一段廣告口播之後，如果 solo 裡還留著 "ad"，畫面上什麼都沒獨奏
 * 卻整個安靜 —— 那是最難查的一種「怎麼沒聲音」。
 */
export function pruneMix(mix: RoleMix, known: string[]): RoleMix {
  const ok = new Set([...known, VOICE_ROLE]);
  const muted = mix.muted.filter((r) => ok.has(r));
  const solo = mix.solo.filter((r) => ok.has(r));
  return muted.length === mix.muted.length && solo.length === mix.solo.length ? mix : { muted, solo };
}

/** 一行字說明現在聽得到什麼（狀態列 / 按鈕提示用）。 */
export function describeMix(mix: RoleMix, roles: string[], labelOf: (r: string) => string): string | null {
  if (isDefault(mix)) return null;
  const all = [VOICE_ROLE, ...roles];
  const on = all.filter((r) => isAudible(r, mix));
  if (on.length === 0) return "全部靜音";
  if (on.length === all.length) return null;
  return `只聽：${on.map(labelOf).join("、")}`;
}
