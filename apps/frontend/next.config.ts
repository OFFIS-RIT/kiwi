import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    output: "export",
    assetPrefix: "/",
    transpilePackages: ["@kiwi/auth"],
};

export default nextConfig;
