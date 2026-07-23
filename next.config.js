/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fully disable Next.js dev-mode indicators — the runtime "1 Issue"
  // pill, build activity spinner, etc. They surface noise the user
  // doesn't want during live coaching sessions. Errors still reach
  // the browser console for developer-debugging; this only kills the
  // floating UI badge. Production builds don't show indicators
  // either way, so this is dev-only behavior.
  //
  // Note: `devIndicators: false` only disables the build-activity
  // spinner in Next 15. The runtime error pill ("1 Issue") is
  // separately triggered by uncaught errors / unhandled rejections /
  // console.error. We avoid it by:
  //   - downgrading client console.error to console.warn
  //   - replacing throws in async client code with custom-event
  //     dispatches the page handles via setLiveStatus("idle")
  //   - guard-railing flows so errored payloads never get sent
  //     (e.g. skip scoring on empty sessions before the API rejects)
  // Combined, these stop the pill from ever appearing.
  devIndicators: false,
  // Disable webpack's persistent file cache in dev. On Windows the .next/
  // cache/webpack/*.pack.gz files routinely fail to rename atomically when
  // the dev server is busy (ENOENT errors followed by a hung compile). The
  // cache is a "compile faster the second time" optimization; disabling it
  // means slower restarts but no more mid-session hangs.
  webpack: (config, { dev }) => {
    if (dev) {
      config.cache = false;
    }
    return config;
  },
};

module.exports = nextConfig;
