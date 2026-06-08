import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const adapterEnum = z.enum(["openai", "azure", "anthropic", "openaiAPI"]);
const embeddingAdapterEnum = z.enum(["openai", "azure", "openaiAPI"]);
const transcriptionAdapterEnum = z.enum(["openai", "azure", "openaiAPI"]);
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

export const DEFAULT_CONTEXT_WINDOW = 250_000;
export const isContextWindowDefaulted = process.env.CONTEXT_WINDOW === undefined;

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
        S3_ACCESS_KEY_ID: z.string(),
        S3_SECRET_ACCESS_KEY: z.string(),
        S3_ENDPOINT: z.url(),
        S3_REGION: z.string(),
        S3_BUCKET: z.string(),

        // Text / Chat
        CONTEXT_WINDOW: z.coerce.number().int().positive().default(DEFAULT_CONTEXT_WINDOW),
        AI_TEXT_ADAPTER: adapterEnum,
        AI_TEXT_MODEL: z.string(),
        AI_TEXT_KEY: z.string(),
        AI_TEXT_URL: z.string().optional(),
        AI_TEXT_RESOURCE_NAME: z.string().optional(),
        AI_SUBAGENT_MODEL: z.string().optional(),

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
    },
    runtimeEnv: process.env,
});
