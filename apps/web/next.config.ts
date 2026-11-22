import type { NextConfig } from "next";

// Next 16 keeps one dev lock per distDir, so two `next dev` servers can share apps/web only when their
// distDirs differ. scripts/dev.mjs sets NEXT_DIST_DIR for every named lab (MOHASSAN_LAB_DIR).
const distDir = process.env.NEXT_DIST_DIR || (process.env.MOHASSAN_ISOLATED_TEST === "true" ? ".next-e2e" : ".next");

const config: NextConfig = {
  distDir,
  transpilePackages: ["@mohassan/contracts"],
  experimental: { optimizePackageImports: ["@chakra-ui/react", "lucide-react"] },
};

export default config;
