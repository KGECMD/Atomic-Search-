/**
 * ATOMIC SEARCH — EXTENDED THEMES & EASTER EGGS
 * 
 * Features:
 * - 20+ themes with smooth transitions
 * - Theme persistence in localStorage
 * - Easter eggs (konami code, secret commands, etc.)
 * - Theme preview system
 * - Keyboard shortcuts for theme switching
 */

(function () {
  "use strict";

  const THEMES_KEY = "atomic.theme";
  const EASTER_EGGS_KEY = "atomic.easter-eggs";

  // All available themes
  const THEMES = [
    { id: "classic-light", name: "Classic Light", icon: "☀️" },
    { id: "classic-dark", name: "Classic Dark", icon: "🌙" },
    { id: "neon", name: "Neon", icon: "⚡" },
    { id: "minimal", name: "Minimal", icon: "◻️" },
    { id: "solarized-light", name: "Solarized Light", icon: "🌅" },
    { id: "solarized-dark", name: "Solarized Dark", icon: "🌆" },
    { id: "dracula", name: "Dracula", icon: "🧛" },
    { id: "nord", name: "Nord", icon: "❄️" },
    { id: "gruvbox-light", name: "Gruvbox Light", icon: "🌾" },
    { id: "gruvbox-dark", name: "Gruvbox Dark", icon: "🌲" },
    { id: "cyberpunk", name: "Cyberpunk", icon: "🤖" },
    { id: "sunset", name: "Sunset", icon: "🌅" },
    { id: "ocean", name: "Ocean", icon: "🌊" },
    { id: "forest", name: "Forest", icon: "🌳" },
    { id: "monochrome", name: "Monochrome", icon: "⚫" },
    { id: "retro", name: "Retro", icon: "📼" },
    { id: "pastel", name: "Pastel", icon: "🎨" },
    { id: "high-contrast", name: "High Contrast", icon: "♿" },
    { id: "midnight", name: "Midnight", icon: "🌃" },
    { id: "lavender", name: "Lavender", icon: "💜" },
    { id: "coral", name: "Coral", icon: "🪸" },
    { id: "mint", name: "Mint", icon: "🌿" },
    { id: "amber", name: "Amber", icon: "🟡" },
    { id: "slate", name: "Slate", icon: "🩶" },
    { id: "cherry", name: "Cherry", icon: "🍒" },
  ];

  // Easter eggs registry
  const EASTER_EGGS = {
    konami: { code: [38, 38, 40, 40, 37, 39, 37, 39, 66, 65], triggered: false },
    "secret-search": { triggered: false },
    "rainbow-mode": { triggered: false },
    "matrix-mode": { triggered: false },
  };

  // Load current theme
  function loadTheme() {
    try {
      const saved = localStorage.getItem(THEMES_KEY);
      return saved || "classic-light";
    } catch (e) {
      return "classic-light";
    }
  }

  // Save theme preference
  function saveTheme(themeId) {
    try {
      localStorage.setItem(THEMES_KEY, themeId);
    } catch (e) {
      /* ignore */
    }
  }

  // Apply theme to document
  function applyTheme(themeId) {
    const theme = THEMES.find((t) => t.id === themeId);
    if (!theme) return;
    document.documentElement.setAttribute("data-theme", themeId);
    saveTheme(themeId);
    // Dispatch custom event for other scripts
    window.dispatchEvent(
      new CustomEvent("theme-changed", { detail: { themeId, theme } })
    );
  }

  // Get next theme in rotation
  function getNextTheme(currentId) {
    const idx = THEMES.findIndex((t) => t.id === currentId);
    const nextIdx = (idx + 1) % THEMES.length;
    return THEMES[nextIdx].id;
  }

  // Get previous theme in rotation
  function getPrevTheme(currentId) {
    const idx = THEMES.findIndex((t) => t.id === currentId);
    const prevIdx = (idx - 1 + THEMES.length) % THEMES.length;
    return THEMES[prevIdx].id;
  }

  // Create theme picker UI
  function createThemePicker() {
    const container = document.createElement("div");
    container.id = "theme-picker";
    container.className = "theme-picker";
    container.innerHTML = `
      <div class="theme-picker-header">
        <h3>Themes</h3>
        <button class="theme-picker-close" aria-label="Close theme picker">✕</button>
      </div>
      <div class="theme-picker-grid">
        ${THEMES.map(
          (t) => `
          <button 
            class="theme-option" 
            data-theme="${t.id}" 
            title="${t.name}"
            aria-label="Switch to ${t.name} theme"
          >
            <span class="theme-icon">${t.icon}</span>
            <span class="theme-label">${t.name}</span>
          </button>
        `
        ).join("")}
      </div>
      <div class="theme-picker-footer">
        <p class="theme-hint">💡 Tip: Press <kbd>T</kbd> to cycle themes, <kbd>Shift+T</kbd> to go back</p>
      </div>
    `;

    // Event listeners
    container.querySelector(".theme-picker-close").addEventListener("click", () => {
      container.hidden = true;
    });

    container.querySelectorAll(".theme-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        const themeId = btn.getAttribute("data-theme");
        applyTheme(themeId);
        // Highlight selected theme
        container.querySelectorAll(".theme-option").forEach((b) => {
          b.classList.toggle("active", b === btn);
        });
      });
    });

    return container;
  }

  // Konami code detector
  function setupKonamiCode() {
    const konamiCode = EASTER_EGGS.konami.code;
    let konamiIndex = 0;

    document.addEventListener("keydown", (e) => {
      if (e.keyCode === konamiCode[konamiIndex]) {
        konamiIndex++;
        if (konamiIndex === konamiCode.length) {
          triggerKonamiEasterEgg();
          konamiIndex = 0;
        }
      } else {
        konamiIndex = 0;
      }
    });
  }

  // Konami code easter egg: rainbow mode
  function triggerKonamiEasterEgg() {
    if (EASTER_EGGS.konami.triggered) return;
    EASTER_EGGS.konami.triggered = true;

    // Add rainbow CSS
    const style = document.createElement("style");
    style.textContent = `
      @keyframes rainbow {
        0% { filter: hue-rotate(0deg); }
        100% { filter: hue-rotate(360deg); }
      }
      body.rainbow-mode {
        animation: rainbow 3s linear infinite;
      }
    `;
    document.head.appendChild(style);
    document.body.classList.add("rainbow-mode");

    // Show easter egg message
    showEasterEggMessage("🌈 Rainbow mode activated! Press Konami code again to disable.");

    // Toggle on next trigger
    EASTER_EGGS.konami.triggered = false;
  }

  // Show easter egg notification
  function showEasterEggMessage(message) {
    const notification = document.createElement("div");
    notification.className = "easter-egg-notification";
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.classList.add("show");
    }, 10);

    setTimeout(() => {
      notification.classList.remove("show");
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  // Secret command: type "atomic" to reveal easter egg
  function setupSecretCommands() {
    let secretBuffer = "";
    const secretWords = ["atomic", "search", "theme"];

    document.addEventListener("keypress", (e) => {
      const char = String.fromCharCode(e.charCode).toLowerCase();
      secretBuffer += char;

      // Keep buffer size reasonable
      if (secretBuffer.length > 20) {
        secretBuffer = secretBuffer.slice(-20);
      }

      // Check for secret words
      for (const word of secretWords) {
        if (secretBuffer.includes(word)) {
          triggerSecretCommand(word);
          secretBuffer = "";
          break;
        }
      }
    });
  }

  function triggerSecretCommand(word) {
    const messages = {
      atomic: "⚛️ You found the Atomic Easter Egg!",
      search: "🔍 Search mode activated!",
      theme: "🎨 Theme master unlocked!",
    };
    showEasterEggMessage(messages[word] || "🎉 Easter egg found!");
  }

  // Keyboard shortcuts for theme switching
  function setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      // T = next theme, Shift+T = prev theme
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        const current = loadTheme();
        const next = e.shiftKey ? getPrevTheme(current) : getNextTheme(current);
        applyTheme(next);
        showEasterEggMessage(`Switched to ${THEMES.find((t) => t.id === next).name}`);
      }

      // Ctrl+Shift+T = open theme picker
      if (e.ctrlKey && e.shiftKey && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        const picker = document.getElementById("theme-picker");
        if (picker) {
          picker.hidden = !picker.hidden;
        }
      }
    });
  }

  // Initialize on DOM ready
  function init() {
    // Apply saved theme
    const currentTheme = loadTheme();
    applyTheme(currentTheme);

    // Create and inject theme picker
    const picker = createThemePicker();
    document.body.appendChild(picker);

    // Highlight current theme in picker
    const currentBtn = picker.querySelector(`[data-theme="${currentTheme}"]`);
    if (currentBtn) {
      currentBtn.classList.add("active");
    }

    // Setup easter eggs and shortcuts
    setupKonamiCode();
    setupSecretCommands();
    setupKeyboardShortcuts();

    // Expose API globally for console access
    window.AtomicThemes = {
      apply: applyTheme,
      current: loadTheme,
      list: () => THEMES,
      next: () => {
        const next = getNextTheme(loadTheme());
        applyTheme(next);
        return next;
      },
      prev: () => {
        const prev = getPrevTheme(loadTheme());
        applyTheme(prev);
        return prev;
      },
      random: () => {
        const random = THEMES[Math.floor(Math.random() * THEMES.length)].id;
        applyTheme(random);
        return random;
      },
    };

    console.log(
      "%c🎨 Atomic Search Themes Ready!",
      "color: #4285f4; font-size: 14px; font-weight: bold;"
    );
    console.log(
      "%cUse AtomicThemes.apply('theme-id') to switch themes, or press T/Shift+T",
      "color: #666; font-size: 12px;"
    );
  }

  // Wait for DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

