import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    output: "standalone",
    transpilePackages: ["@kiwi/auth"],
};

export default nextConfig;
