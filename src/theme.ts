import { create } from "zustand";
import { THEMES, getThemeDef, buildAppVars, type ThemeId } from "./themes";

export type Theme = "dark" | "light";

const THEME_ID_KEY = "aicut:themeId"; // index.html 的 anti-FOUC 腳本讀同一個 key
const DEFAULT_DARK: ThemeId = "amethyst";
const LIGHT_ID: ThemeId = "moonstone";

function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && THEMES.some((d) => d.id === v);
}

function themeOf(id: ThemeId): Theme {
  return getThemeDef(id)?.dark ? "dark" : "light";
}

export function readStoredThemeId(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_ID_KEY);
    if (isThemeId(v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_DARK;
}

/** 把變體整套 --c-* 寫進 <html>，並依深/淺 toggle .light。 */
export function applyAppTheme(id: ThemeId) {
  const def = getThemeDef(id);
  if (!def) return;
  const root = document.documentElement;
  for (const [k, val] of Object.entries(buildAppVars(def))) root.style.setProperty(k, val);
  root.classList.toggle("light", !def.dark);
}

interface ThemeStore {
  themeId: ThemeId;
  theme: Theme;
  darkVariant: ThemeId;
  setThemeId: (id: ThemeId) => void;
  toggle: () => void;
}

export const useTheme = create<ThemeStore>((set, get) => {
  const initial = readStoredThemeId();
  return {
    themeId: initial,
    theme: themeOf(initial),
    darkVariant: themeOf(initial) === "dark" ? initial : DEFAULT_DARK,
    setThemeId: (id) => {
      applyAppTheme(id);
      try {
        localStorage.setItem(THEME_ID_KEY, id);
      } catch {
        /* ignore */
      }
      set((s) => ({ themeId: id, theme: themeOf(id), darkVariant: themeOf(id) === "dark" ? id : s.darkVariant }));
    },
    toggle: () => {
      const s = get();
      s.setThemeId(s.theme === "light" ? s.darkVariant : LIGHT_ID);
    },
  };
});
