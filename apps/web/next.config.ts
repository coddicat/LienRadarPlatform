import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@lienradar/shared", "@lienradar/db", "@lienradar/method", "@lienradar/ingest"],
  serverExternalPackages: ["@prisma/client", "bcryptjs", "playwright"],
};

export default nextConfig;
