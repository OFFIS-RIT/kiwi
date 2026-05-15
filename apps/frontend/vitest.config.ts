import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        environment: "jsdom",
        environmentOptions: {
            jsdom: {
                url: "http://localhost",
            },
        },
        globals: true,
        setupFiles: ["./vitest.setup.tsx"],
        include: ["**/*.test.{ts,tsx}"],
        exclude: ["node_modules"],
    },
});
