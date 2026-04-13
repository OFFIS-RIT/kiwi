import { env } from "../env";

export const DESCRIPTION_BATCH_SIZE = Math.min(env.AI_TEXT_CONCURRENCY, env.AI_EMBEDDING_CONCURRENCY);
