import { BackendPostgres } from "openworkflow/postgres";
import postgres from "postgres";

export const OPENWORKFLOW_MIGRATIONS_READY_ENV = "KIWI_OPENWORKFLOW_MIGRATIONS_READY";

type ConnectOpenWorkflowBackendOptions = {
    poolMax: number;
    runMigrations: boolean;
};

export async function connectOpenWorkflowBackend(databaseUrl: string, options: ConnectOpenWorkflowBackendOptions) {
    assertValidPoolMax(options.poolMax);

    if (options.runMigrations) {
        await runOpenWorkflowMigrations(databaseUrl);
    }

    const pool = postgres(databaseUrl, {
        max: options.poolMax,
        transform: {
            column: {
                from: postgres.toCamel,
            },
        },
    });

    return BackendPostgres.fromPool(pool);
}

export async function runOpenWorkflowMigrations(databaseUrl: string) {
    const migrationBackend = await BackendPostgres.connect(databaseUrl);
    await migrationBackend.stop();
}

function assertValidPoolMax(poolMax: number) {
    if (!Number.isInteger(poolMax) || poolMax < 1) {
        throw new Error("OPENWORKFLOW_DB_POOL_MAX must be a positive integer");
    }
}
