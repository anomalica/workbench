/**
 * Light/dark theme state for the workbench.
 *
 * The actual colours live in the shared brand tokens (brand/css/tokens.css):
 * a `.dark` class on the root element overrides every semantic CSS variable
 * (--surface, --on-surface, --primary, ...). The workbench's components all
 * use those tokens via Tailwind utilities (bg-surface, text-on-surface, ...),
 * so flipping the class re-themes the whole app - no per-component work.
 *
 * The pre-paint script in index.html applies the saved/system theme before
 * the app mounts (avoids a flash); this module keeps that state reactive and
 * persists changes.
 */
const STORAGE_KEY = "workbench:theme";

type Theme = "light" | "dark";

function initialTheme(): Theme {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "dark";
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  } catch {}
  return "light";
}

let theme = $state<Theme>(initialTheme());

export const themeState = {
  get current(): Theme {
    return theme;
  },
  get isDark(): boolean {
    return theme === "dark";
  },
  toggle() {
    this.set(theme === "dark" ? "light" : "dark");
  },
  set(next: Theme) {
    theme = next;
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", next === "dark");
    }
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  },
};
