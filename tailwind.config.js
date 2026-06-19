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
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "monospace"],
        sans: ["'DM Sans'", "sans-serif"],
      },
      fontSize: {
        "2xs": ["0.65rem", { lineHeight: "1rem" }],
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "spin-slow": "spin 3s linear infinite",
        "fade-in": "fadeIn 0.3s ease forwards",
        "slide-up": "slideUp 0.3s ease forwards",
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
      },
      boxShadow: {
        glow: "0 0 20px rgba(110, 231, 183, 0.15)",
        "glow-sm": "0 0 8px rgba(110, 231, 183, 0.1)",
      },
    },
  },
  plugins: [],
};
