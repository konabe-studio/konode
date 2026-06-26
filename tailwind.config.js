/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{ts,tsx}", "./popup.html", "./options.html"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#0a0a0f",
          1: "#111118",
          2: "#18181f",
          3: "#1e1e28",
          4: "#252530",
        },
        border: {
          subtle: "#ffffff0f",
          default: "#ffffff1a",
          strong: "#ffffff2e",
        },
        accent: {
          DEFAULT: "#6ee7b7",
          dim: "#6ee7b730",
          muted: "#6ee7b760",
        },
        warn: "#fbbf24",
        danger: "#f87171",
        muted: "#71717a",
        fg: {
          DEFAULT: "#f4f4f5",
          muted: "#a1a1aa",
          subtle: "#71717a",
        },
        // Synkro design-system tokens (popup). Map to CSS vars in index.css that
        // flip on prefers-color-scheme. Prefixed `sk-` so they don't clash with the
        // existing dark tokens above (which options/onboarding still use).
        sk: {
          bg: "var(--sk-bg)",
          surface: "var(--sk-surface)",
          raised: "var(--sk-raised)",
          tint: "var(--sk-tint)",
          hairline: "var(--sk-hairline)",
          text: "var(--sk-text)",
          muted: "var(--sk-muted)",
          subtle: "var(--sk-subtle)",
          signal: "var(--sk-signal)",
          "on-signal": "var(--sk-on-signal)",
          warn: "var(--sk-warn)",
          danger: "var(--sk-danger)",
        },
      },
      borderRadius: {
        card: "14px",
        box: "12px",
        icon: "8px",
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "monospace"],
        sans: ["'Inter'", "system-ui", "sans-serif"],
      },
      fontSize: {
        "2xs": ["0.65rem", { lineHeight: "1rem" }],
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "spin-slow": "spin 3s linear infinite",
        "fade-in": "fadeIn 0.3s ease forwards",
        "slide-up": "slideUp 0.3s ease forwards",
        "synkro-pulse": "synkro-pulse 2s ease-out infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "synkro-pulse": {
          "0%": { transform: "scale(1)", opacity: "0.45" },
          "70%,100%": { transform: "scale(3.2)", opacity: "0" },
        },
      },
      boxShadow: {
        glow: "0 0 20px rgba(110, 231, 183, 0.15)",
        "glow-sm": "0 0 8px rgba(110, 231, 183, 0.1)",
      },
    },
  },
  plugins: [],
};
