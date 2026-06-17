import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import {
    API_ERROR_CODES,
    ApiError,
    graphNotFoundError,
    invalidGraphOwnerError,
    invalidModelError,
    modelNotConfiguredError,
} from "@kiwi/contracts/errors";
import { Database, DatabaseError, type EffectDatabase } from "@kiwi/db/effect";
import { organizationTable } from "@kiwi/db/tables/auth";
import { graphTable } from "@kiwi/db/tables/graph";
import {
    AI_MODEL_ADAPTER_VALUES,
    AI_MODEL_TYPE_VALUES,
    modelsTable,
    type AiModel,
    type AiModelAdapter,
    type AiModelType,
} from "@kiwi/db/tables/models";
import { and, asc, eq, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import type { Adapter, ClientConfig, EmbeddingAdapter } from "./index";
import { buildAdapter, buildEmbeddingAdapter } from "./chat";

const ENCRYPTION_VERSION = "v1";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY_SALT = "kiwi-model-credentials:v1";
const ENCRYPTION_KEY_INFO = "model-credential-encryption";
const IV_BYTE_LENGTH = 12;
const AUTH_TAG_BYTE_LENGTH = 16;
const DEFAULT_ORGANIZATION_SLUG = "default-org";

export type ModelCredentials = {
    apiKey: string;
    url?: string;
    resourceName?: string;
};

export type PublicModelRecord = {
    model_id: string;
    display_name: string;
    is_default: boolean;
};

export type AdminModelRecord = PublicModelRecord & {
    type: AiModelType;
    adapter: AiModelAdapter;
    provider_model: string;
    context_window: number;
    // Non-secret connection config; lives inside the encrypted credentials
    // blob but is safe to expose to admins, unlike the API key.
    url: string | null;
    resource_name: string | null;
    created_at: string;
    updated_at: string;
};

type ModelQueryRunner = Pick<EffectDatabase, "select">;

type ModelMutationRunner = ModelQueryRunner & Pick<EffectDatabase, "insert">;

function mapDatabaseError<T, E, R>(effect: Effect.Effect<T, E, R>): Effect.Effect<T, DatabaseError, R> {
    return effect.pipe(Effect.mapError((cause) => new DatabaseError({ cause })));
}

type LegacyModelSeed = {
    type: AiModelType;
    modelId: string;
    displayName: string;
    adapter: AiModelAdapter;
    providerModel: string;
    credentials: ModelCredentials;
};

export type LegacyModelBootstrapSummary = {
    organizationCount: number;
    seededModelCount: number;
};

export type ResolvedModelAdapter = {
    row: AiModel;
    adapter: Adapter;
};

export type ResolvedEmbeddingModelAdapter = {
    row: AiModel;
    adapter: EmbeddingAdapter;
};

export type ResolvedResearchModels = {
    config: Required<Pick<ClientConfig, "text" | "embedding">> & Pick<ClientConfig, "subagent">;
    textModelId: string;
    contextWindow: number;
    compactionContextWindow: number;
};

export type ResolvedWorkerModels = {
    config: Required<Pick<ClientConfig, "text" | "embedding">> & Pick<ClientConfig, "image" | "audio" | "video">;
};

export function normalizeModelId(value: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");

    return normalized || "model";
}

export function allocateUniqueModelId<E>(
    requestedModelId: string,
    exists: (candidate: string) => Effect.Effect<boolean, E>
): Effect.Effect<string, E> {
    return Effect.gen(function* () {
        const baseModelId = normalizeModelId(requestedModelId);
        let candidate = baseModelId;
        let suffix = 1;

        while (yield* exists(candidate)) {
            candidate = `${baseModelId}-${suffix}`;
            suffix += 1;
        }

        return candidate;
    });
}

export function allocateModelId(
    queryRunner: ModelQueryRunner,
    organizationId: string,
    requestedModelId: string
): Effect.Effect<string, DatabaseError> {
    return allocateUniqueModelId(requestedModelId, (candidate) =>
        mapDatabaseError(
            queryRunner
                .select({ id: modelsTable.id })
                .from(modelsTable)
                .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.modelId, candidate)))
                .limit(1)
        ).pipe(Effect.map(([existing]) => Boolean(existing)))
    );
}

