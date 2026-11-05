import type { NextConfig } from "next";

const config: NextConfig = {
  distDir: process.env.MOHASSAN_ISOLATED_TEST === "true" ? ".next-e2e" : ".next",
  transpilePackages: ["@mohassan/contracts"],
  experimental: { optimizePackageImports: ["@chakra-ui/react", "lucide-react"] },
};

export default config;
