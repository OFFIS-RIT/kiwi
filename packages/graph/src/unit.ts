import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ulid } from "ulid";
import { withAiSlotEffect } from "@kiwi/ai/lock";
import { extractPrompt } from "@kiwi/ai/prompts/extract.prompt";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { Graph, GraphChunker, GraphFile, GraphTextChunk, LoaderSourceChunk, TextUnitSourceChunk, Unit } from ".";
import { SemanticChunker } from "@kiwi/loaders/chunker/semantic";
import { loadGraphDocumentEffect } from "@kiwi/loaders/loader/document";
import { toPageAwareChunksWithSource } from "@kiwi/loaders/lib/page-fence";
import { createSourceChunks, DEFAULT_SOURCE_CHUNK_TOKENS } from "@kiwi/loaders/lib/source-chunk";
import z from "zod";

export const MAX_SOURCE_CHUNKS_PER_SOURCE = 8;
const EXTRACT_OUTPUT_MAX_ATTEMPTS = 3;

export class UnitCreationError extends Schema.TaggedErrorClass<UnitCreationError>()("UnitCreationError", {
    message: Schema.String,
    cause: Schema.Unknown,
}) {}

export const createUnits = Effect.fn("createUnits")(function* (file: GraphFile) {
    const document = yield* loadGraphDocumentEffect(file.loader).pipe(
        Effect.mapError((cause) => new UnitCreationError({ message: "Failed to create graph units.", cause }))
    );

    return yield* createUnitsFromText({
        fileId: file.id,
        fileType: file.filetype,
        text: document.text,
        chunker: file.chunker,
        loaderSourceChunks: document.sourceChunks,
    });
});

export const createUnitsFromText = Effect.fn("createUnitsFromText")(function* (options: {
    fileId: string;
    fileType: string;
    text: string;
    chunker: GraphChunker;
    loaderSourceChunks?: LoaderSourceChunk[];
}) {
    const textChunks = yield* getChunkSpansEffect(options.chunker, options.text);
    const chunks = toPageAwareChunksWithSource(textChunks, (chunk) => chunk.content);
    const loaderSourceChunks = prepareLoaderSourceChunks(options.loaderSourceChunks ?? []);
    let fallbackTextChunker: GraphChunker | undefined;
    const units: Unit[] = [];

    for (const chunk of chunks) {
        const unit: Unit = {
            id: ulid(),
            fileId: options.fileId,
            content: chunk.content,
            startPage: chunk.startPage,
            endPage: chunk.endPage,
            chunks: sourceChunksForUnit(loaderSourceChunks, chunk.source),
        };

        if (unit.chunks.length === 0) {
            unit.chunks = yield* Effect.tryPromise({
                try: () =>
                    createSourceChunks(chunk.content, {
                        fileType: options.fileType,
                        startPage: chunk.startPage,
                        endPage: chunk.endPage,
                        textChunker: (fallbackTextChunker ??= new SemanticChunker(DEFAULT_SOURCE_CHUNK_TOKENS)),
                    }),
                catch: (cause) => new UnitCreationError({ message: "Failed to create graph units.", cause }),
            });
        }

        units.push(unit);
    }

    return units;
});

function getChunkSpansEffect(chunker: GraphChunker, text: string): Effect.Effect<GraphTextChunk[], UnitCreationError> {
    if (chunker.getChunkSpansEffect) {
        return chunker
            .getChunkSpansEffect(text)
            .pipe(
                Effect.mapError((cause) => new UnitCreationError({ message: "Failed to create graph units.", cause }))
            );
    }

    return Effect.tryPromise({
        try: () => chunker.getChunkSpans(text),
        catch: (cause) => new UnitCreationError({ message: "Failed to create graph units.", cause }),
    });
}