export function lockModelOrganization(
    queryRunner: ModelQueryRunner,
    organizationId: string
): Effect.Effect<void, DatabaseError | ApiError> {
    return Effect.gen(function* () {
        const [organization] = yield* mapDatabaseError(
            queryRunner
                .select({ id: organizationTable.id })
                .from(organizationTable)
                .where(eq(organizationTable.id, organizationId))
                .limit(1)
                .for("update")
        );

        if (!organization) {
            return yield* Effect.fail(modelNotConfiguredError());
        }
    });
}

function deriveEncryptionKey(secret: string): Buffer {
    return Buffer.from(hkdfSync("sha256", secret, ENCRYPTION_KEY_SALT, ENCRYPTION_KEY_INFO, 32));
}

function encodeBase64Url(value: Buffer): string {
    return value.toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
    return Buffer.from(value, "base64url");
}

export function encryptModelCredentials(credentials: ModelCredentials, secret: string): string {
    const iv = randomBytes(IV_BYTE_LENGTH);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, deriveEncryptionKey(secret), iv, {
        authTagLength: AUTH_TAG_BYTE_LENGTH,
    });
    const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [ENCRYPTION_VERSION, encodeBase64Url(iv), encodeBase64Url(authTag), encodeBase64Url(ciphertext)].join(":");
}

export function decryptModelCredentials(value: string, secret: string): ModelCredentials {
    const [version, rawIv, rawAuthTag, rawCiphertext] = value.split(":");
    if (version !== ENCRYPTION_VERSION || !rawIv || !rawAuthTag || !rawCiphertext) {
        throw new Error(API_ERROR_CODES.INVALID_MODEL);
    }

    try {
        const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, deriveEncryptionKey(secret), decodeBase64Url(rawIv), {
            authTagLength: AUTH_TAG_BYTE_LENGTH,
        });
        decipher.setAuthTag(decodeBase64Url(rawAuthTag));
        const plaintext = Buffer.concat([decipher.update(decodeBase64Url(rawCiphertext)), decipher.final()]).toString(
            "utf8"
        );
        const parsed = JSON.parse(plaintext) as ModelCredentials;
        assertValidCredentials(parsed);
        return parsed;
    } catch (error) {
        throw new Error(API_ERROR_CODES.INVALID_MODEL, { cause: error });
    }
}

function assertValidCredentials(credentials: ModelCredentials) {
    if (!credentials || typeof credentials.apiKey !== "string" || credentials.apiKey.trim().length === 0) {
        throw new Error(API_ERROR_CODES.INVALID_MODEL);
    }
}

