import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@lienradar/shared", "@lienradar/db", "@lienradar/method", "@lienradar/ingest"],
  // Keep Playwright / pdf-parse external so Chromium + pdf.worker.mjs resolve from node_modules
  // (Next bundling breaks admin-triggered calendar/tax jobs on App Platform).
  serverExternalPackages: ["@prisma/client", "bcryptjs", "playwright", "pdf-parse"],
};

export default nextConfig;
