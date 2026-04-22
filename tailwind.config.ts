import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Notion-style neutrals
        ink: "#37352f",
        "ink-light": "#787774",
        "ink-lighter": "#9b9a97",
        paper: "#ffffff",
        "paper-subtle": "#f7f6f3",
        "paper-hover": "#f1f1ef",
        "rule": "#e9e9e7",
        "rule-strong": "#d3d1cb",
        // Accents
        accent: "#2383e2",
        "accent-bg": "#e7f3f8",
        live: "#e03e3e",
        // Callouts
        "green-bg": "#edf3ec",
        "green-text": "#4d6461",
        "green-dot": "#68a973",
        "yellow-bg": "#fbf3db",
        "yellow-text": "#89632a",
        "yellow-dot": "#d9a84e",
        "red-bg": "#fbe4e4",
        "red-text": "#a13d3d",
        "red-dot": "#e16a6a",
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        serif: ["Lora", "Georgia", "serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
