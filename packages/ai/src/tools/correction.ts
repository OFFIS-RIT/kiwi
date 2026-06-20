import { Database, DatabaseError, runDatabaseEffect } from "@kiwi/db/effect";
import { graphSuggestionsTable } from "@kiwi/db/tables/suggestions";
import { entityTable, filesTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { currentSourcePredicate, visibleFilePredicate } from "@kiwi/db/source-validity";
import { and, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { tool } from "ai";
import { z } from "zod";
import { runToolSafely } from "./lib/execute";

export type CorrectionToolContext = {
    graphId: string;
    userId: string;
    chatId: string;
    messageId: string;
};

export const correctionInputSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("source_correction"),
        sourceId: z.string().trim().min(1).describe("The source ID that supports the answer claim being corrected."),
        reference: z
            .string()
            .trim()
            .min(1)
            .describe("The specific answer claim, source statement, or topic that the correction refers to."),
        suggestion: z.string().trim().min(1).describe("The corrected source description suggested by the user."),
    }),
    z.object({
        kind: z.literal("entity_addition"),
        entityId: z.string().trim().min(1).describe("The entity ID that the new information should be attached to."),
        reference: z
            .string()
            .trim()
            .min(1)
            .describe("The entity, missing fact, or answer gap that the addition refers to."),
        suggestion: z.string().trim().min(1).describe("The new factual source description suggested by the user."),
    }),
]);

const correctionOutputSchema = z.string().catch("");

function assertSourceInGraph(graphId: string, sourceId: string): Effect.Effect<void, DatabaseError | Error, Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        const [source] = yield* db
            .select({ id: sourcesTable.id })
            .from(sourcesTable)
            .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
            .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
            .where(
                and(
                    eq(sourcesTable.id, sourceId),
                    eq(filesTable.graphId, graphId),
                    currentSourcePredicate(sourcesTable),
                    visibleFilePredicate(filesTable)
                )
            )
            .limit(1)
            .pipe(Effect.mapError((cause) => new DatabaseError({ cause })));

        if (!source) {
            return yield* Effect.fail(new Error("Source not found in this graph"));
        }
    });
}

function assertActiveEntityInGraph(
    graphId: string,
    entityId: string
): Effect.Effect<void, DatabaseError | Error, Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        const [entity] = yield* db
            .select({ id: entityTable.id })
            .from(entityTable)
            .where(and(eq(entityTable.id, entityId), eq(entityTable.graphId, graphId), eq(entityTable.active, true)))
            .limit(1)
            .pipe(Effect.mapError((cause) => new DatabaseError({ cause })));

        if (!entity) {
            return yield* Effect.fail(new Error("Entity not found in this graph"));
        }
    });
}

export const correctionTool = (context: CorrectionToolContext) =>
    tool({
        description:
            "Store a pending graph correction suggestion when the user corrects an answer or adds factual information. Use source_correction for an existing cited/source-backed statement, and entity_addition for new information that belongs to an existing entity. This tool stores the suggestion only; it does not apply the change.",
        inputSchema: correctionInputSchema,
        execute: (input) =>
            runDatabaseEffect(
                runToolSafely(
                    {
                        title: "Correction suggestion",
                        name: "correction",
                        hints: [
                            "use source_correction only with a valid source ID from this graph",
                            "use entity_addition only with a valid active entity ID from this graph",
                        ],
                    },
                    input,
                    () =>
                        Effect.gen(function* () {
                            const db = yield* Database;
                            if (input.kind === "source_correction") {
                                yield* assertSourceInGraph(context.graphId, input.sourceId);
                            } else {
                                yield* assertActiveEntityInGraph(context.graphId, input.entityId);
                            }

                            const [suggestion] = yield* db
                                .insert(graphSuggestionsTable)
                                .values({
                                    graphId: context.graphId,
                                    kind: input.kind,
                                    sourceId: input.kind === "source_correction" ? input.sourceId : null,
                                    entityId: input.kind === "entity_addition" ? input.entityId : null,
                                    reference: input.reference,
                                    suggestion: input.suggestion,
                                    suggestedByUserId: context.userId,
                                    chatId: context.chatId,
                                    messageId: context.messageId,
                                })
                                .returning({ id: graphSuggestionsTable.id })
                                .pipe(Effect.mapError((cause) => new DatabaseError({ cause })));

                            return [
                                "## Correction suggestion",
                                `- stored: ${suggestion?.id ?? "unknown"}`,
                                "- status: pending",
                                "- nothing was applied yet",
                            ].join("\n");
                        })
                )
            ),
    });

export const correctionValidationTool = () =>
    tool({
        description:
            "Schema for persisted correction tool calls. Corrections store pending graph suggestions and are applied only by admins later.",
        inputSchema: correctionInputSchema,
        outputSchema: correctionOutputSchema,
    });
