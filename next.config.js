/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
