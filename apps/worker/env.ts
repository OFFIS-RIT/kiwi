import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const adapterEnum = z.enum(["openai", "azure", "anthropic", "openaiAPI"]);
const embeddingAdapterEnum = z.enum(["openai", "azure", "openaiAPI"]);
const documentModeEnum = z.enum(["plain", "hybrid", "ocr"]);
const optionalEnvString = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
const optionalAdapterEnum = z.preprocess((value) => (value === "" ? undefined : value), adapterEnum.optional());

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

        // Worker text model override; falls back to AI_TEXT_* when unset.
        AI_EXTRACT_ADAPTER: optionalAdapterEnum,
        AI_EXTRACT_MODEL: optionalEnvString,
        AI_EXTRACT_KEY: optionalEnvString,
        AI_EXTRACT_URL: optionalEnvString,
        AI_EXTRACT_RESOURCE_NAME: optionalEnvString,

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

        // Video (optional – not all deployments need it)
        AI_VIDEO_ADAPTER: adapterEnum.optional(),
        AI_VIDEO_MODEL: z.string().optional(),
        AI_VIDEO_KEY: z.string().optional(),
        AI_VIDEO_URL: z.string().optional(),
        AI_VIDEO_RESOURCE_NAME: z.string().optional(),

        // DB
        DATABASE_URL: z.string(),
        DATABASE_DIRECT_URL: z.string(),

        // Settings
        DOCUMENT_MODE: documentModeEnum.default("hybrid"),
        WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
        AI_TEXT_CONCURRENCY: z.coerce.number().int().positive().default(64),
        AI_IMAGE_CONCURRENCY: z.coerce.number().int().positive().default(64),
        AI_EMBEDDING_CONCURRENCY: z.coerce.number().int().positive().default(64),
        AI_AUDIO_CONCURRENCY: z.coerce.number().int().positive().default(64),
        AI_VIDEO_CONCURRENCY: z.coerce.number().int().positive().default(64),
    },
    runtimeEnv: process.env,
});