function normalizeOptionalEnvString(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

function readLegacyModelSeed(
    legacyEnv: Record<string, string | undefined>,
    options: {
        type: AiModelType;
        prefix: string;
        modelIdPrefix?: string;
    }
): LegacyModelSeed | null {
    const adapterValue = normalizeOptionalEnvString(legacyEnv[`${options.prefix}_ADAPTER`]);
    const providerModel = normalizeOptionalEnvString(legacyEnv[`${options.prefix}_MODEL`]);
    const apiKey = normalizeOptionalEnvString(legacyEnv[`${options.prefix}_KEY`]);
    const url = normalizeOptionalEnvString(legacyEnv[`${options.prefix}_URL`]);
    const resourceName = normalizeOptionalEnvString(legacyEnv[`${options.prefix}_RESOURCE_NAME`]);

    if (!adapterValue || !providerModel || !apiKey || !isModelAdapter(adapterValue)) {
        return null;
    }

    const credentials = {
        apiKey,
        ...(url ? { url } : {}),
        ...(resourceName ? { resourceName } : {}),
    };

    try {
        assertValidModelConfiguration({
            type: options.type,
            adapter: adapterValue,
            providerModel,
            credentials,
        });
    } catch {
        return null;
    }

    return {
        type: options.type,
        modelId: options.modelIdPrefix ? `${options.modelIdPrefix}-${providerModel}` : providerModel,
        displayName: providerModel,
        adapter: adapterValue,
        providerModel,
        credentials,
    };
}

export function collectLegacyModelSeeds(
    legacyEnv: Record<string, string | undefined> = process.env
): LegacyModelSeed[] {
    const textModel = readLegacyModelSeed(legacyEnv, { type: "text", prefix: "AI_TEXT" });
    const embeddingModel = readLegacyModelSeed(legacyEnv, {
        type: "embedding",
        prefix: "AI_EMBEDDING",
        modelIdPrefix: "embedding",
    });
    const seeds = [
        textModel,
        embeddingModel,
        readLegacyModelSeed(legacyEnv, { type: "extract", prefix: "AI_EXTRACT", modelIdPrefix: "extract" }),
        readLegacyModelSeed(legacyEnv, { type: "image", prefix: "AI_IMAGE", modelIdPrefix: "image" }),
        readLegacyModelSeed(legacyEnv, { type: "audio", prefix: "AI_AUDIO", modelIdPrefix: "audio" }),
        readLegacyModelSeed(legacyEnv, { type: "video", prefix: "AI_VIDEO", modelIdPrefix: "video" }),
    ].filter((seed): seed is LegacyModelSeed => seed !== null);

    const subagentModel = normalizeOptionalEnvString(legacyEnv.AI_SUBAGENT_MODEL);
    if (textModel && subagentModel && subagentModel !== textModel.providerModel) {
        seeds.push({
            ...textModel,
            type: "subagent",
            modelId: `subagent-${subagentModel}`,
            displayName: subagentModel,
            providerModel: subagentModel,
        });
    }

    return seeds;
}

function hasModelForType(
    queryRunner: ModelQueryRunner,
    organizationId: string,
    type: AiModelType
): Effect.Effect<boolean, DatabaseError> {
    return mapDatabaseError(
        queryRunner
            .select({ id: modelsTable.id })
            .from(modelsTable)
            .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.type, type)))
            .limit(1)
    ).pipe(Effect.map(([model]) => Boolean(model)));
}

function insertLegacyModelSeed(
    queryRunner: ModelMutationRunner,
    organizationId: string,
    seed: LegacyModelSeed,
    secret: string
): Effect.Effect<boolean, DatabaseError | ApiError> {
    return Effect.gen(function* () {
        if (yield* hasModelForType(queryRunner, organizationId, seed.type)) {
            return false;
        }

        const modelId = yield* allocateModelId(queryRunner, organizationId, seed.modelId);
        yield* mapDatabaseError(
            queryRunner.insert(modelsTable).values({
                organizationId,
                modelId,
                displayName: seed.displayName,
                type: seed.type,
                adapter: seed.adapter,
                providerModel: seed.providerModel,
                encryptedCredentials: encryptModelCredentials(seed.credentials, secret),
                isDefault: true,
            })
        );

        return true;
    });
}

export function bootstrapLegacyModelsFromEnv(options: {
    secret: string;
    env?: Record<string, string | undefined>;
}): Effect.Effect<LegacyModelBootstrapSummary, DatabaseError | ApiError, Database> {
    return Effect.gen(function* () {
        const seeds = collectLegacyModelSeeds(options.env);
        if (seeds.length === 0) {
            return {
                organizationCount: 0,
                seededModelCount: 0,
            };
        }

        const db = yield* Database;
        const organizations = yield* mapDatabaseError(db.select({ id: organizationTable.id }).from(organizationTable));
        let seededModelCount = 0;

        for (const organization of organizations) {
            seededModelCount += yield* db
                .transaction((tx) =>
                    Effect.gen(function* () {
                        yield* lockModelOrganization(tx, organization.id);
                        let seededForOrganization = 0;

                        for (const seed of seeds) {
                            if (yield* insertLegacyModelSeed(tx, organization.id, seed, options.secret)) {
                                seededForOrganization += 1;
                            }
                        }

                        return seededForOrganization;
                    })
                )
                .pipe(
                    Effect.mapError((cause) =>
                        cause instanceof ApiError || cause instanceof DatabaseError ? cause : new DatabaseError({ cause })
                    )
                );
        }

        return {
            organizationCount: organizations.length,
            seededModelCount,
        };
    });
}

