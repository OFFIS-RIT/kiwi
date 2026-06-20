import { and, desc, eq, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { ulid } from "ulid";
import { estimateToken, getClient } from "@kiwi/ai";
import { resolveRequiredEmbeddingModelAdapter } from "@kiwi/ai/models";
import type { GraphSuggestionApplySuccessData, GraphSuggestionRecord } from "@kiwi/contracts";
import { tryDb, tryDbVoid, type Database, type DatabaseError } from "@kiwi/db/effect";
import { filesTable, entityTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { graphSuggestionsTable, type GraphSuggestion } from "@kiwi/db/tables/suggestions";
import { putGraphFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { updateDescriptionsSpec } from "@kiwi/worker/update-descriptions-spec";
import { env } from "../env";
import { ow } from "../openworkflow";
import { API_ERROR_CODES } from "../types";
import { cleanupUploadedKeys } from "./graph/route";
import type { AuthUser } from "../middleware/auth";
import { embedText } from "./embed-text";
import { resolveGraphOwnerRoot } from "./graph/access";
import { getActiveOrganizationId, requireOrganizationMembership } from "./team/access";

function tryUnknownPromise<T>(thunk: () => PromiseLike<T>): Effect.Effect<T, unknown> {
    return Effect.tryPromise({ try: thunk, catch: (error) => error });
}

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

function getSuggestionModelOrganizationId(graphId: string, user: AuthUser): Effect.Effect<string, unknown, Database> {
    return Effect.gen(function* () {
        const rootOwner = yield* resolveGraphOwnerRoot(graphId);
        const organizationId =
            rootOwner.mode === "user" ? yield* getActiveOrganizationId(user) : rootOwner.organizationId;

        yield* requireOrganizationMembership(user, organizationId);

        return organizationId;
    });
}

function embedSuggestionText(
    graphId: string,
    user: AuthUser,
    suggestion: string
): Effect.Effect<number[], unknown, Database> {
    return Effect.gen(function* () {
        const organizationId = yield* getSuggestionModelOrganizationId(graphId, user);
        const embeddingModel = yield* resolveRequiredEmbeddingModelAdapter(organizationId, env.AUTH_SECRET);
        const client = getClient({ embedding: embeddingModel.adapter });
        const { embedding: embeddingClient } = client;
        if (!embeddingClient) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.MODEL_NOT_CONFIGURED));
        }

        return yield* embedText(embeddingClient, suggestion);
    });
}

function getPendingSuggestion(
    graphId: string,
    suggestionId: string
): Effect.Effect<SelectedGraphSuggestion, DatabaseError | Error, Database> {
    return Effect.gen(function* () {
        const [suggestion] = yield* tryDb((db) =>
            db
                .select(selectGraphSuggestionFields)
                .from(graphSuggestionsTable)
                .where(and(eq(graphSuggestionsTable.graphId, graphId), eq(graphSuggestionsTable.id, suggestionId)))
                .limit(1)
        );

        return yield* Effect.try({
            try: () => assertPendingGraphSuggestion(suggestion),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });
    });
}

function assertSuggestionTargetExists(
    graphId: string,
    suggestion: SelectedGraphSuggestion
): Effect.Effect<void, unknown, Database> {
    return Effect.gen(function* () {
        if (suggestion.kind === "source_correction") {
            if (!suggestion.sourceId) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.INVALID_SUGGESTION));
            }
            const sourceId = suggestion.sourceId;

            const [source] = yield* tryDb((db) =>
                db
                    .select({ id: sourcesTable.id })
                    .from(sourcesTable)
                    .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
                    .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
                    .where(and(eq(sourcesTable.id, sourceId), eq(filesTable.graphId, graphId)))
                    .limit(1)
            );

            if (!source) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.SOURCE_NOT_FOUND));
            }

            return;
        }

        if (!suggestion.entityId) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.INVALID_SUGGESTION));
        }
        const entityId = suggestion.entityId;

        const [entity] = yield* tryDb((db) =>
            db
                .select({ id: entityTable.id })
                .from(entityTable)
                .where(
                    and(eq(entityTable.id, entityId), eq(entityTable.graphId, graphId), eq(entityTable.active, true))
                )
                .limit(1)
        );

        if (!entity) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.INVALID_SUGGESTION));
        }
    });
}

function enqueueDescriptionUpdate(
    graphId: string,
    entityIds: string[],
    relationshipIds: string[]
): Effect.Effect<string | null, unknown> {
    if (entityIds.length === 0 && relationshipIds.length === 0) {
        return Effect.succeed(null);
    }

    return Effect.map(
        tryUnknownPromise(() =>
            ow.runWorkflow(updateDescriptionsSpec, {
                graphId,
                entityIds,
                relationshipIds,
            })
        ),
        (handle) => handle.workflowRun.id
    );
}

export function listPendingGraphSuggestions(
    graphId: string
): Effect.Effect<GraphSuggestionRecord[], DatabaseError, Database> {
    return Effect.map(
        tryDb((db) =>
            db
                .select(selectGraphSuggestionFields)
                .from(graphSuggestionsTable)
                .where(and(eq(graphSuggestionsTable.graphId, graphId), eq(graphSuggestionsTable.status, "pending")))
                .orderBy(desc(graphSuggestionsTable.createdAt), desc(graphSuggestionsTable.id))
        ),
        (rows) => rows.map(toGraphSuggestionRecord)
    );
}

