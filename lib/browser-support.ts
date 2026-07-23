/**
 * Browser-support detection for live recording.
 *
 * The live coaching surface needs:
 *   1. `getDisplayMedia` with tab audio capture — Chromium-based
 *      desktop browsers ONLY. Firefox lacks the "Share tab audio"
 *      checkbox; Safari WebKit doesn't surface it; mobile browsers
 *      don't expose getDisplayMedia at all (or expose it without
 *      tab audio, same effect: useless for capturing the
 *      interviewer's voice).
 *   2. A non-mobile, non-tablet form factor — even when the browser
 *      is "Chrome", running on a phone or iPad means screen-share
 *      is gated, the UI is too small for the live coaching layout,
 *      and the user can't run a video meeting in another tab on the
 *      same device anyway.
 *
 * Verdicts:
 *   - "supported" → desktop Chromium (Chrome, Edge, Brave, Opera, etc.)
 *   - "unsupported" → anything else (Firefox, Safari, iPad, phone, …)
 *
 * The /app shell renders a passive warning banner on "unsupported"
 * (see app/app/page.tsx) — past-session review still works in any
 * browser, only the live recording flow is gated.
 */

export type BrowserSupport = "supported" | "unsupported";

/** Best-effort detection. Returns "supported" when SSR (no navigator)
 *  so we don't flash a banner during hydration. The actual check
 *  re-runs client-side via the use* hook below. */
export function detectBrowserSupport(): BrowserSupport {
  if (typeof navigator === "undefined") return "supported";

  // === Step 1: rule out mobile / tablet ===
  // Modern path: User-Agent Client Hints (Chromium-only API). When
  // present this is the most reliable mobile signal.
  const uaData = (navigator as unknown as {
    userAgentData?: {
      mobile?: boolean;
      brands?: Array<{ brand: string; version: string }>;
    };
  }).userAgentData;
  if (uaData && typeof uaData.mobile === "boolean") {
    if (uaData.mobile) return "unsupported";
  }

  const ua = navigator.userAgent || "";

  // UA-string fallback. Phones + Android tablets advertise their type
  // explicitly. iPhone / iPod / iPad strings are stable on Safari +
  // third-party browsers like Chrome / Firefox iOS.
  if (/iPhone|iPod|Android|Mobile|BlackBerry|webOS|Opera Mini/i.test(ua)) {
    return "unsupported";
  }
  if (/iPad/i.test(ua)) {
    return "unsupported";
  }
  // iPadOS 13+ Safari spoofs the desktop Macintosh UA. Detect via the
  // touch-points heuristic — desktop Macs return 0 or 1, iPad returns
  // 5+ (multi-touch).
  if (
    /Macintosh/.test(ua) &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1
  ) {
    return "unsupported";
  }

  // === Step 2: must be Chromium-based ===
  // Chromium UA-CH brands list — when available, look for "Chromium"
  // or "Chrome" entry. This catches Edge, Brave, Opera, Vivaldi, etc.
  // without UA-string regex maintenance.
  if (uaData?.brands && uaData.brands.length > 0) {
    const isChromium = uaData.brands.some((b) =>
      /Chromium|Google Chrome|Microsoft Edge|Brave|Opera/i.test(b.brand)
    );
    return isChromium ? "supported" : "unsupported";
  }

  // UA fallback. Chrome / Chromium / Edg(e) / OPR (Opera) all match.
  // Firefox / Safari / FxiOS / etc. don't.
  if (/Chrome|Chromium|CriOS|Edg|OPR/.test(ua) && !/Firefox|FxiOS/.test(ua)) {
    // CriOS = Chrome on iOS, which is WebKit-backed and doesn't have
    // getDisplayMedia. Already filtered by the mobile/iOS check above
    // but defensive guard kept for clarity.
    if (/CriOS/.test(ua)) return "unsupported";
    return "supported";
  }

  return "unsupported";
}
