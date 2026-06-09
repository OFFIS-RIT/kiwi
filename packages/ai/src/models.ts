import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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
};

export type AdminModelRecord = PublicModelRecord & {
    type: AiModelType;
    adapter: AiModelAdapter;
    provider_model: string;
    is_default: boolean;
    created_at: string;
    updated_at: string;
};

type ModelQueryRunner = {
    select: typeof db.select;
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
};

export type ResolvedWorkerModels = {
    config: Required<Pick<ClientConfig, "text" | "embedding">> &
        Pick<ClientConfig, "image" | "audio" | "video">;
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

function deriveEncryptionKey(secret: string): Buffer {
    return createHash("sha256").update(secret).digest();
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

function isModelType(value: string): value is AiModelType {
    return AI_MODEL_TYPE_VALUES.includes(value as AiModelType);
}

function isModelAdapter(value: string): value is AiModelAdapter {
    return AI_MODEL_ADAPTER_VALUES.includes(value as AiModelAdapter);
}

function isEmbeddingCapableAdapter(adapter: AiModelAdapter): adapter is EmbeddingAdapter["type"] {
    return adapter === "openai" || adapter === "azure" || adapter === "openaiAPI";
}

function isTranscriptionAdapter(adapter: AiModelAdapter): adapter is Extract<Adapter["type"], "openai" | "azure" | "openaiAPI"> {
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

    if ((input.type === "embedding" || input.type === "audio" || input.type === "video") && input.adapter === "anthropic") {
        throw new Error(API_ERROR_CODES.INVALID_MODEL);
    }

    if (input.adapter === "azure" && !input.credentials.resourceName?.trim()) {
        throw new Error(API_ERROR_CODES.INVALID_MODEL);
    }

    if (input.adapter === "openaiAPI" && !input.credentials.url?.trim()) {
        throw new Error(API_ERROR_CODES.INVALID_MODEL);
    }
}

export function toPublicModelRecord(row: Pick<AiModel, "modelId" | "displayName">): PublicModelRecord {
    return {
        model_id: row.modelId,
        display_name: row.displayName,
    };
}

export function toAdminModelRecord(
    row: Pick<
        AiModel,
        "modelId" | "displayName" | "type" | "adapter" | "providerModel" | "isDefault" | "createdAt" | "updatedAt"
    >
): AdminModelRecord {
    return {
        ...toPublicModelRecord(row),
        type: row.type,
        adapter: row.adapter,
        provider_model: row.providerModel,
        is_default: row.isDefault,
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

    return buildAdapter(
        row.adapter,
        row.providerModel,
        credentials.apiKey,
        credentials.url,
        credentials.resourceName
    );
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
        .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.type, type), eq(modelsTable.isDefault, true)))
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
    const requestedTextModel = options.requestedTextModelId
        ? await findTextModelByModelId(options.organizationId, options.requestedTextModelId)
        : null;
    const textModel = requestedTextModel ?? (await requireDefaultModel(options.organizationId, "text"));
    const embeddingModel = await requireDefaultModel(options.organizationId, "embedding");
    const subagentModel = await findDefaultModel(options.organizationId, "subagent");
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
    };
}

async function resolveOptionalModelAdapter(
    organizationId: string,
    type: Exclude<AiModelType, "embedding" | "audio" | "video">,
    secret: string
): Promise<ResolvedModelAdapter | null> {
    const row = await findDefaultModel(organizationId, type);
    return row ? resolveModelAdapter(row, secret) : null;
}

async function resolveOptionalTranscriptionAdapter(
    organizationId: string,
    type: "audio" | "video",
    secret: string
): Promise<ResolvedModelAdapter | null> {
    const row = await findDefaultModel(organizationId, type);
    return row ? resolveTranscriptionModelAdapter(row, secret) : null;
}

export async function resolveWorkerModelConfig(options: {
    organizationId: string;
    secret: string;
}): Promise<ResolvedWorkerModels> {
    const extractModel = await requireDefaultModel(options.organizationId, "extract");
    const embeddingModel = await requireDefaultModel(options.organizationId, "embedding");
    const imageModel = await resolveOptionalModelAdapter(options.organizationId, "image", options.secret);
    const audioModel = await resolveOptionalTranscriptionAdapter(options.organizationId, "audio", options.secret);
    const videoModel = await resolveOptionalTranscriptionAdapter(options.organizationId, "video", options.secret);

    return {
        config: {
            text: resolveModelAdapter(extractModel, options.secret).adapter,
            embedding: resolveEmbeddingModelAdapter(embeddingModel, options.secret).adapter,
            ...(imageModel ? { image: imageModel.adapter } : {}),
            ...(audioModel ? { audio: audioModel.adapter } : {}),
            ...(videoModel ? { video: videoModel.adapter } : {}),
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
