import {
    connectOpenWorkflowBackend,
    OPENWORKFLOW_MIGRATIONS_READY_ENV,
} from "@kiwi/db/openworkflow";
import { OpenWorkflow } from "openworkflow";
import { configureAIConcurrency } from "@kiwi/ai";
import { bootstrapLegacyModelsFromEnv } from "@kiwi/ai/models";
import { env } from "./env";

configureAIConcurrency({
    text: env.AI_TEXT_CONCURRENCY,
    image: env.AI_IMAGE_CONCURRENCY,
    embedding: env.AI_EMBEDDING_CONCURRENCY,
    audio: env.AI_AUDIO_CONCURRENCY,
    video: env.AI_VIDEO_CONCURRENCY,
});

await bootstrapLegacyModelsFromEnv({ secret: env.AUTH_SECRET });

export const backend = await connectOpenWorkflowBackend(env.DATABASE_DIRECT_URL, {
    poolMax: env.OPENWORKFLOW_DB_POOL_MAX,
    runMigrations: env.OPENWORKFLOW_RUN_MIGRATIONS && process.env[OPENWORKFLOW_MIGRATIONS_READY_ENV] !== "1",
});
export const ow = new OpenWorkflow({ backend });
