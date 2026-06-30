import { connectOpenWorkflowBackend } from "@kiwi/db/openworkflow";
import { OpenWorkflow } from "openworkflow";
import { env } from "./env";

export const backend = await connectOpenWorkflowBackend(env.DATABASE_DIRECT_URL, {
    poolMax: env.OPENWORKFLOW_DB_POOL_MAX,
    runMigrations: env.OPENWORKFLOW_RUN_MIGRATIONS,
});
export const ow = new OpenWorkflow({ backend });
