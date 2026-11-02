import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: { optimizePackageImports: ["@chakra-ui/react"] },
  poweredByHeader: false,
};

export default nextConfig;
