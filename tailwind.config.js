/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // 亮色主題以 <html class="light"> 覆寫 CSS 變數切換；深色為預設（:root）。
  darkMode: ["selector", '[class~="light"] &'],
  theme: {
    extend: {
      colors: {
        // ---- 語意化表面 / 文字（CSS 變數驅動，明暗主題自動翻轉；rgb(var(--x) / <alpha-value>) 讓 text-fg/60 照常）----
        app: "rgb(var(--c-app) / <alpha-value>)",
        panel: "rgb(var(--c-panel) / <alpha-value>)",
        bar: "rgb(var(--c-bar) / <alpha-value>)",
        elevated: "rgb(var(--c-elevated) / <alpha-value>)",
        inset: "rgb(var(--c-inset) / <alpha-value>)",
        well: "rgb(var(--c-well) / <alpha-value>)",
        fg: "rgb(var(--c-fg) / <alpha-value>)",
        accent: "rgb(var(--c-accent) / <alpha-value>)",
        "on-accent": "rgb(var(--c-on-accent) / <alpha-value>)",
        success: "rgb(var(--c-success) / <alpha-value>)",
        warning: "rgb(var(--c-warning) / <alpha-value>)",
        danger: "rgb(var(--c-danger) / <alpha-value>)",
        info: "rgb(var(--c-info) / <alpha-value>)",
        // ---- 候選類型色（時間軸區域 / 決策列 / 字 chip 共用）----
        "kind-filler": "rgb(var(--c-kind-filler) / <alpha-value>)",
        "kind-stutter": "rgb(var(--c-kind-stutter) / <alpha-value>)",
        "kind-pause": "rgb(var(--c-kind-pause) / <alpha-value>)",
        "kind-unclear": "rgb(var(--c-kind-unclear) / <alpha-value>)",
        "kind-noise": "rgb(var(--c-kind-noise) / <alpha-value>)",
        "kind-manual": "rgb(var(--c-kind-manual) / <alpha-value>)",
      },
      borderRadius: {
        xs: "var(--r-xs)",
        sm: "var(--r-sm)",
        DEFAULT: "var(--r-sm)",
        md: "var(--r-md)",
        lg: "var(--r-lg)",
        full: "var(--r-full)",
      },
      boxShadow: {
        e1: "var(--e-1)",
        e2: "var(--e-2)",
        e3: "var(--e-3)",
        e4: "var(--e-4)",
      },
    },
  },
  plugins: [],
};
