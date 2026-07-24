import type { Metadata } from "next";
import { Inter, Lora, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Force per-request rendering for EVERY page. Without this, Next
// prerenders pages like /app as static and serves them with
// `Cache-Control: s-maxage=31536000` — and the CloudFront distribution
// in front of EB then caches the HTML (which pins the old JS bundle
// hashes) for up to a YEAR per edge. Users kept seeing weeks-old UI
// after deploys, unfixable by hard refresh because the EDGE was stale.
// Dynamic rendering emits no-store headers, so HTML is always fetched
// from origin; hashed /_next/static assets stay immutable-cached.
// (Deploys also invalidate CloudFront via .deploy/redeploy.sh now —
// belt and suspenders.)
export const dynamic = "force-dynamic";

// Self-hosted via next/font: Next.js downloads these at build time and
// serves them from the same origin as the app. No runtime request to
// fonts.googleapis.com — required so users in mainland China (where
// Google Fonts is blocked) can load the page without a VPN.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});
const lora = Lora({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "puebulo",
  description: "Real-time AI interview copilot — coach yourself through the interview, not after it.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${lora.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        {/* DNS + TLS preconnect for the Deepgram WebSocket. Browsers
            (in China especially) pay 200-400ms on the first WS handshake
            for DNS lookup + TLS session setup. Issuing a preconnect at
            page load lets that finish in parallel with the user filling
            in the JD/resume, so by the time they click "Start" the WS
            opens with a warm route — first transcript visibly faster. */}
        <link
          rel="preconnect"
          href="https://api.deepgram.com"
          crossOrigin="anonymous"
        />
        <link rel="dns-prefetch" href="https://api.deepgram.com" />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
