import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const adapterEnum = z.enum(["openai", "azure", "anthropic", "openaiAPI"]);
const embeddingAdapterEnum = z.enum(["openai", "azure", "openaiAPI"]);

export const env = createEnv({
    server: {
        S3_ACCESS_KEY_ID: z.string(),
        S3_SECRET_ACCESS_KEY: z.string(),
        S3_ENDPOINT: z.url(),
        S3_REGION: z.string(),
        S3_BUCKET: z.string(),

        // Text / Chat
        AI_TEXT_ADAPTER: adapterEnum,
        AI_TEXT_MODEL: z.string(),
        AI_TEXT_KEY: z.string(),
        AI_TEXT_URL: z.string().optional(),
        AI_TEXT_RESOURCE_NAME: z.string().optional(),

        // Embedding
        AI_EMBEDDING_ADAPTER: embeddingAdapterEnum,
        AI_EMBEDDING_MODEL: z.string(),
        AI_EMBEDDING_KEY: z.string(),
        AI_EMBEDDING_URL: z.string().optional(),
        AI_EMBEDDING_RESOURCE_NAME: z.string().optional(),

        // Image / Vision (optional – not all deployments need it)
        AI_IMAGE_ADAPTER: adapterEnum.optional(),
        AI_IMAGE_MODEL: z.string().optional(),
        AI_IMAGE_KEY: z.string().optional(),
        AI_IMAGE_URL: z.string().optional(),
        AI_IMAGE_RESOURCE_NAME: z.string().optional(),

        // Audio (optional – not all deployments need it)
        AI_AUDIO_ADAPTER: adapterEnum.optional(),
        AI_AUDIO_MODEL: z.string().optional(),
        AI_AUDIO_KEY: z.string().optional(),
        AI_AUDIO_URL: z.string().optional(),
        AI_AUDIO_RESOURCE_NAME: z.string().optional(),

        // DB
        DATABASE_URL: z.string(),
        
        // Settings
        WORKER_CONCURRENCY: z.coerce.number().optional(),
    },
    runtimeEnv: process.env,
});
