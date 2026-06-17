import { BackendPostgres } from "openworkflow/postgres";
import { OpenWorkflow } from "openworkflow";
import * as Effect from "effect/Effect";
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

await Effect.runPromise(bootstrapLegacyModelsFromEnv({ secret: env.AUTH_SECRET }));

export const backend = await BackendPostgres.connect(env.DATABASE_DIRECT_URL);
export const ow = new OpenWorkflow({ backend });
