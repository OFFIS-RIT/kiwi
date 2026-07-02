import { WorkflowBackend, WorkflowClient } from "@kiwi/workflow";
import { configureAIConcurrency } from "@kiwi/ai";
import { bootstrapLegacyModelsFromEnv } from "@kiwi/ai/models";
import { getLogger } from "@kiwi/logger";
import { runWorkerEffect } from "./lib/runtime/effect";
import { env } from "./env";

configureAIConcurrency({
    text: env.AI_TEXT_CONCURRENCY,
    image: env.AI_IMAGE_CONCURRENCY,
    embedding: env.AI_EMBEDDING_CONCURRENCY,
    audio: env.AI_AUDIO_CONCURRENCY,
    video: env.AI_VIDEO_CONCURRENCY,
});

await runWorkerEffect(bootstrapLegacyModelsFromEnv({ env: process.env }));

export const workflowBackend = new WorkflowBackend();
export const wo = new WorkflowClient({ backend: workflowBackend, logger: getLogger() });
