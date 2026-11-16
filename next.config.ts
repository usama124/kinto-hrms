import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // The app never uses next/image, so the /_next/image optimizer is switched off: Next 16.1.x has
  // unauthenticated-RCE advisories in that endpoint (AVIF/SVG). Still upgrade Next — see the security notes.
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default nextConfig;