function isModelType(value: string): value is AiModelType {
    return AI_MODEL_TYPE_VALUES.includes(value as AiModelType);
}

function isModelAdapter(value: string): value is AiModelAdapter {
    return AI_MODEL_ADAPTER_VALUES.includes(value as AiModelAdapter);
}

function isEmbeddingCapableAdapter(adapter: AiModelAdapter): adapter is EmbeddingAdapter["type"] {
    return adapter === "openai" || adapter === "azure" || adapter === "openaiAPI";
}

function isTranscriptionAdapter(
    adapter: AiModelAdapter
): adapter is Extract<Adapter["type"], "openai" | "azure" | "openaiAPI"> {
    return adapter === "openai" || adapter === "azure" || adapter === "openaiAPI";
}

export function assertValidModelConfiguration(input: {
    type: AiModelType;
    adapter: AiModelAdapter;
    providerModel: string;
    credentials: ModelCredentials;
}) {
    if (!isModelType(input.type) || !isModelAdapter(input.adapter) || input.providerModel.trim().length === 0) {
        throw new Error(API_ERROR_CODES.INVALID_MODEL);
    }

    assertValidCredentials(input.credentials);

    if (
        (input.type === "embedding" || input.type === "audio" || input.type === "video") &&
        input.adapter === "anthropic"
    ) {
        throw new Error(API_ERROR_CODES.INVALID_MODEL);
    }

    if (input.adapter === "azure" && !input.credentials.resourceName?.trim()) {
        throw new Error(API_ERROR_CODES.INVALID_MODEL);
    }

    if (input.adapter === "openaiAPI" && !input.credentials.url?.trim()) {
        throw new Error(API_ERROR_CODES.INVALID_MODEL);
    }
}

export function toPublicModelRecord(row: Pick<AiModel, "modelId" | "displayName" | "isDefault">): PublicModelRecord {
    return {
        model_id: row.modelId,
        display_name: row.displayName,
        is_default: row.isDefault,
    };
}

export function toAdminModelRecord(
    row: Pick<
        AiModel,
        | "modelId"
        | "displayName"
        | "type"
        | "adapter"
        | "providerModel"
        | "contextWindow"
        | "isDefault"
        | "createdAt"
        | "updatedAt"
        | "encryptedCredentials"
    >,
    secret: string
): AdminModelRecord {
    const credentials = decryptModelCredentials(row.encryptedCredentials, secret);
    return {
        ...toPublicModelRecord(row),
        type: row.type,
        adapter: row.adapter,
        provider_model: row.providerModel,
        context_window: row.contextWindow,
        url: credentials.url ?? null,
        resource_name: credentials.resourceName ?? null,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
    };
}

function modelAdapter(row: AiModel, credentials: ModelCredentials): Adapter {
    assertValidModelConfiguration({
        type: row.type,
        adapter: row.adapter,
        providerModel: row.providerModel,
        credentials,
    });

    return buildAdapter(row.adapter, row.providerModel, credentials.apiKey, credentials.url, credentials.resourceName);
}

function embeddingModelAdapter(row: AiModel, credentials: ModelCredentials): EmbeddingAdapter {
    if (!isEmbeddingCapableAdapter(row.adapter)) {
        throw new Error(API_ERROR_CODES.INVALID_MODEL);
    }

    assertValidModelConfiguration({
        type: row.type,
        adapter: row.adapter,
        providerModel: row.providerModel,
        credentials,
    });

    return buildEmbeddingAdapter(
        row.adapter,
        row.providerModel,
        credentials.apiKey,
        credentials.url,
        credentials.resourceName
    );
}

