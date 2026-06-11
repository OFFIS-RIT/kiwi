/**
 * AI Models API functions for the chat model selector and the admin
 * AI Models settings section.
 * @module api/models
 */

import type {
    AdminModelListItem,
    AiModelType,
    ApiResponse,
    ModelCreateInput,
    ModelPatchInput,
    PublicModelListItem,
} from "@kiwi/contracts";
import { unwrapApiResponse, type KiwiApiClient } from "./client";

type PublicModelListResponse = ApiResponse<PublicModelListItem[]>;
type AdminModelListResponse = ApiResponse<AdminModelListItem[]>;
type AdminModelResponse = ApiResponse<AdminModelListItem>;

function modelPath(modelId: string): string {
    return `/models/${encodeURIComponent(modelId)}`;
}

/**
 * Lists the AI Models selectable in chat — text models only. Regular members
 * get nothing else from the backend anyway; the explicit type filter matters
 * for admins, whose unfiltered list would include every model type.
 */
export async function fetchSelectableModels(client: KiwiApiClient): Promise<PublicModelListItem[]> {
    const response = await client.get<PublicModelListResponse>("/models?type=text");
    return unwrapApiResponse(response);
}

/**
 * Lists all AI Models for the admin section, optionally filtered by type.
 * Requires organization-admin access (system admins qualify).
 */
export async function fetchAdminModels(client: KiwiApiClient, type?: AiModelType): Promise<AdminModelListItem[]> {
    const query = type ? `?type=${encodeURIComponent(type)}` : "";
    const response = await client.get<AdminModelListResponse>(`/models${query}`);
    return unwrapApiResponse(response);
}

/**
 * Creates an AI Model. The backend normalizes the requested model_id and may
 * append a numeric suffix; the returned model_id is canonical.
 */
export async function createModel(client: KiwiApiClient, input: ModelCreateInput): Promise<AdminModelListItem> {
    const response = await client.post<AdminModelResponse>("/models", input);
    return unwrapApiResponse(response);
}

/**
 * Updates an AI Model's editable fields. Credentials are write-only: only
 * include them when the user entered a replacement.
 */
export async function updateModel(
    client: KiwiApiClient,
    modelId: string,
    input: ModelPatchInput
): Promise<AdminModelListItem> {
    const response = await client.patch<AdminModelResponse>(modelPath(modelId), input);
    return unwrapApiResponse(response);
}

/** Makes the AI Model the default for its type, clearing the previous default. */
export async function setDefaultModel(client: KiwiApiClient, modelId: string): Promise<AdminModelListItem> {
    const response = await client.post<AdminModelResponse>(`${modelPath(modelId)}/default`);
    return unwrapApiResponse(response);
}

/**
 * Deletes an AI Model. Deleting a default promotes the oldest remaining model
 * of the same type, if one exists.
 */
export async function deleteModel(client: KiwiApiClient, modelId: string): Promise<void> {
    await client.delete<null>(modelPath(modelId));
}
