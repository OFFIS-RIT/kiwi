import { defineConfig } from "drizzle-kit";

export default defineConfig({
    out: "./migrations",
    schema: "./packages/db/src/tables/*",
    dialect: "postgresql",
    dbCredentials: {
        url: (process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL) as string,
    },
});
