import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    server: {
        MASTER_USER_ID: z.string().optional(),
        MASTER_USER_NAME: z.string().optional(),
        MASTER_USER_EMAIL: z.string().optional(),
        MASTER_USER_PASSWORD: z.string().optional(),
        MASTER_USER_API_KEY: z.string().optional(),
        TRUSTED_ORIGINS: z.string().optional(),
        API_URL: z.string().optional(),
        AUTH_SECRET: z.string(),
        AUTH_CROSS_SUBDOMAIN_COOKIES: z.string().optional(),
        AUTH_COOKIE_DOMAIN: z.string().optional(),

        DATABASE_DIRECT_URL: z.string(),
        OPENWORKFLOW_DB_POOL_MAX: z.coerce.number().int().positive().default(2),
        OPENWORKFLOW_RUN_MIGRATIONS: z
            .enum(["true", "false"])
            .default("true")
            .transform((value) => value === "true"),
        S3_ACCESS_KEY_ID: z.string(),
        S3_SECRET_ACCESS_KEY: z.string(),
        S3_ENDPOINT: z.url(),
        S3_REGION: z.string(),
        S3_BUCKET: z.string(),
    },
    runtimeEnv: process.env,
});
