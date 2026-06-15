import { db } from "@kiwi/db";
import { filesTable, type FileProcessStatus, type FileProcessStep } from "@kiwi/db/tables/graph";
import type { FileProcessErrorCode } from "@kiwi/contracts/routes";
import { eq } from "drizzle-orm";

export async function updateFileProcessingState(
    fileId: string,
    processStep: FileProcessStep,
    status: FileProcessStatus,
    processErrorCode?: FileProcessErrorCode | null
) {
    await db
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
        .where(eq(filesTable.id, fileId));
}

export async function stopIfFileDeleted(fileId: string) {
    const [file] = await db
        .select({ deleted: filesTable.deleted })
        .from(filesTable)
        .where(eq(filesTable.id, fileId))
        .limit(1);

    if (file?.deleted) {
        await updateFileProcessingState(fileId, "completed", "processed");
        return true;
    }

    return false;
}
