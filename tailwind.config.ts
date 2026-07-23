import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Color tokens follow the puebulo design system (see app/globals.css
      // for the canonical CSS-variable definitions). Token *names* match
      // the prior Notion-style palette so existing JSX (200+ class strings)
      // continues to compile during the visual refactor — only the hex
      // values shift to the new mono palette. Phase 3 page-by-page work
      // will gradually swap class names to the more idiomatic new tokens
      // (text, surface, border, accent-hover, etc.).
      colors: {
        // ===== New canonical tokens (preferred for new code) =====
        bg: "#FFFFFF",
        surface: "#FAFAF7",
        "surface-2": "#F0EFEA",
        border: "#E5E4DF",
        "border-strong": "#D1D0CB",
        text: "#0A0A0A",
        "text-muted": "#4A4A48",
        "text-subtle": "#8A8A86",
        "accent-hover": "#2A2A2A",
        success: "#1F7A4D",
        error: "#B23A3A",
        warning: "#B87A1F",
        "mark-bg": "#0A0A0A",
        "mark-p": "#FFFFFF",
        "mark-b": "#3A3A3A",

        // ===== Backwards-compat aliases (keep until Phase 3 finishes) =====
        // Each old name maps to the closest new value so JSX using them
        // produces the new look without code changes.
        ink: "#0A0A0A",          // was #37352f
        "ink-light": "#4A4A48",  // was #787774
        "ink-lighter": "#8A8A86",// was #9b9a97
        paper: "#FFFFFF",
        "paper-subtle": "#FAFAF7", // was #f7f6f3
        "paper-hover": "#F0EFEA",  // was #f1f1ef
        rule: "#E5E4DF",           // was #e9e9e7
        "rule-strong": "#D1D0CB",  // was #d3d1cb

        // Accent flips from blue to mono. accent-bg loses its blue tint
        // and becomes the warm neutral surface so highlight chips read
        // as "subtly different" rather than "blue".
        accent: "#0A0A0A",         // was #2383e2 (blue)
        "accent-bg": "#F0EFEA",    // was #e7f3f8 (light blue)

        // Live red moves to functional --color-error so all "alert" reds
        // are the same hue across score chips, recording dot, etc.
        live: "#B23A3A",           // was #e03e3e

        // Callout palette retunes to the new functional roles. Same
        // structure (bg / text / dot triads) so existing JSX keeps
        // working; the eye sees a calmer, more uniform palette.
        "green-bg": "#EEF4EE",     // was #edf3ec
        "green-text": "#1F7A4D",   // was #4d6461 → maps to success
        "green-dot": "#1F7A4D",    // was #68a973
        "yellow-bg": "#F8F1E2",    // was #fbf3db
        "yellow-text": "#B87A1F",  // was #89632a → maps to warning
        "yellow-dot": "#B87A1F",   // was #d9a84e
        "red-bg": "#F4E5E5",       // was #fbe4e4
        "red-text": "#B23A3A",     // was #a13d3d → maps to error
        "red-dot": "#B23A3A",      // was #e16a6a
      },
      fontFamily: {
        // CSS variables come from next/font/google in app/layout.tsx —
        // self-hosted Inter / Lora / JetBrains Mono so users behind the
        // GFW (no VPN) can load the page without hitting Google.
        //
        // Per the puebulo design system, sans (Inter) does the vast
        // majority of the work. The serif (Lora) stack is preserved
        // for the few content-typography moments still using it (Lead
        // Question text, "Try this instead" quotes); per-page Phase 3
        // refactor will decide on a case-by-case basis whether to keep
        // serif or move to Inter.
        sans: ["var(--font-sans)", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        serif: ["var(--font-serif)", "Georgia", "serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "SF Mono", "Menlo", "monospace"],
      },
      borderRadius: {
        // Match the marketing-site radius scale exactly.
        sm: "6px",
        md: "10px",
        lg: "16px",
        xl: "20px",
      },
    },
  },
  plugins: [],
};

export default config;
