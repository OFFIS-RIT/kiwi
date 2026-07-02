import { eq } from "@kiwi/db/drizzle";
import type { DatabaseTransaction } from "@kiwi/db/effect";
import { processRunFilesTable, processRunsTable } from "@kiwi/db/tables/graph";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ProcessRunCreationError extends Schema.TaggedErrorClass<ProcessRunCreationError>()(
    "ProcessRunCreationError",
    {
        message: Schema.String,
    }
) {}

type ProcessRunRef = {
    id: string;
};

export function createProcessRun(
    tx: DatabaseTransaction,
    options: { graphId: string }
): Effect.Effect<ProcessRunRef, unknown> {
    return Effect.gen(function* () {
        const [processRun] = yield* tx
            .insert(processRunsTable)
            .values({ graphId: options.graphId, status: "pending" })
            .returning({ id: processRunsTable.id });

        if (!processRun) {
            return yield* Effect.fail(new ProcessRunCreationError({ message: "Failed to create process run" }));
        }

        return processRun;
    });
}

export function addFilesToProcessRun(
    tx: DatabaseTransaction,
    options: { processRunId: string; fileIds: readonly string[] }
): Effect.Effect<void, unknown> {
    if (options.fileIds.length === 0) {
        return Effect.void;
    }

    return Effect.asVoid(
        tx.insert(processRunFilesTable).values(
            options.fileIds.map((fileId) => ({
                processRunId: options.processRunId,
                fileId,
            }))
        )
    );
}

export function assignFilesToProcessRun(
    tx: DatabaseTransaction,
    options: { graphId: string; fileIds: readonly string[]; processRunId?: string }
): Effect.Effect<ProcessRunRef, unknown> {
    return Effect.gen(function* () {
        const processRun = options.processRunId
            ? { id: options.processRunId }
            : yield* createProcessRun(tx, { graphId: options.graphId });

        yield* addFilesToProcessRun(tx, {
            processRunId: processRun.id,
            fileIds: options.fileIds,
        });

        return processRun;
    });
}

export function deleteProcessRun(
    tx: DatabaseTransaction,
    options: { processRunId: string }
): Effect.Effect<void, unknown> {
    return Effect.asVoid(tx.delete(processRunsTable).where(eq(processRunsTable.id, options.processRunId)));
}
