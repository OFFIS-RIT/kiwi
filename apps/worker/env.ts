import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const adapterEnum = z.enum(["openai", "azure", "anthropic", "openaiAPI"]);
const embeddingAdapterEnum = z.enum(["openai", "azure", "openaiAPI"]);
const transcriptionAdapterEnum = z.enum(["openai", "azure", "openaiAPI"]);
const documentModeEnum = z.enum(["plain", "hybrid", "ocr"]);
const optionalEnvString = z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().optional()
);
const optionalAdapterEnum = z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    adapterEnum.optional()
);
const optionalTranscriptionAdapterEnum = z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    transcriptionAdapterEnum.optional()
);

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
        AI_IMAGE_ADAPTER: optionalAdapterEnum,
        AI_IMAGE_MODEL: optionalEnvString,
        AI_IMAGE_KEY: optionalEnvString,
        AI_IMAGE_URL: optionalEnvString,
        AI_IMAGE_RESOURCE_NAME: optionalEnvString,

        // Audio (optional – not all deployments need it)
        AI_AUDIO_ADAPTER: optionalTranscriptionAdapterEnum,
        AI_AUDIO_MODEL: optionalEnvString,
        AI_AUDIO_KEY: optionalEnvString,
        AI_AUDIO_URL: optionalEnvString,
        AI_AUDIO_RESOURCE_NAME: optionalEnvString,

        // Video (optional – not all deployments need it)
        AI_VIDEO_ADAPTER: optionalTranscriptionAdapterEnum,
        AI_VIDEO_MODEL: optionalEnvString,
        AI_VIDEO_KEY: optionalEnvString,
        AI_VIDEO_URL: optionalEnvString,
        AI_VIDEO_RESOURCE_NAME: optionalEnvString,

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
