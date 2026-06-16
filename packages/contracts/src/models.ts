import { Schema } from "effect";
import type { ApiResponse } from "./errors";
import {
    type MutableSchemaType,
    NonEmptyTrimmedStringSchema,
    OptionalNonEmptyTrimmedStringSchema,
    OptionalTrimmedStringSchema,
} from "./schema";

export const AI_MODEL_TYPE_VALUES = ["text", "subagent", "extract", "embedding", "image", "audio", "video"] as const;
export const AiModelTypeSchema = Schema.Literals(AI_MODEL_TYPE_VALUES);
export type AiModelType = Schema.Schema.Type<typeof AiModelTypeSchema>;

export const AI_MODEL_ADAPTER_VALUES = ["openai", "azure", "anthropic", "openaiAPI"] as const;
export const AiModelAdapterSchema = Schema.Literals(AI_MODEL_ADAPTER_VALUES);
export type AiModelAdapter = Schema.Schema.Type<typeof AiModelAdapterSchema>;

export const MIN_MODEL_CONTEXT_WINDOW_TOKENS = 1_000;

export type PublicModelListItem = {
    model_id: string;
    display_name: string;
    is_default: boolean;
};

export type AdminModelListItem = PublicModelListItem & {
    type: AiModelType;
    adapter: AiModelAdapter;
    provider_model: string;
    context_window: number;
    url: string | null;
    resource_name: string | null;
    created_at: string;
    updated_at: string;
};

export type ModelListSuccessData = PublicModelListItem[] | AdminModelListItem[];

export const ModelCredentialsInputSchema = Schema.Struct({
    apiKey: NonEmptyTrimmedStringSchema,
    url: OptionalNonEmptyTrimmedStringSchema,
    resourceName: OptionalNonEmptyTrimmedStringSchema,
});
export type ModelCredentialsInput = MutableSchemaType<Schema.Schema.Type<typeof ModelCredentialsInputSchema>>;

export const ModelCreateInputSchema = Schema.Struct({
    model_id: NonEmptyTrimmedStringSchema,
    display_name: NonEmptyTrimmedStringSchema,
    type: AiModelTypeSchema,
    adapter: AiModelAdapterSchema,
    provider_model: NonEmptyTrimmedStringSchema,
    context_window: Schema.optional(
        Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(MIN_MODEL_CONTEXT_WINDOW_TOKENS)))
    ),
    credentials: ModelCredentialsInputSchema,
    is_default: Schema.optional(Schema.Boolean),
});
export type ModelCreateInput = MutableSchemaType<Schema.Schema.Type<typeof ModelCreateInputSchema>>;

export const ModelCredentialsPatchInputSchema = Schema.Struct({
    apiKey: OptionalNonEmptyTrimmedStringSchema,
    url: OptionalTrimmedStringSchema,
    resourceName: OptionalTrimmedStringSchema,
});
export type ModelCredentialsPatchInput = MutableSchemaType<Schema.Schema.Type<typeof ModelCredentialsPatchInputSchema>>;

export const ModelPatchInputSchema = Schema.Struct({
    display_name: OptionalNonEmptyTrimmedStringSchema,
    adapter: Schema.optional(AiModelAdapterSchema),
    provider_model: OptionalNonEmptyTrimmedStringSchema,
    context_window: Schema.optional(
        Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(MIN_MODEL_CONTEXT_WINDOW_TOKENS)))
    ),
    credentials: Schema.optional(ModelCredentialsPatchInputSchema),
});
export type ModelPatchInput = MutableSchemaType<Schema.Schema.Type<typeof ModelPatchInputSchema>>;

export const ModelQuerySchema = Schema.Struct({
    type: Schema.optional(AiModelTypeSchema),
});
export type ModelQuery = MutableSchemaType<Schema.Schema.Type<typeof ModelQuerySchema>>;

export type ModelListResponse = ApiResponse<
    ModelListSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR"
>;
