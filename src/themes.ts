// 主題變體（承襲 db-kit 的寶石色盤，去掉 CodeMirror token 部分）。
// 整個 app 的表面 6 階由 mix(bg → top) 生成、強調 / 意圖色各變體自帶；由 theme.ts 寫進 --c-* CSS 變數。

export type ThemeId = "amethyst" | "moonstone" | "jade" | "garnet" | "amber" | "ruby" | "obsidian";

export interface ThemeDef {
  id: ThemeId;
  label: string;
  dark: boolean;
  bg: string; // 最深表面（well）
  fg: string;
  top: string; // 最亮表面錨（elevated）
  accent: string;
  onAccentDark?: boolean;
  success: string;
  warning: string;
  danger: string;
  info: string;
  shadow: string;
  shadowStrength: number;
}

const DARK_INTENT = { success: "#8AFF80", warning: "#FFFF80", danger: "#FF9580", info: "#80FFEA", shadow: "#000000", shadowStrength: 0.5 };

export const THEMES: ThemeDef[] = [
  { id: "amethyst", label: "Amethyst 紫水晶", dark: true, bg: "#22212C", fg: "#F8F8F2", top: "#424450", accent: "#9580FF", ...DARK_INTENT },
  {
    id: "moonstone", label: "Moonstone 月光石", dark: false, bg: "#ECECF3", fg: "#1F1F1F", top: "#FFFFFF", accent: "#644AC9",
    success: "#14710A", warning: "#846E15", danger: "#CB3A2A", info: "#036A96", shadow: "#1E293B", shadowStrength: 0.13,
  },
  { id: "jade", label: "Jade 翡翠", dark: true, bg: "#212C2A", fg: "#F8F8F2", top: "#36504B", accent: "#80FFEA", ...DARK_INTENT },
  { id: "garnet", label: "Garnet 石榴石", dark: true, bg: "#2A212C", fg: "#F8F8F2", top: "#4C3252", accent: "#FF80BF", ...DARK_INTENT },
  { id: "amber", label: "Amber 琥珀", dark: true, bg: "#2C2A21", fg: "#F8F8F2", top: "#49463A", accent: "#FFCA80", ...DARK_INTENT },
  { id: "ruby", label: "Ruby 紅寶石", dark: true, bg: "#2C2122", fg: "#F8F8F2", top: "#4A3234", accent: "#FF9580", ...DARK_INTENT },
  { id: "obsidian", label: "Obsidian 黑曜石", dark: true, bg: "#0B0D0F", fg: "#F8F8F2", top: "#263340", accent: "#AA99FF", ...DARK_INTENT },
];

export function getThemeDef(id: string): ThemeDef | undefined {
  return THEMES.find((d) => d.id === id);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)];
}

function hexToTriple(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `${r} ${g} ${b}`;
}

function mixHex(a: string, b: string, k: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const ch = (x: number, y: number) => Math.round(x + (y - x) * k).toString(16).padStart(2, "0");
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

function relLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 由變體生出整套 app CSS 變數值（"R G B" triple / 數值字串）。 */
export function buildAppVars(def: ThemeDef): Record<string, string> {
  const steps = [0, 0.22, 0.42, 0.6, 0.8, 1].map((k) => mixHex(def.bg, def.top, k));
  const [well, inset, app, panel, bar, elevated] = steps;
  const contrast = (bg: string, fg: string) => {
    const a = relLuminance(bg) + 0.05;
    const b = relLuminance(fg) + 0.05;
    return a > b ? a / b : b / a;
  };
  const wantDark = def.onAccentDark ?? contrast(def.accent, "#1A1A22") >= contrast(def.accent, "#F8F8F2");
  const onAccent = wantDark ? "#1A1A22" : "#F8F8F2";
  return {
    "--c-well": hexToTriple(well),
    "--c-inset": hexToTriple(inset),
    "--c-app": hexToTriple(app),
    "--c-panel": hexToTriple(panel),
    "--c-bar": hexToTriple(bar),
    "--c-elevated": hexToTriple(elevated),
    "--c-fg": hexToTriple(def.fg),
    "--c-accent": hexToTriple(def.accent),
    "--c-on-accent": hexToTriple(onAccent),
    "--c-success": hexToTriple(def.success),
    "--c-warning": hexToTriple(def.warning),
    "--c-danger": hexToTriple(def.danger),
    "--c-info": hexToTriple(def.info),
    "--c-shadow": hexToTriple(def.shadow),
    "--shadow-strength": String(def.shadowStrength),
  };
}