function transcriptionModelAdapter(row: AiModel, credentials: ModelCredentials): Adapter {
    if (!isTranscriptionAdapter(row.adapter)) {
        throw new Error(API_ERROR_CODES.INVALID_MODEL);
    }

    return modelAdapter(row, credentials);
}

function findDefaultModel(
    organizationId: string,
    type: AiModelType
): Effect.Effect<AiModel | null, DatabaseError, Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        const [row] = yield* mapDatabaseError(
            db
                .select()
                .from(modelsTable)
                .where(
                    and(
                        eq(modelsTable.organizationId, organizationId),
                        eq(modelsTable.type, type),
                        eq(modelsTable.isDefault, true)
                    )
                )
                .limit(1)
        );
        return row ?? null;
    });
}

function findTextModelByModelId(
    organizationId: string,
    modelId: string
): Effect.Effect<AiModel | null, DatabaseError, Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        const [row] = yield* mapDatabaseError(
            db
                .select()
                .from(modelsTable)
                .where(
                    and(
                        eq(modelsTable.organizationId, organizationId),
                        eq(modelsTable.type, "text"),
                        eq(modelsTable.modelId, normalizeModelId(modelId))
                    )
                )
                .limit(1)
        );
        return row ?? null;
    });
}

function requireDefaultModel(organizationId: string, type: AiModelType): Effect.Effect<AiModel, DatabaseError | ApiError, Database> {
    return findDefaultModel(organizationId, type).pipe(
        Effect.flatMap((row) => (row ? Effect.succeed(row) : Effect.fail(modelNotConfiguredError())))
    );
}

function resolveModelAdapter(row: AiModel, secret: string): ResolvedModelAdapter {
    const credentials = decryptModelCredentials(row.encryptedCredentials, secret);
    return {
        row,
        adapter: modelAdapter(row, credentials),
    };
}

function resolveEmbeddingModelAdapter(row: AiModel, secret: string): ResolvedEmbeddingModelAdapter {
    const credentials = decryptModelCredentials(row.encryptedCredentials, secret);
    return {
        row,
        adapter: embeddingModelAdapter(row, credentials),
    };
}

function resolveTranscriptionModelAdapter(row: AiModel, secret: string): ResolvedModelAdapter {
    const credentials = decryptModelCredentials(row.encryptedCredentials, secret);
    return {
        row,
        adapter: transcriptionModelAdapter(row, credentials),
    };
}

export function resolveRequiredModelAdapter(
    organizationId: string,
    type: Exclude<AiModelType, "embedding">,
    secret: string
): Effect.Effect<ResolvedModelAdapter, DatabaseError | ApiError, Database> {
    return requireDefaultModel(organizationId, type).pipe(Effect.map((row) => resolveModelAdapter(row, secret)));
}

export function resolveRequiredEmbeddingModelAdapter(
    organizationId: string,
    secret: string
): Effect.Effect<ResolvedEmbeddingModelAdapter, DatabaseError | ApiError, Database> {
    return requireDefaultModel(organizationId, "embedding").pipe(
        Effect.map((row) => resolveEmbeddingModelAdapter(row, secret))
    );
}

export function resolveResearchModelConfig(options: {
    organizationId: string;
    requestedTextModelId?: string;
    secret: string;
}): Effect.Effect<ResolvedResearchModels, DatabaseError | ApiError, Database> {
    return Effect.gen(function* () {
        const textModel = yield* (options.requestedTextModelId
            ? findTextModelByModelId(options.organizationId, options.requestedTextModelId).pipe(
                  Effect.flatMap((model) => (model ? Effect.succeed(model) : Effect.fail(invalidModelError())))
              )
            : requireDefaultModel(options.organizationId, "text"));
        const [embeddingModel, subagentModel] = yield* Effect.all(
            [requireDefaultModel(options.organizationId, "embedding"), findDefaultModel(options.organizationId, "subagent")],
            { concurrency: "unbounded" }
        );
        const resolvedText = resolveModelAdapter(textModel, options.secret);
        const resolvedEmbedding = resolveEmbeddingModelAdapter(embeddingModel, options.secret);
        const resolvedSubagent = subagentModel ? resolveModelAdapter(subagentModel, options.secret) : null;

        return {
            config: {
                text: resolvedText.adapter,
                embedding: resolvedEmbedding.adapter,
                ...(resolvedSubagent ? { subagent: resolvedSubagent.adapter } : {}),
            },
            textModelId: textModel.modelId,
            contextWindow: textModel.contextWindow,
            // Compaction summarization runs on the subagent model when configured.
            compactionContextWindow: (subagentModel ?? textModel).contextWindow,
        };
    });
}

