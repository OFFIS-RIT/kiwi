import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { filesTable, type FileProcessStatus, type FileProcessStep } from "@kiwi/db/tables/graph";
import type { FileProcessErrorCode } from "@kiwi/contracts/routes";
import { eq } from "drizzle-orm";

export function updateFileProcessingState(
    fileId: string,
    processStep: FileProcessStep,
    status: FileProcessStatus,
    processErrorCode?: FileProcessErrorCode | null
): Effect.Effect<void, unknown> {
    return Effect.tryPromise(() =>
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
            .then(() => undefined)
    );
}

export function stopIfFileDeleted(fileId: string): Effect.Effect<boolean, unknown> {
    return Effect.gen(function* () {
        const [file] = yield* Effect.tryPromise(() =>
            db
                .select({ deleted: filesTable.deleted })
                .from(filesTable)
                .where(eq(filesTable.id, fileId))
                .limit(1)
        );

        if (file?.deleted) {
            yield* updateFileProcessingState(fileId, "completed", "processed");
            return true;
        }

        return false;
    });
}
