import type { NextConfig } from "next";

const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4321";

const nextConfig: NextConfig = {
    output: "standalone",
    transpilePackages: ["@kiwi/auth"],
    async rewrites() {
        return [
            {
                source: "/api/:path*",
                destination: `${apiUrl}/:path*`,
            },
            {
                source: "/auth/:path*",
                destination: `${apiUrl}/auth/:path*`,
            },
        ];
    },
};

export default nextConfig;
