import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { API_ERROR_CODES } from "@kiwi/contracts/responses";
import { db } from "@kiwi/db";
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

type ModelQueryRunner = {
    select: typeof db.select;
};

type ModelMutationRunner = ModelQueryRunner & {
    insert: typeof db.insert;
};

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

export async function allocateUniqueModelId(
    requestedModelId: string,
    exists: (candidate: string) => Promise<boolean>
): Promise<string> {
    const baseModelId = normalizeModelId(requestedModelId);
    let candidate = baseModelId;
    let suffix = 1;

    while (await exists(candidate)) {
        candidate = `${baseModelId}-${suffix}`;
        suffix += 1;
    }

    return candidate;
}

export async function allocateModelId(
    queryRunner: ModelQueryRunner,
    organizationId: string,
    requestedModelId: string
): Promise<string> {
    return allocateUniqueModelId(requestedModelId, async (candidate) => {
        const [existing] = await queryRunner
            .select({ id: modelsTable.id })
            .from(modelsTable)
            .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.modelId, candidate)))
            .limit(1);

        return Boolean(existing);
    });
}

export async function lockModelOrganization(queryRunner: ModelQueryRunner, organizationId: string): Promise<void> {
    const [organization] = await queryRunner
        .select({ id: organizationTable.id })
        .from(organizationTable)
        .where(eq(organizationTable.id, organizationId))
        .limit(1)
        .for("update");

    if (!organization) {
        throw new Error(API_ERROR_CODES.MODEL_NOT_CONFIGURED);
    }
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

async function hasModelForType(queryRunner: ModelQueryRunner, organizationId: string, type: AiModelType) {
    const [model] = await queryRunner
        .select({ id: modelsTable.id })
        .from(modelsTable)
        .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.type, type)))
        .limit(1);

    return Boolean(model);
}

async function insertLegacyModelSeed(
    queryRunner: ModelMutationRunner,
    organizationId: string,
    seed: LegacyModelSeed,
    secret: string
) {
    if (await hasModelForType(queryRunner, organizationId, seed.type)) {
        return false;
    }

    const modelId = await allocateModelId(queryRunner, organizationId, seed.modelId);
    await queryRunner.insert(modelsTable).values({
        organizationId,
        modelId,
        displayName: seed.displayName,
        type: seed.type,
        adapter: seed.adapter,
        providerModel: seed.providerModel,
        encryptedCredentials: encryptModelCredentials(seed.credentials, secret),
        isDefault: true,
    });

    return true;
}

