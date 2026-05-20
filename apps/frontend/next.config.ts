import path from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
    output: "standalone",
    outputFileTracingRoot: path.join(__dirname, "../.."),
    outputFileTracingIncludes: {
        "/**/*": ["./messages/*.json"],
    },
    transpilePackages: ["@kiwi/auth"],
    experimental: {
        authInterrupts: true,
    },
    images: {
        remotePatterns: [{ protocol: "https", hostname: "lh3.googleusercontent.com" }],
        minimumCacheTTL: 60 * 60 * 24,
    },
};

export default withNextIntl(nextConfig);
