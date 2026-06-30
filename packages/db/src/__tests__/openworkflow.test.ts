import { beforeEach, describe, expect, mock, test } from "bun:test";

type PostgresOptions = {
    max: number;
    transform: {
        column: {
            from: unknown;
        };
    };
};

const pool = { kind: "postgres-pool" };
const backend = { kind: "openworkflow-backend" };
const postgresToCamel = (value: string) => value;
const postgresMock = Object.assign(mock((_databaseUrl: string, _options: PostgresOptions) => pool), {
    toCamel: postgresToCamel,
});
const backendFromPoolMock = mock((_pool: unknown) => backend);
const migrationStopMock = mock(async () => undefined);
const backendConnectMock = mock(async (_databaseUrl: string) => ({
    stop: migrationStopMock,
}));

mock.module("postgres", () => ({
    default: postgresMock,
}));

mock.module("openworkflow/postgres", () => ({
    BackendPostgres: {
        connect: backendConnectMock,
        fromPool: backendFromPoolMock,
    },
}));

const { connectOpenWorkflowBackend, runOpenWorkflowMigrations } = await import("../openworkflow");

beforeEach(() => {
    postgresMock.mockClear();
    backendFromPoolMock.mockClear();
    backendConnectMock.mockClear();
    migrationStopMock.mockClear();
});

describe("connectOpenWorkflowBackend", () => {
    test("creates the OpenWorkflow backend from a Postgres.js pool capped at the requested size", async () => {
        const result = await connectOpenWorkflowBackend("postgres://kiwi/openworkflow", {
            poolMax: 2,
            runMigrations: false,
        });

        expect(result).toBe(backend);
        expect(postgresMock).toHaveBeenCalledTimes(1);
        expect(postgresMock).toHaveBeenCalledWith("postgres://kiwi/openworkflow", {
            max: 2,
            transform: {
                column: {
                    from: postgresToCamel,
                },
            },
        });
        expect(backendFromPoolMock).toHaveBeenCalledTimes(1);
        expect(backendFromPoolMock).toHaveBeenCalledWith(pool);
        expect(backendConnectMock).not.toHaveBeenCalled();
        expect(migrationStopMock).not.toHaveBeenCalled();
    });

    test("passes a supplied pool cap through to Postgres.js", async () => {
        await connectOpenWorkflowBackend("postgres://kiwi/openworkflow", {
            poolMax: 7,
            runMigrations: false,
        });

        expect(postgresMock.mock.calls[0]?.[1]?.max).toBe(7);
        expect(backendFromPoolMock).toHaveBeenCalledWith(pool);
        expect(backendConnectMock).not.toHaveBeenCalled();
    });

    test("runs OpenWorkflow migrations once before opening the runtime pool when requested", async () => {
        const result = await connectOpenWorkflowBackend("postgres://kiwi/openworkflow", {
            poolMax: 2,
            runMigrations: true,
        });

        expect(result).toBe(backend);
        expect(backendConnectMock).toHaveBeenCalledTimes(1);
        expect(backendConnectMock).toHaveBeenCalledWith("postgres://kiwi/openworkflow");
        expect(migrationStopMock).toHaveBeenCalledTimes(1);
        expect(postgresMock).toHaveBeenCalledTimes(1);
        expect(backendFromPoolMock).toHaveBeenCalledTimes(1);
    });

    test("rejects invalid pool caps before touching OpenWorkflow or Postgres", async () => {
        for (const poolMax of [0, -1, 1.5, Number.NaN]) {
            await expect(
                connectOpenWorkflowBackend("postgres://kiwi/openworkflow", {
                    poolMax,
                    runMigrations: false,
                })
            ).rejects.toThrow("OPENWORKFLOW_DB_POOL_MAX must be a positive integer");
        }

        expect(postgresMock).not.toHaveBeenCalled();
        expect(backendFromPoolMock).not.toHaveBeenCalled();
        expect(backendConnectMock).not.toHaveBeenCalled();
    });
});

describe("runOpenWorkflowMigrations", () => {
    test("connects a dedicated migration backend once and stops it", async () => {
        await runOpenWorkflowMigrations("postgres://kiwi/direct");

        expect(backendConnectMock).toHaveBeenCalledTimes(1);
        expect(backendConnectMock).toHaveBeenCalledWith("postgres://kiwi/direct");
        expect(migrationStopMock).toHaveBeenCalledTimes(1);
        expect(postgresMock).not.toHaveBeenCalled();
        expect(backendFromPoolMock).not.toHaveBeenCalled();
    });
});
