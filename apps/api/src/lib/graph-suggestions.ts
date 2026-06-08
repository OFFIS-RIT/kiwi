import { embed } from "ai";
import { and, desc, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { estimateToken, withAiSlot } from "@kiwi/ai";
import type { GraphSuggestionApplySuccessData, GraphSuggestionRecord } from "@kiwi/contracts";
import { db } from "@kiwi/db";
import { filesTable, entityTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { graphSuggestionsTable, type GraphSuggestion } from "@kiwi/db/tables/suggestions";
import { putGraphFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { updateDescriptionsSpec } from "@kiwi/worker/update-descriptions-spec";
import { env } from "../env";
import { ow } from "../openworkflow";
import { API_ERROR_CODES } from "../types";
import { getRequiredResearchClient } from "./chat";
import { cleanupUploadedKeys } from "./graph-route";

const MANUAL_SUGGESTION_MIME_TYPE = "text/plain";
const MANUAL_SUGGESTION_FILE_TYPE = "text";

export const selectGraphSuggestionFields = {
    id: graphSuggestionsTable.id,
    graphId: graphSuggestionsTable.graphId,
    kind: graphSuggestionsTable.kind,
    status: graphSuggestionsTable.status,
    sourceId: graphSuggestionsTable.sourceId,
    entityId: graphSuggestionsTable.entityId,
    reference: graphSuggestionsTable.reference,
    suggestion: graphSuggestionsTable.suggestion,
    suggestedByUserId: graphSuggestionsTable.suggestedByUserId,
    chatId: graphSuggestionsTable.chatId,
    messageId: graphSuggestionsTable.messageId,
    appliedByUserId: graphSuggestionsTable.appliedByUserId,
    appliedSourceId: graphSuggestionsTable.appliedSourceId,
    appliedAt: graphSuggestionsTable.appliedAt,
    createdAt: graphSuggestionsTable.createdAt,
    updatedAt: graphSuggestionsTable.updatedAt,
};

type SelectedGraphSuggestion = Pick<
    GraphSuggestion,
    | "id"
    | "graphId"
    | "kind"
    | "status"
    | "sourceId"
    | "entityId"
    | "reference"
    | "suggestion"
    | "suggestedByUserId"
    | "chatId"
    | "messageId"
    | "appliedByUserId"
    | "appliedSourceId"
    | "appliedAt"
    | "createdAt"
    | "updatedAt"
>;

type ApplyMutationResult = {
    suggestion: GraphSuggestionRecord;
    sourceId: string;
    entityIds: string[];
    relationshipIds: string[];
};

type ManualSuggestionRowsInput = {
    graphId: string;
    suggestion: Pick<SelectedGraphSuggestion, "id" | "entityId" | "reference" | "suggestion">;
    fileId: string;
    textUnitId: string;
    sourceId: string;
    fileName: string;
    fileKey: string;
    fileSize: number;
    embedding: number[];
};

export function toGraphSuggestionRecord(row: SelectedGraphSuggestion): GraphSuggestionRecord {
    return {
        id: row.id,
        graph_id: row.graphId,
        kind: row.kind,
        status: row.status,
        source_id: row.sourceId,
        entity_id: row.entityId,
        reference: row.reference,
        suggestion: row.suggestion,
        suggested_by_user_id: row.suggestedByUserId,
        chat_id: row.chatId,
        message_id: row.messageId,
        applied_by_user_id: row.appliedByUserId,
        applied_source_id: row.appliedSourceId,
        applied_at: row.appliedAt?.toISOString() ?? null,
        created_at: row.createdAt?.toISOString() ?? new Date(0).toISOString(),
        updated_at: row.updatedAt?.toISOString() ?? new Date(0).toISOString(),
    };
}

export function buildManualSuggestionContent(suggestion: Pick<GraphSuggestion, "reference" | "suggestion">) {
    return ["Reference:", suggestion.reference, "", "Suggestion:", suggestion.suggestion].join("\n");
}

export function assertPendingGraphSuggestion<T extends Pick<GraphSuggestion, "status"> | undefined>(
    suggestion: T
): NonNullable<T> {
    if (!suggestion) {
        throw new Error(API_ERROR_CODES.SUGGESTION_NOT_FOUND);
    }

    if (suggestion.status !== "pending") {
        throw new Error(API_ERROR_CODES.INVALID_SUGGESTION);
    }

    return suggestion as NonNullable<T>;
}

export function buildSourceCorrectionUpdate(suggestion: Pick<GraphSuggestion, "suggestion">, embedding: number[]) {
    return {
        description: suggestion.suggestion,
        embedding,
        active: true,
    };
}

export function buildManualSuggestionRows(input: ManualSuggestionRowsInput) {
    const content = buildManualSuggestionContent(input.suggestion);

    return {
        file: {
            id: input.fileId,
            graphId: input.graphId,
            name: input.fileName,
            size: input.fileSize,
            type: MANUAL_SUGGESTION_FILE_TYPE,
            mimeType: MANUAL_SUGGESTION_MIME_TYPE,
            key: input.fileKey,
            status: "processed" as const,
            processStep: "completed" as const,
            tokenCount: estimateToken(content),
            metadata: JSON.stringify({
                source: "manual_suggestion",
                suggestionId: input.suggestion.id,
            }),
        },
        textUnit: {
            id: input.textUnitId,
            fileId: input.fileId,
            text: content,
        },
        source: {
            id: input.sourceId,
            entityId: input.suggestion.entityId,
            relationshipId: null,
            textUnitId: input.textUnitId,
            active: true,
            description: input.suggestion.suggestion,
            sourceChunkIds: [] as number[],
            embedding: input.embedding,
        },
    };
}

async function embedSuggestionText(suggestion: string) {
    const client = getRequiredResearchClient();
    const { embedding } = await withAiSlot("embedding", () =>
        embed({
            model: client.embedding,
            value: suggestion,
        })
    );

    return embedding;
}

async function getPendingSuggestion(graphId: string, suggestionId: string) {
    const [suggestion] = await db
        .select(selectGraphSuggestionFields)
        .from(graphSuggestionsTable)
        .where(and(eq(graphSuggestionsTable.graphId, graphId), eq(graphSuggestionsTable.id, suggestionId)))
        .limit(1);

    return assertPendingGraphSuggestion(suggestion);
}

async function assertSuggestionTargetExists(graphId: string, suggestion: SelectedGraphSuggestion) {
    if (suggestion.kind === "source_correction") {
        if (!suggestion.sourceId) {
            throw new Error(API_ERROR_CODES.INVALID_SUGGESTION);
        }

        const [source] = await db
            .select({ id: sourcesTable.id })
            .from(sourcesTable)
            .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
            .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
            .where(and(eq(sourcesTable.id, suggestion.sourceId), eq(filesTable.graphId, graphId)))
            .limit(1);

        if (!source) {
            throw new Error(API_ERROR_CODES.SOURCE_NOT_FOUND);
        }

        return;
    }

    if (!suggestion.entityId) {
        throw new Error(API_ERROR_CODES.INVALID_SUGGESTION);
    }

    const [entity] = await db
        .select({ id: entityTable.id })
        .from(entityTable)
        .where(
            and(eq(entityTable.id, suggestion.entityId), eq(entityTable.graphId, graphId), eq(entityTable.active, true))
        )
        .limit(1);

    if (!entity) {
        throw new Error(API_ERROR_CODES.INVALID_SUGGESTION);
    }
}

async function loadPendingSuggestionForUpdate(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    graphId: string,
    suggestionId: string
) {
    const [suggestion] = await tx
        .select(selectGraphSuggestionFields)
        .from(graphSuggestionsTable)
        .where(and(eq(graphSuggestionsTable.graphId, graphId), eq(graphSuggestionsTable.id, suggestionId)))
        .for("update")
        .limit(1);

    return assertPendingGraphSuggestion(suggestion);
}

async function enqueueDescriptionUpdate(graphId: string, entityIds: string[], relationshipIds: string[]) {
    if (entityIds.length === 0 && relationshipIds.length === 0) {
        return null;
    }

    const handle = await ow.runWorkflow(updateDescriptionsSpec, {
        graphId,
        entityIds,
        relationshipIds,
    });

    return handle.workflowRun.id;
}

export async function listPendingGraphSuggestions(graphId: string): Promise<GraphSuggestionRecord[]> {
    const rows = await db
        .select(selectGraphSuggestionFields)
        .from(graphSuggestionsTable)
        .where(and(eq(graphSuggestionsTable.graphId, graphId), eq(graphSuggestionsTable.status, "pending")))
        .orderBy(desc(graphSuggestionsTable.createdAt), desc(graphSuggestionsTable.id));

    return rows.map(toGraphSuggestionRecord);
}

export async function deletePendingGraphSuggestion(graphId: string, suggestionId: string) {
    return db.transaction(async (tx) => {
        const suggestion = await loadPendingSuggestionForUpdate(tx, graphId, suggestionId);

        await tx.delete(graphSuggestionsTable).where(eq(graphSuggestionsTable.id, suggestion.id));
    });
}

async function applySourceCorrection(options: {
    graphId: string;
    suggestionId: string;
    userId: string;
    embedding: number[];
}): Promise<ApplyMutationResult> {
    return db.transaction(async (tx) => {
        const suggestion = await loadPendingSuggestionForUpdate(tx, options.graphId, options.suggestionId);
        if (suggestion.kind !== "source_correction" || !suggestion.sourceId) {
            throw new Error(API_ERROR_CODES.INVALID_SUGGESTION);
        }

        const [source] = await tx
            .select({
                id: sourcesTable.id,
                entityId: sourcesTable.entityId,
                relationshipId: sourcesTable.relationshipId,
            })
            .from(sourcesTable)
            .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
            .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
            .where(and(eq(sourcesTable.id, suggestion.sourceId), eq(filesTable.graphId, options.graphId)))
            .limit(1);

        if (!source) {
            throw new Error(API_ERROR_CODES.SOURCE_NOT_FOUND);
        }

        await tx
            .update(sourcesTable)
            .set(buildSourceCorrectionUpdate(suggestion, options.embedding))
            .where(eq(sourcesTable.id, source.id));

        const [appliedSuggestion] = await tx
            .update(graphSuggestionsTable)
            .set({
                status: "applied",
                appliedByUserId: options.userId,
                appliedSourceId: source.id,
                appliedAt: sql`NOW()`,
            })
            .where(eq(graphSuggestionsTable.id, suggestion.id))
            .returning(selectGraphSuggestionFields);

        return {
            suggestion: toGraphSuggestionRecord(appliedSuggestion ?? suggestion),
            sourceId: source.id,
            entityIds: source.entityId ? [source.entityId] : [],
            relationshipIds: source.relationshipId ? [source.relationshipId] : [],
        };
    });
}

async function applyEntityAddition(options: {
    graphId: string;
    suggestionId: string;
    userId: string;
    embedding: number[];
}): Promise<ApplyMutationResult> {
    const suggestion = await getPendingSuggestion(options.graphId, options.suggestionId);
    if (suggestion.kind !== "entity_addition" || !suggestion.entityId) {
        throw new Error(API_ERROR_CODES.INVALID_SUGGESTION);
    }

    const fileId = ulid();
    const textUnitId = ulid();
    const sourceId = ulid();
    const fileName = `manual-suggestion-${suggestion.id}.txt`;
    const content = buildManualSuggestionContent(suggestion);
    const file = new File([content], fileName, { type: MANUAL_SUGGESTION_MIME_TYPE });
    const upload = await putGraphFile(options.graphId, fileId, fileName, file, env.S3_BUCKET);

    try {
        return await db.transaction(async (tx) => {
            const currentSuggestion = await loadPendingSuggestionForUpdate(tx, options.graphId, options.suggestionId);
            if (
                currentSuggestion.kind !== "entity_addition" ||
                !currentSuggestion.entityId ||
                currentSuggestion.entityId !== suggestion.entityId
            ) {
                throw new Error(API_ERROR_CODES.INVALID_SUGGESTION);
            }

            const [entity] = await tx
                .select({ id: entityTable.id })
                .from(entityTable)
                .where(
                    and(
                        eq(entityTable.id, currentSuggestion.entityId),
                        eq(entityTable.graphId, options.graphId),
                        eq(entityTable.active, true)
                    )
                )
                .limit(1);

            if (!entity) {
                throw new Error(API_ERROR_CODES.INVALID_SUGGESTION);
            }

            const rows = buildManualSuggestionRows({
                graphId: options.graphId,
                suggestion: currentSuggestion,
                fileId,
                textUnitId,
                sourceId,
                fileName,
                fileKey: upload.key,
                fileSize: file.size,
                embedding: options.embedding,
            });

            await tx.insert(filesTable).values(rows.file);
            await tx.insert(textUnitTable).values(rows.textUnit);
            await tx.insert(sourcesTable).values({
                ...rows.source,
                entityId: entity.id,
            });

            const [appliedSuggestion] = await tx
                .update(graphSuggestionsTable)
                .set({
                    status: "applied",
                    appliedByUserId: options.userId,
                    appliedSourceId: sourceId,
                    appliedAt: sql`NOW()`,
                })
                .where(eq(graphSuggestionsTable.id, currentSuggestion.id))
                .returning(selectGraphSuggestionFields);

            return {
                suggestion: toGraphSuggestionRecord(appliedSuggestion ?? currentSuggestion),
                sourceId,
                entityIds: [entity.id],
                relationshipIds: [],
            };
        });
    } catch (error) {
        await cleanupUploadedKeys([upload.key]).catch((cleanupError) => {
            logError("failed to clean up uploaded key after apply transaction failure", {
                key: upload.key,
                cleanupError,
            });
        });
        throw error;
    }
}

export async function applyGraphSuggestion(
    graphId: string,
    suggestionId: string,
    userId: string
): Promise<GraphSuggestionApplySuccessData> {
    const suggestion = await getPendingSuggestion(graphId, suggestionId);
    await assertSuggestionTargetExists(graphId, suggestion);
    const embedding = await embedSuggestionText(suggestion.suggestion);
    const applied =
        suggestion.kind === "source_correction"
            ? await applySourceCorrection({ graphId, suggestionId, userId, embedding })
            : await applyEntityAddition({ graphId, suggestionId, userId, embedding });

    try {
        const workflowRunId = await enqueueDescriptionUpdate(graphId, applied.entityIds, applied.relationshipIds);

        return {
            suggestion: applied.suggestion,
            sourceId: applied.sourceId,
            workflowRunId,
        };
    } catch (error) {
        logError("graph suggestion description update enqueue failed", {
            graphId,
            suggestionId,
            sourceId: applied.sourceId,
            error,
        });

        return {
            suggestion: applied.suggestion,
            sourceId: applied.sourceId,
            workflowRunId: null,
            warnings: ["Description regeneration could not be queued after applying the suggestion"],
        };
    }
}
