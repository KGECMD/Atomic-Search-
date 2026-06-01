// Privacy-aware theme definitions for Atomic Search.
//
// Each theme exports CSS variable values and a set of tracking-prevention
// settings. The `applyTheme` function writes the chosen theme to localStorage
// and updates the <body> data-theme attribute — no server round-trip, no
// analytics, no fingerprinting.
//
// Theme names mirror the [data-theme="..."] selectors in public/css/themes.css.
// The CSS variables listed here are the canonical source of truth for what
// each theme looks like; the CSS file applies them to the DOM.

// ---------------------------------------------------------------------------
// Theme definitions
// ---------------------------------------------------------------------------

export const THEMES = Object.freeze({
  dark: {
    id: "atom-dark",
    label: "Dark",
    description: "Default dark theme — easy on the eyes in low-light environments.",
    cssVars: {
      "--bg": "#0f1117",
      "--bg-elev": "#161a23",
      "--text": "#e7ecf3",
      "--text-dim": "#98a2b3",
      "--accent": "#4a90e2",
      "--border": "#242a37",
      "--link": "#7cc7ff",
    },
    // Tracking-prevention hints surfaced in the UI settings panel.
    privacy: {
      blockThirdPartyFonts: true,
      blockExternalImages: false,
      preferReducedMotion: false,
    },
  },

  light: {
    id: "atom-light",
    label: "Light",
    description: "Clean light theme — optimised for daytime reading.",
    cssVars: {
      "--bg": "#ffffff",
      "--bg-elev": "#f7f8fb",
      "--text": "#101828",
      "--text-dim": "#4b5563",
      "--accent": "#1a73e8",
      "--border": "#dfe1e5",
      "--link": "#1a0dab",
    },
    privacy: {
      blockThirdPartyFonts: true,
      blockExternalImages: false,
      preferReducedMotion: false,
    },
  },

  "high-contrast": {
    id: "high-contrast",
    label: "High Contrast",
    description: "Maximum contrast for accessibility — WCAG AAA compliant.",
    cssVars: {
      "--bg": "#000000",
      "--bg-elev": "#000000",
      "--text": "#ffffff",
      "--text-dim": "#ffff80",
      "--accent": "#ffff00",
      "--border": "#ffffff",
      "--link": "#66ffff",
    },
    privacy: {
      blockThirdPartyFonts: true,
      blockExternalImages: true,
      preferReducedMotion: true,
    },
  },

  minimal: {
    id: "paper-white",
    label: "Minimal",
    description: "Distraction-free paper-white theme — no colour, just content.",
    cssVars: {
      "--bg": "#ffffff",
      "--bg-elev-1": "#f7f7f8",
      "--text": "#1c1f24",
      "--text-dim": "#5d636a",
      "--accent": "#111111",
      "--border": "#dde1e6",
      "--link": "#111111",
    },
    privacy: {
      blockThirdPartyFonts: true,
      blockExternalImages: true,
      preferReducedMotion: true,
    },
  },

  "privacy-focused": {
    id: "carbon",
    label: "Privacy Focused",
    description: "High-contrast dark theme with all privacy enhancements enabled.",
    cssVars: {
      "--bg": "#0a0a0a",
      "--bg-elev": "#111111",
      "--text": "#f5f5f5",
      "--text-dim": "#a3a3a3",
      "--accent": "#0ea5e9",
      "--border": "#262626",
      "--link": "#60a5fa",
    },
    privacy: {
      blockThirdPartyFonts: true,
      blockExternalImages: true,
      preferReducedMotion: false,
    },
  },
});

// Ordered list of theme IDs for the settings UI picker.
export const THEME_IDS = Object.keys(THEMES);

// ---------------------------------------------------------------------------
// Runtime helpers (browser-only)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "atomic.theme";

/**
 * Apply a named theme by updating <body data-theme="..."> and persisting the
 * choice to localStorage. Safe to call before DOMContentLoaded — if
 * document.body is not yet available the function is a no-op.
 *
 * @param {string} themeName  - One of the keys in THEMES (e.g. "dark", "light")
 * @returns {boolean}  true if the theme was applied, false if unknown
 */
export function applyTheme(themeName) {
  const theme = THEMES[themeName];
  if (!theme) return false;

  // Persist to localStorage so the choice survives page reloads.
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, theme.id);
    }
  } catch { /* ignore — private browsing may block localStorage */ }

  // Update the DOM attribute that CSS selectors key off.
  if (typeof document !== "undefined" && document.body) {
    document.body.dataset.theme = theme.id;

    // Honour the preferReducedMotion hint by injecting a temporary style.
    if (theme.privacy.preferReducedMotion) {
      let style = document.getElementById("atomic-reduced-motion");
      if (!style) {
        style = document.createElement("style");
        style.id = "atomic-reduced-motion";
        document.head.appendChild(style);
      }
      style.textContent = "*, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }";
    } else {
      const existing = document.getElementById("atomic-reduced-motion");
      if (existing) existing.remove();
    }
  }

  return true;
}

/**
 * Return the currently active theme definition, or the dark theme as default.
 * Reads from localStorage if available.
 *
 * @returns {{ id: string, label: string, privacy: object, cssVars: object }}
 */
export function getActiveTheme() {
  let savedId = null;
  try {
    if (typeof localStorage !== "undefined") {
      savedId = localStorage.getItem(STORAGE_KEY);
    }
  } catch { /* ignore */ }

  // Find the theme whose CSS id matches the saved value.
  for (const theme of Object.values(THEMES)) {
    if (theme.id === savedId) return theme;
  }
  return THEMES.dark;
}