function prepareLoaderSourceChunks(loaderSourceChunks: LoaderSourceChunk[]): LoaderSourceChunk[] {
    return [...loaderSourceChunks].sort(
        (left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset
    );
}

function sourceChunksForUnit(loaderSourceChunks: LoaderSourceChunk[], span: GraphTextChunk): TextUnitSourceChunk[] {
    if (span.endOffset <= span.startOffset) {
        return [];
    }

    const startIndex = firstOverlappingSourceChunkIndex(loaderSourceChunks, span.startOffset);
    const chunks: TextUnitSourceChunk[] = [];

    for (let index = startIndex; index < loaderSourceChunks.length; index += 1) {
        const chunk = loaderSourceChunks[index]!;
        if (chunk.startOffset >= span.endOffset) {
            break;
        }

        if (chunk.endOffset <= span.startOffset) {
            continue;
        }

        const { startOffset: _startOffset, endOffset: _endOffset, ...sourceChunk } = chunk;
        chunks.push({
            ...sourceChunk,
            id: chunks.length + 1,
        } as TextUnitSourceChunk);
    }

    return chunks;
}

function firstOverlappingSourceChunkIndex(chunks: LoaderSourceChunk[], startOffset: number): number {
    let low = 0;
    let high = chunks.length;

    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (chunks[mid]!.startOffset < startOffset) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    while (low > 0 && chunks[low - 1]!.endOffset > startOffset) {
        low -= 1;
    }

    return low;
}

const extractOutputSchema = z.object({
    entities: z.array(
        z.object({
            name: z.string().describe("The name of the entity all uppercase."),
            type: z.string().describe("The type of the entity, must be one of the provided ones or FACT"),
            description: z.string().describe("A brief description of the entity. Capturing every detail."),
            sourceChunkIds: z.array(z.number()).default([]).describe("Source chunk ids that support this entity."),
        })
    ),
    relationships: z.array(
        z.object({
            sourceEntity: z.string().describe("The name of the source entity in uppercase."),
            targetEntity: z.string().describe("The name of the target entity in uppercase."),
            description: z.string().describe("A brief description of the relationship. Capturing every detail."),
            strength: z.number().describe("A number between 0 and 1 indicating the strength of the relationship."),
            sourceChunkIds: z
                .array(z.number())
                .default([])
                .describe("Source chunk ids that support this relationship."),
        })
    ),
});

export function normalizeSourceChunkIds(sourceChunkIds: number[], unit: Pick<Unit, "chunks">): number[] {
    const validChunkIds = new Set(unit.chunks.map((chunk) => chunk.id));
    const normalized: number[] = [];

    for (const sourceChunkId of sourceChunkIds) {
        if (
            !Number.isInteger(sourceChunkId) ||
            !validChunkIds.has(sourceChunkId) ||
            normalized.includes(sourceChunkId)
        ) {
            continue;
        }

        normalized.push(sourceChunkId);
        if (normalized.length >= MAX_SOURCE_CHUNKS_PER_SOURCE) {
            break;
        }
    }

    if (normalized.length === 0 && unit.chunks.length === 1) {
        return [unit.chunks[0]!.id];
    }

    return normalized;
}

function buildExtractionInput(unit: Unit): string {
    if (unit.chunks.length <= 1) {
        return unit.content;
    }

    return unit.chunks
        .map((chunk) =>
            [
                `:::SOURCE-CHUNK-${chunk.id} type=${chunk.type}:::`,
                chunk.text,
                `:::END-SOURCE-CHUNK-${chunk.id}:::`,
            ].join("\n")
        )
        .join("\n\n");
}

function emptyGraphForUnit(unit: Unit): Graph {
    return {
        id: ulid(),
        units: [unit],
        entities: [],
        relationships: [],
    };
}

export class ProcessUnitAiError extends Schema.TaggedErrorClass<ProcessUnitAiError>()("ProcessUnitAiError", {
    message: Schema.String,
    cause: Schema.Unknown,
}) {}

export class ProcessUnitGraphMappingError extends Schema.TaggedErrorClass<ProcessUnitGraphMappingError>()(
    "ProcessUnitGraphMappingError",
    {
        message: Schema.String,
        cause: Schema.Unknown,
    }
) {}

function isNoObjectGeneratedCause(cause: unknown): boolean {
    if (NoObjectGeneratedError.isInstance(cause)) {
        return true;
    }

    if (cause !== null && typeof cause === "object" && "cause" in cause) {
        return NoObjectGeneratedError.isInstance((cause as { cause?: unknown }).cause);
    }

    return false;
}

const extractGraphData = Effect.fn("extractGraphData")(function* (unit: Unit, model: LanguageModelV3, prompt: string) {
    const extractionInput = buildExtractionInput(unit);

    for (let attempt = 1; attempt <= EXTRACT_OUTPUT_MAX_ATTEMPTS; attempt += 1) {
        const output = yield* withAiSlotEffect("text", (signal) =>
            generateText({
                model,
                system: prompt,
                prompt: extractionInput,
                temperature: 0.1,
                abortSignal: signal,
                output: Output.object({
                    description: "The extracted entities and relationships from the text.",
                    schema: extractOutputSchema,
                }),
            })
        ).pipe(
            Effect.map(({ output }) => output),
            Effect.catchIf(isNoObjectGeneratedCause, () => Effect.succeed(null)),
            Effect.mapError(
                (cause) => new ProcessUnitAiError({ message: "Failed to extract graph data from unit.", cause })
            )
        );

        if (output !== null) {
            return output;
        }
    }

    return null;
});

function mapGraphEntities(
    unit: Unit,
    output: z.infer<typeof extractOutputSchema>
): Effect.Effect<
    {
        entityNameToId: Map<string, string>;
        graphEntities: Graph["entities"];
    },
    ProcessUnitGraphMappingError
> {
    return Effect.try({
        try: () => {
            const entityNameToId = new Map<string, string>();
            const graphEntities = output.entities.map((entity) => {
                const entityId = ulid();

                entityNameToId.set(entity.name, entityId);

                return {
                    id: entityId,
                    name: entity.name,
                    type: entity.type,
                    description: "",
                    sources: [
                        {
                            id: ulid(),
                            unitId: unit.id,
                            description: entity.description,
                            sourceChunkIds: normalizeSourceChunkIds(entity.sourceChunkIds, unit),
                        },
                    ],
                };
            });

            return { entityNameToId, graphEntities };
        },
        catch: (cause) => new ProcessUnitGraphMappingError({ message: "Failed to map extracted graph data.", cause }),
    });
}

function mapGraphRelationships(
    unit: Unit,
    output: z.infer<typeof extractOutputSchema>,
    entityNameToId: Map<string, string>
): Effect.Effect<Graph["relationships"], ProcessUnitGraphMappingError> {
    return Effect.try({
        try: () =>
            output.relationships.flatMap((relationship) => {
                const sourceId = entityNameToId.get(relationship.sourceEntity);
                const targetId = entityNameToId.get(relationship.targetEntity);

                if (!sourceId || !targetId) {
                    return [];
                }

                return [
                    {
                        id: ulid(),
                        sourceId,
                        targetId,
                        strength: relationship.strength,
                        description: "",
                        sources: [
                            {
                                id: ulid(),
                                unitId: unit.id,
                                description: relationship.description,
                                sourceChunkIds: normalizeSourceChunkIds(relationship.sourceChunkIds, unit),
                            },
                        ],
                    },
                ];
            }),
        catch: (cause) => new ProcessUnitGraphMappingError({ message: "Failed to map extracted graph data.", cause }),
    });
}

export const processUnit = Effect.fn("processUnit")(function* (
    unit: Unit,
    model: LanguageModelV3,
    documentName = unit.fileId,
    metadata?: string
) {
    const entities = ["ORGANIZATION", "PERSON", "LOCATION", "CONCEPT", "CREATIVE_WORK", "DATE", "PRODUCT", "EVENT"];
    const prompt = extractPrompt(entities, documentName, metadata);
    const output = yield* extractGraphData(unit, model, prompt);
    if (output === null) {
        return emptyGraphForUnit(unit);
    }
    const { entityNameToId, graphEntities } = yield* mapGraphEntities(unit, output);
    const graphRelationships = yield* mapGraphRelationships(unit, output, entityNameToId);

    return {
        id: ulid(),
        units: [unit],
        entities: graphEntities,
        relationships: graphRelationships,
    };
});
