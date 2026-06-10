/**
 * Prompts API functions for the user/organization/team/graph prompt scopes.
 * @module api/prompts
 */

import type {
    GraphPromptCreateResponse,
    GraphPromptDeleteResponse,
    GraphPromptListResponse,
    GraphPromptPatchResponse,
    OrganizationPromptCreateResponse,
    OrganizationPromptDeleteResponse,
    OrganizationPromptListResponse,
    OrganizationPromptPatchResponse,
    PromptRecord,
    TeamPromptCreateResponse,
    TeamPromptDeleteResponse,
    TeamPromptListResponse,
    TeamPromptPatchResponse,
    UserPromptCreateResponse,
    UserPromptDeleteResponse,
    UserPromptListResponse,
    UserPromptPatchResponse,
} from "@kiwi/contracts";
import { unwrapApiResponse, type KiwiApiClient } from "./client";

export type PromptScope =
    | { kind: "user"; userId: string }
    | { kind: "organization"; organizationId: string }
    | { kind: "team"; teamId: string }
    | { kind: "graph"; graphId: string };

type PromptListResponse =
    | UserPromptListResponse
    | OrganizationPromptListResponse
    | TeamPromptListResponse
    | GraphPromptListResponse;

type PromptWriteResponse =
    | UserPromptCreateResponse
    | OrganizationPromptCreateResponse
    | TeamPromptCreateResponse
    | GraphPromptCreateResponse
    | UserPromptPatchResponse
    | OrganizationPromptPatchResponse
    | TeamPromptPatchResponse
    | GraphPromptPatchResponse;

type PromptDeleteResponse =
    | UserPromptDeleteResponse
    | OrganizationPromptDeleteResponse
    | TeamPromptDeleteResponse
    | GraphPromptDeleteResponse;

export function promptScopePath(scope: PromptScope): string {
    switch (scope.kind) {
        case "user":
            return `/prompts/users/${scope.userId}`;
        case "organization":
            return `/prompts/organizations/${scope.organizationId}`;
        case "team":
            return `/prompts/teams/${scope.teamId}`;
        case "graph":
            return `/prompts/graphs/${scope.graphId}`;
    }
}

export async function fetchPrompts(client: KiwiApiClient, scope: PromptScope): Promise<PromptRecord[]> {
    const response = await client.get<PromptListResponse>(promptScopePath(scope));
    return unwrapApiResponse(response);
}

export async function createPrompt(client: KiwiApiClient, scope: PromptScope, prompt: string): Promise<PromptRecord> {
    const response = await client.post<PromptWriteResponse>(promptScopePath(scope), { prompt });
    return unwrapApiResponse(response);
}

export async function updatePrompt(
    client: KiwiApiClient,
    scope: PromptScope,
    promptId: string,
    prompt: string
): Promise<PromptRecord> {
    const response = await client.patch<PromptWriteResponse>(`${promptScopePath(scope)}/${promptId}`, { prompt });
    return unwrapApiResponse(response);
}

export async function deletePrompt(client: KiwiApiClient, scope: PromptScope, promptId: string): Promise<void> {
    await client.delete<PromptDeleteResponse>(`${promptScopePath(scope)}/${promptId}`);
}

/**
 * Saves the scope's single product-level Prompt from the editor's text.
 * The text field is the source of truth: an empty text deletes every stored
 * prompt, otherwise the first prompt is updated (or created) and any extra
 * API-created prompts are removed so chat injection matches the editor.
 */
export async function savePromptText(
    client: KiwiApiClient,
    scope: PromptScope,
    existing: PromptRecord[],
    text: string
): Promise<void> {
    const trimmed = text.trim();
    const [first, ...rest] = existing;

    if (trimmed.length === 0) {
        for (const record of existing) {
            await deletePrompt(client, scope, record.id);
        }
        return;
    }

    if (!first) {
        await createPrompt(client, scope, trimmed);
        return;
    }

    if (first.prompt !== trimmed) {
        await updatePrompt(client, scope, first.id, trimmed);
    }

    for (const record of rest) {
        await deletePrompt(client, scope, record.id);
    }
}

export type { PromptRecord };