export function resolveWorkerModelConfig(options: {
    organizationId: string;
    secret: string;
}): Effect.Effect<ResolvedWorkerModels, DatabaseError | ApiError, Database> {
    return Effect.gen(function* () {
        const [extractModel, textModel, embeddingModel, imageModel, audioModel, videoModel] = yield* Effect.all(
            [
                findDefaultModel(options.organizationId, "extract"),
                findDefaultModel(options.organizationId, "text"),
                requireDefaultModel(options.organizationId, "embedding"),
                findDefaultModel(options.organizationId, "image"),
                findDefaultModel(options.organizationId, "audio"),
                findDefaultModel(options.organizationId, "video"),
            ],
            { concurrency: "unbounded" }
        );
        const workerTextModel = extractModel ?? textModel;

        if (!workerTextModel) {
            return yield* Effect.fail(modelNotConfiguredError());
        }

        return {
            config: {
                text: resolveModelAdapter(workerTextModel, options.secret).adapter,
                embedding: resolveEmbeddingModelAdapter(embeddingModel, options.secret).adapter,
                ...(imageModel ? { image: resolveModelAdapter(imageModel, options.secret).adapter } : {}),
                ...(audioModel ? { audio: resolveTranscriptionModelAdapter(audioModel, options.secret).adapter } : {}),
                ...(videoModel ? { video: resolveTranscriptionModelAdapter(videoModel, options.secret).adapter } : {}),
            },
        };
    });
}

export function getDefaultModelOrganizationId(): Effect.Effect<string, DatabaseError | ApiError, Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        const [organization] = yield* mapDatabaseError(
            db
                .select({ id: organizationTable.id })
                .from(organizationTable)
                .orderBy(
                    sql`CASE WHEN ${organizationTable.slug} = ${DEFAULT_ORGANIZATION_SLUG} THEN 0 ELSE 1 END`,
                    asc(organizationTable.createdAt),
                    asc(organizationTable.id)
                )
                .limit(1)
        );

        if (!organization) {
            return yield* Effect.fail(modelNotConfiguredError());
        }

        return organization.id;
    });
}

export function resolveGraphModelOrganizationId(graphId: string): Effect.Effect<string, DatabaseError | ApiError, Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        const visited = new Set<string>();
        let currentGraphId = graphId;
        let isRootLookup = true;

        while (true) {
            if (visited.has(currentGraphId)) {
                return yield* Effect.fail(invalidGraphOwnerError());
            }

            visited.add(currentGraphId);

            const [graph] = yield* mapDatabaseError(
                db
                    .select({
                        id: graphTable.id,
                        organizationId: graphTable.organizationId,
                        teamId: graphTable.teamId,
                        userId: graphTable.userId,
                        graphId: graphTable.graphId,
                    })
                    .from(graphTable)
                    .where(eq(graphTable.id, currentGraphId))
                    .limit(1)
            );

            if (!graph) {
                return yield* Effect.fail(isRootLookup ? graphNotFoundError() : invalidGraphOwnerError());
            }

            if (graph.organizationId) {
                return graph.organizationId;
            }

            if (graph.userId) {
                return yield* getDefaultModelOrganizationId();
            }

            if (!graph.graphId) {
                return yield* Effect.fail(invalidGraphOwnerError());
            }

            currentGraphId = graph.graphId;
            isRootLookup = false;
        }
    });
}