export async function bootstrapLegacyModelsFromEnv(options: {
    secret: string;
    env?: Record<string, string | undefined>;
}): Promise<LegacyModelBootstrapSummary> {
    const seeds = collectLegacyModelSeeds(options.env);
    if (seeds.length === 0) {
        return {
            organizationCount: 0,
            seededModelCount: 0,
        };
    }

    const organizations = await db.select({ id: organizationTable.id }).from(organizationTable);
    let seededModelCount = 0;

    for (const organization of organizations) {
        seededModelCount += await db.transaction(async (tx) => {
            await lockModelOrganization(tx, organization.id);
            let seededForOrganization = 0;

            for (const seed of seeds) {
                if (await insertLegacyModelSeed(tx, organization.id, seed, options.secret)) {
                    seededForOrganization += 1;
                }
            }

            return seededForOrganization;
        });
    }

    return {
        organizationCount: organizations.length,
        seededModelCount,
    };
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

async function findDefaultModel(organizationId: string, type: AiModelType): Promise<AiModel | null> {
    const [row] = await db
        .select()
        .from(modelsTable)
        .where(
            and(
                eq(modelsTable.organizationId, organizationId),
                eq(modelsTable.type, type),
                eq(modelsTable.isDefault, true)
            )
        )
        .limit(1);

    return row ?? null;
}

async function findTextModelByModelId(organizationId: string, modelId: string): Promise<AiModel | null> {
    const [row] = await db
        .select()
        .from(modelsTable)
        .where(
            and(
                eq(modelsTable.organizationId, organizationId),
                eq(modelsTable.type, "text"),
                eq(modelsTable.modelId, normalizeModelId(modelId))
            )
        )
        .limit(1);

    return row ?? null;
}

async function requireDefaultModel(organizationId: string, type: AiModelType): Promise<AiModel> {
    const row = await findDefaultModel(organizationId, type);
    if (!row) {
        throw new Error(API_ERROR_CODES.MODEL_NOT_CONFIGURED);
    }

    return row;
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

export async function resolveRequiredModelAdapter(
    organizationId: string,
    type: Exclude<AiModelType, "embedding">,
    secret: string
): Promise<ResolvedModelAdapter> {
    return resolveModelAdapter(await requireDefaultModel(organizationId, type), secret);
}

export async function resolveRequiredEmbeddingModelAdapter(
    organizationId: string,
    secret: string
): Promise<ResolvedEmbeddingModelAdapter> {
    return resolveEmbeddingModelAdapter(await requireDefaultModel(organizationId, "embedding"), secret);
}

export async function resolveResearchModelConfig(options: {
    organizationId: string;
    requestedTextModelId?: string;
    secret: string;
}): Promise<ResolvedResearchModels> {
    const textModelPromise = options.requestedTextModelId
        ? findTextModelByModelId(options.organizationId, options.requestedTextModelId).then((model) => {
              if (!model) {
                  throw new Error(API_ERROR_CODES.INVALID_MODEL);
              }

              return model;
          })
        : requireDefaultModel(options.organizationId, "text");
    const [textModel, embeddingModel, subagentModel] = await Promise.all([
        textModelPromise,
        requireDefaultModel(options.organizationId, "embedding"),
        findDefaultModel(options.organizationId, "subagent"),
    ]);
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
}

export async function resolveWorkerModelConfig(options: {
    organizationId: string;
    secret: string;
}): Promise<ResolvedWorkerModels> {
    const [extractModel, textModel, embeddingModel, imageModel, audioModel, videoModel] = await Promise.all([
        findDefaultModel(options.organizationId, "extract"),
        findDefaultModel(options.organizationId, "text"),
        requireDefaultModel(options.organizationId, "embedding"),
        findDefaultModel(options.organizationId, "image"),
        findDefaultModel(options.organizationId, "audio"),
        findDefaultModel(options.organizationId, "video"),
    ]);
    const workerTextModel = extractModel ?? textModel;

    if (!workerTextModel) {
        throw new Error(API_ERROR_CODES.MODEL_NOT_CONFIGURED);
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
}

export async function getDefaultModelOrganizationId(): Promise<string> {
    const [organization] = await db
        .select({ id: organizationTable.id })
        .from(organizationTable)
        .orderBy(
            sql`CASE WHEN ${organizationTable.slug} = ${DEFAULT_ORGANIZATION_SLUG} THEN 0 ELSE 1 END`,
            asc(organizationTable.createdAt),
            asc(organizationTable.id)
        )
        .limit(1);

    if (!organization) {
        throw new Error(API_ERROR_CODES.MODEL_NOT_CONFIGURED);
    }

    return organization.id;
}

export async function resolveGraphModelOrganizationId(graphId: string): Promise<string> {
    const visited = new Set<string>();
    let currentGraphId = graphId;
    let isRootLookup = true;

    while (true) {
        if (visited.has(currentGraphId)) {
            throw new Error(API_ERROR_CODES.INVALID_GRAPH_OWNER);
        }

        visited.add(currentGraphId);

        const [graph] = await db
            .select({
                id: graphTable.id,
                organizationId: graphTable.organizationId,
                teamId: graphTable.teamId,
                userId: graphTable.userId,
                graphId: graphTable.graphId,
            })
            .from(graphTable)
            .where(eq(graphTable.id, currentGraphId))
            .limit(1);

        if (!graph) {
            throw new Error(isRootLookup ? API_ERROR_CODES.GRAPH_NOT_FOUND : API_ERROR_CODES.INVALID_GRAPH_OWNER);
        }

        if (graph.organizationId) {
            return graph.organizationId;
        }

        if (graph.userId) {
            return getDefaultModelOrganizationId();
        }

        if (!graph.graphId) {
            throw new Error(API_ERROR_CODES.INVALID_GRAPH_OWNER);
        }

        currentGraphId = graph.graphId;
        isRootLookup = false;
    }
}
