import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "."),
        },
    },
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