export function deletePendingGraphSuggestion(
    graphId: string,
    suggestionId: string
): Effect.Effect<void, unknown, Database> {
    return tryDbVoid((db) =>
        db.transaction((tx) =>
            Effect.gen(function* (): Generator<Effect.Effect<unknown, unknown>, void> {
                const [suggestionRow] = yield* tx
                    .select(selectGraphSuggestionFields)
                    .from(graphSuggestionsTable)
                    .where(and(eq(graphSuggestionsTable.graphId, graphId), eq(graphSuggestionsTable.id, suggestionId)))
                    .for("update")
                    .limit(1);
                const suggestion = assertPendingGraphSuggestion(suggestionRow);

                yield* tx.delete(graphSuggestionsTable).where(eq(graphSuggestionsTable.id, suggestion.id));
            })
        )
    );
}

function applySourceCorrection(options: {
    graphId: string;
    suggestionId: string;
    userId: string;
    embedding: number[];
}): Effect.Effect<ApplyMutationResult, unknown, Database> {
    return tryDb((db) =>
        db.transaction((tx) =>
            Effect.gen(function* (): Generator<Effect.Effect<unknown, unknown>, ApplyMutationResult> {
                const [suggestionRow] = yield* tx
                    .select(selectGraphSuggestionFields)
                    .from(graphSuggestionsTable)
                    .where(
                        and(
                            eq(graphSuggestionsTable.graphId, options.graphId),
                            eq(graphSuggestionsTable.id, options.suggestionId)
                        )
                    )
                    .for("update")
                    .limit(1);
                const suggestion = assertPendingGraphSuggestion(suggestionRow);
                if (suggestion.kind !== "source_correction" || !suggestion.sourceId) {
                    throw new Error(API_ERROR_CODES.INVALID_SUGGESTION);
                }

                const [source] = yield* tx
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

                yield* tx
                    .update(sourcesTable)
                    .set(buildSourceCorrectionUpdate(suggestion, options.embedding))
                    .where(eq(sourcesTable.id, source.id));

                const [appliedSuggestion] = yield* tx
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
            })
        )
    );
}

function applyEntityAddition(options: {
    graphId: string;
    suggestionId: string;
    userId: string;
    embedding: number[];
}): Effect.Effect<ApplyMutationResult, unknown, Database> {
    return Effect.gen(function* () {
        const suggestion = yield* getPendingSuggestion(options.graphId, options.suggestionId);
        if (suggestion.kind !== "entity_addition" || !suggestion.entityId) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.INVALID_SUGGESTION));
        }

        const fileId = ulid();
        const textUnitId = ulid();
        const sourceId = ulid();
        const fileName = `manual-suggestion-${suggestion.id}.txt`;
        const content = buildManualSuggestionContent(suggestion);
        const file = new File([content], fileName, { type: MANUAL_SUGGESTION_MIME_TYPE });
        const upload = yield* putGraphFile(options.graphId, fileId, fileName, file, env.S3_BUCKET);

        return yield* Effect.matchEffect(
            tryDb((db) =>
                db.transaction((tx) =>
                    Effect.gen(function* (): Generator<Effect.Effect<unknown, unknown>, ApplyMutationResult> {
                        const [currentSuggestionRow] = yield* tx
                            .select(selectGraphSuggestionFields)
                            .from(graphSuggestionsTable)
                            .where(
                                and(
                                    eq(graphSuggestionsTable.graphId, options.graphId),
                                    eq(graphSuggestionsTable.id, options.suggestionId)
                                )
                            )
                            .for("update")
                            .limit(1);
                        const currentSuggestion = assertPendingGraphSuggestion(currentSuggestionRow);
                        if (
                            currentSuggestion.kind !== "entity_addition" ||
                            !currentSuggestion.entityId ||
                            currentSuggestion.entityId !== suggestion.entityId
                        ) {
                            throw new Error(API_ERROR_CODES.INVALID_SUGGESTION);
                        }

                        const [entity] = yield* tx
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

                        yield* tx.insert(filesTable).values(rows.file);
                        yield* tx.insert(textUnitTable).values(rows.textUnit);
                        yield* tx.insert(sourcesTable).values({
                            ...rows.source,
                            entityId: entity.id,
                        });

                        const [appliedSuggestion] = yield* tx
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
                            relationshipIds: [] as string[],
                        };
                    })
                )
            ),
            {
                onFailure: (error) =>
                    Effect.gen(function* () {
                        yield* Effect.matchEffect(cleanupUploadedKeys([upload.key]), {
                            onFailure: (cleanupError) => {
                                logError("failed to clean up uploaded key after apply transaction failure", {
                                    key: upload.key,
                                    cleanupError,
                                });
                                return Effect.void;
                            },
                            onSuccess: () => Effect.void,
                        });
                        return yield* Effect.fail(error);
                    }),
                onSuccess: (result) => Effect.succeed(result),
            }
        );
    });
}

export function applyGraphSuggestion(
    graphId: string,
    suggestionId: string,
    user: AuthUser
): Effect.Effect<GraphSuggestionApplySuccessData, unknown, Database> {
    return Effect.gen(function* () {
        const suggestion = yield* getPendingSuggestion(graphId, suggestionId);
        yield* assertSuggestionTargetExists(graphId, suggestion);
        const embedding = yield* embedSuggestionText(graphId, user, suggestion.suggestion);
        const applied =
            suggestion.kind === "source_correction"
                ? yield* applySourceCorrection({ graphId, suggestionId, userId: user.id, embedding })
                : yield* applyEntityAddition({ graphId, suggestionId, userId: user.id, embedding });

        return yield* Effect.match(enqueueDescriptionUpdate(graphId, applied.entityIds, applied.relationshipIds), {
            onFailure: (error) => {
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
            },
            onSuccess: (workflowRunId) => ({
                suggestion: applied.suggestion,
                sourceId: applied.sourceId,
                workflowRunId,
            }),
        });
    });
}
