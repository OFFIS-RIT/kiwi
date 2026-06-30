import { runOpenWorkflowMigrations } from "@kiwi/db/openworkflow";

const databaseUrl = process.env.DATABASE_DIRECT_URL;

if (!databaseUrl) {
    throw new Error("DATABASE_DIRECT_URL is required to run OpenWorkflow migrations");
}

await runOpenWorkflowMigrations(databaseUrl);
