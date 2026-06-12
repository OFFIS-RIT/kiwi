import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    server: {
        AUTH_SECRET: z.string(),

        S3_ACCESS_KEY_ID: z.string(),
        S3_SECRET_ACCESS_KEY: z.string(),
        S3_ENDPOINT: z.url(),
        S3_REGION: z.string(),
        S3_BUCKET: z.string(),

        // DB
        DATABASE_URL: z.string(),
        DATABASE_DIRECT_URL: z.string(),

        // Settings
        WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
        AI_TEXT_CONCURRENCY: z.coerce.number().int().positive().default(64),
        AI_IMAGE_CONCURRENCY: z.coerce.number().int().positive().default(64),
        AI_EMBEDDING_CONCURRENCY: z.coerce.number().int().positive().default(64),
        AI_AUDIO_CONCURRENCY: z.coerce.number().int().positive().default(64),
        AI_VIDEO_CONCURRENCY: z.coerce.number().int().positive().default(64),
    },
    runtimeEnv: process.env,
});
