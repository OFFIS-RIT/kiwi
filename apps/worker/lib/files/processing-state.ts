import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import { withWorkerDb, withWorkerDbVoid } from "../runtime/effect";
import { filesTable, type FileProcessStatus, type FileProcessStep } from "@kiwi/db/tables/graph";
import type { FileProcessErrorCode } from "@kiwi/contracts/routes";
import { eq } from "@kiwi/db/drizzle";

export function updateFileProcessingState(
    fileId: string,
    processStep: FileProcessStep,
    status: FileProcessStatus,
    processErrorCode?: FileProcessErrorCode | null
): Effect.Effect<void, unknown, Database> {
    return withWorkerDbVoid((db) =>
        db
            .update(filesTable)
            .set({
                processStep,
                status,
                ...(processErrorCode !== undefined
                    ? { processErrorCode }
                    : status === "failed"
                      ? {}
                      : { processErrorCode: null }),
            })
            .where(eq(filesTable.id, fileId))
    );
}

export function stopIfFileDeleted(fileId: string): Effect.Effect<boolean, unknown, Database> {
    return Effect.gen(function* () {
        const [file] = yield* withWorkerDb((db) =>
            db.select({ deleted: filesTable.deleted }).from(filesTable).where(eq(filesTable.id, fileId)).limit(1)
        );

        if (file?.deleted) {
            yield* updateFileProcessingState(fileId, "completed", "processed");
            return true;
        }

        return false;
    });
}
