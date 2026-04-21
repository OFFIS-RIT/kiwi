import { BackendPostgres } from "openworkflow/postgres";
import { OpenWorkflow } from "openworkflow";
import { configureAIConcurrency } from "@kiwi/ai";
import { env } from "./env";

configureAIConcurrency({
    text: env.AI_TEXT_CONCURRENCY * env.WORKER_CONCURRENCY,
    image: env.AI_IMAGE_CONCURRENCY * env.WORKER_CONCURRENCY,
    embedding: env.AI_EMBEDDING_CONCURRENCY * env.WORKER_CONCURRENCY,
    audio: env.AI_AUDIO_CONCURRENCY * env.WORKER_CONCURRENCY,
});

export const backend = await BackendPostgres.connect(env.DATABASE_DIRECT_URL);
export const ow = new OpenWorkflow({ backend });
