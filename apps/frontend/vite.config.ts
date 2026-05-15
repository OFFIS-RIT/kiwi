import tailwindcss from "@tailwindcss/vite";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
    plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
    server: {
        proxy: {
            "/api": {
                target: "http://localhost:4321",
                rewrite: (path) => path.replace(/^\/api/, ""),
            },
            "/auth": {
                target: "http://localhost:4321",
            },
            "/s3": {
                target: "http://localhost:9000",
                rewrite: (path) => path.replace(/^\/s3/, ""),
            },
        },
    },
});
