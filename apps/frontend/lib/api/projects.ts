/**
 * Projects API functions for CRUD operations and querying.
 * @module api/projects
 */

import type {
    ArchivedChatsResponse,
    ChatLibraryItem,
    ChatLibrarySuccessData,
    ChatListSuccessData,
    ChatDetailResponse,
    ChatHistoryRecord,
    ChatListResponse,
    PinnedChatsResponse,
    SearchChatItem,
    SearchProjectItem,
    SearchResponse,
    SearchTeamItem,
    ChatSummaryItem,
    GraphAddFilesResponse,
    GraphAddFilesSuccessData,
    GraphCreateResponse,
    GraphCreateSuccessData,
    GraphDeleteResponse,
    GraphDeleteFilesResponse,
    GraphDeleteFilesSuccessData,
    GraphDeleteSuccessData,
    GraphDetailResponse,
    GraphDetailSuccessData,
    GraphFileDownloadResponse,
    GraphFilesResponse,
    GraphPatchResponse,
    GraphPatchSuccessData,
    TextUnitResponse,
} from "@kiwi/api/types";
import { getProjectFileProxyPath } from "@kiwi/files/project-file-proxy-path";
import type { ApiProjectFile, ApiTextUnit } from "@/types/api";
import { ApiError, unwrapApiResponse, type KiwiApiClient } from "./client";

export const ORGANIZATION_GROUP_ID = "__organization__";
export const PERSONAL_GROUP_ID = "__personal__";

/**
 * Creates a new project within a team or organization with optional file uploads.
 * @param groupId - Parent team ID, or an ownership pseudo-group ID
 * @param name - Project name
 * @param files - Files to upload initially
 * @param onProgress - Optional callback for upload progress (0-100)
 */
export async function createProject(
    client: KiwiApiClient,
    groupId: string,
    name: string,
    files: File[],
    onProgress?: (progress: number, loaded: number, total: number) => void
): Promise<GraphCreateSuccessData> {
    const formData = new FormData();
    if (groupId !== ORGANIZATION_GROUP_ID && groupId !== PERSONAL_GROUP_ID) {
        formData.append("teamId", groupId);
    }
    formData.append("name", name);
    files.forEach((file) => formData.append("files", file));

    const response = await client.postFormDataWithProgress<GraphCreateResponse>("/graphs", formData, onProgress);

    return unwrapApiResponse(response);
}

/**
 * Updates project metadata.
 * @param projectId - Project to update
 * @param name - New project name
 */
export async function updateProject(
    client: KiwiApiClient,
    projectId: string,
    name: string
): Promise<GraphPatchSuccessData> {
    const response = await client.patch<GraphPatchResponse>(`/graphs/${projectId}`, { name });

    return unwrapApiResponse(response);
}

/**
 * Deletes a project and all associated data.
 * @param projectId - Project to delete
 */
export async function deleteProject(client: KiwiApiClient, projectId: string): Promise<GraphDeleteSuccessData> {
    const response = await client.delete<GraphDeleteResponse>(`/graphs/${projectId}`);

    return unwrapApiResponse(response);
}

/**
 * Fetches the detailed graph/project record from the current API route.
 */
export async function fetchProjectDetail(client: KiwiApiClient, projectId: string): Promise<GraphDetailSuccessData> {
    const response = await client.get<GraphDetailResponse>(`/graphs/${projectId}`);

    return unwrapApiResponse(response);
}

/**
 * Fetches all files associated with a project.
 * @param projectId - Project to fetch files from
 */
export async function fetchProjectFiles(client: KiwiApiClient, projectId: string): Promise<ApiProjectFile[]> {
    const response = await client.get<GraphFilesResponse>(`/graphs/${projectId}/files`);
    return unwrapApiResponse(response);
}

/**
 * Uploads additional files to an existing project.
 * @param projectId - Target project
 * @param files - Files to upload
 * @param onProgress - Optional callback for upload progress (0-100)
 */
export async function addFilesToProject(
    client: KiwiApiClient,
    projectId: string,
    files: File[],
    onProgress?: (progress: number, loaded: number, total: number) => void
): Promise<GraphAddFilesSuccessData> {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file));

    const response = await client.postFormDataWithProgress<GraphAddFilesResponse>(
        `/graphs/${projectId}/files`,
        formData,
        onProgress
    );

    return unwrapApiResponse(response);
}

/**
 * Deletes files from a project by their keys.
 * @param projectId - Project containing the files
 * @param fileKeys - Array of file keys to delete
 */
export async function deleteProjectFiles(
    client: KiwiApiClient,
    projectId: string,
    fileKeys: string[]
): Promise<GraphDeleteFilesSuccessData> {
    const response = await client.delete<GraphDeleteFilesResponse>(`/graphs/${projectId}/files`, {
        fileKeys,
    });

    return unwrapApiResponse(response);
}

export type {
    GraphAddFilesSuccessData,
    GraphCreateSuccessData,
    GraphDeleteFilesSuccessData,
    GraphDeleteSuccessData,
    GraphDetailSuccessData,
    GraphPatchSuccessData,
};

/**
 * Fetches the list of conversations for a project.
 */
export async function fetchProjectChats(client: KiwiApiClient, projectId: string): Promise<ChatSummaryItem[]> {
    const response = await client.get<ChatListResponse>(`/chat/${projectId}`);
    return unwrapApiResponse(response).items;
}

export async function fetchProjectChatsPage(
    client: KiwiApiClient,
    projectId: string,
    options: { offset?: number; limit?: number } = {}
): Promise<ChatListSuccessData> {
    const searchParams = new URLSearchParams();
    if (typeof options.offset === "number") {
        searchParams.set("offset", String(options.offset));
    }
    if (typeof options.limit === "number") {
        searchParams.set("limit", String(options.limit));
    }

    const query = searchParams.toString();
    const response = await client.get<ChatListResponse>(`/chat/${projectId}${query ? `?${query}` : ""}`);
    return unwrapApiResponse(response);
}

/**
 * Fetches the full chat transcript for a specific conversation.
 */
export async function fetchProjectChat(
    client: KiwiApiClient,
    projectId: string,
    conversationId: string,
    options: { suppressNotFoundLog?: boolean } = {}
): Promise<ChatHistoryRecord> {
    const endpoint = `/chat/${projectId}/${conversationId}`;
    const response = options.suppressNotFoundLog
        ? await client.getQuietly<ChatDetailResponse>(
              endpoint,
              (error) =>
                  error instanceof ApiError &&
                  (error.code === "CHAT_NOT_FOUND" || error.message.includes("CHAT_NOT_FOUND"))
          )
        : await client.get<ChatDetailResponse>(endpoint);
    return unwrapApiResponse(response);
}

/**
 * Deletes a conversation.
 */
export async function deleteProjectChat(
    client: KiwiApiClient,
    projectId: string,
    conversationId: string
): Promise<void> {
    await client.delete(`/chat/${projectId}/${conversationId}`);
}

export async function pinProjectChat(client: KiwiApiClient, projectId: string, conversationId: string): Promise<void> {
    await client.post(`/chat/${projectId}/${conversationId}/pin`);
}

export async function unpinProjectChat(
    client: KiwiApiClient,
    projectId: string,
    conversationId: string
): Promise<void> {
    await client.post(`/chat/${projectId}/${conversationId}/unpin`);
}

export async function archiveProjectChat(
    client: KiwiApiClient,
    projectId: string,
    conversationId: string
): Promise<void> {
    await client.post(`/chat/${projectId}/${conversationId}/archive`);
}

export async function unarchiveProjectChat(
    client: KiwiApiClient,
    projectId: string,
    conversationId: string
): Promise<void> {
    await client.post(`/chat/${projectId}/${conversationId}/unarchive`);
}

/**
 * Fetches the user's pinned chats across all accessible projects.
 */
export async function fetchPinnedChats(client: KiwiApiClient): Promise<ChatLibraryItem[]> {
    const response = await client.get<PinnedChatsResponse>("/chats/pinned");
    return unwrapApiResponse(response).items;
}

/**
 * Fetches a page of the user's archived chats across all accessible projects.
 */
export async function fetchArchivedChats(
    client: KiwiApiClient,
    options: { offset?: number; limit?: number } = {}
): Promise<ChatLibrarySuccessData> {
    const searchParams = new URLSearchParams();
    if (typeof options.offset === "number") {
        searchParams.set("offset", String(options.offset));
    }
    if (typeof options.limit === "number") {
        searchParams.set("limit", String(options.limit));
    }

    const query = searchParams.toString();
    const response = await client.get<ArchivedChatsResponse>(`/chats/archived${query ? `?${query}` : ""}`);
    return unwrapApiResponse(response);
}

export type SidebarSearchResults = {
    projects: SearchProjectItem[];
    teams: SearchTeamItem[];
    chats: SearchChatItem[];
};

export async function searchSidebarTargets(client: KiwiApiClient, query: string): Promise<SidebarSearchResults> {
    const searchParams = new URLSearchParams({ q: query });
    const response = await client.get<SearchResponse>(`/search?${searchParams.toString()}`);
    return unwrapApiResponse(response);
}

/**
 * Fetches a specific text unit by ID.
 * @param projectId - Graph containing the text unit
 * @param unitId - Text unit identifier
 */
export async function fetchTextUnit(client: KiwiApiClient, projectId: string, unitId: string): Promise<ApiTextUnit> {
    const response = await client.get<TextUnitResponse>(`/graphs/${projectId}/units/${unitId}`);
    return unwrapApiResponse(response);
}

/**
 * Generates a download URL for a project file.
 * @param projectId - Project containing the file
 * @param fileKey - File key to download
 * @returns Authenticated file URL
 */
export async function downloadProjectFile(client: KiwiApiClient, projectId: string, fileKey: string): Promise<string> {
    const response = await client.post<GraphFileDownloadResponse>(`/graphs/${projectId}/file`, {
        file_key: fileKey,
    });
    const url = unwrapApiResponse(response).url;
    return isAbsoluteUrl(url) ? url : getApiAssetUrl(client, url);
}

export function getProjectFileUrl(
    client: KiwiApiClient,
    projectId: string,
    fileId: string,
    options: { fileName?: string | null; page?: number | null } = {}
): string {
    return getApiAssetUrl(client, getProjectFileProxyPath(projectId, fileId, options));
}

export function getApiAssetUrl(client: KiwiApiClient, path: string): string {
    const normalizedBase = client.baseURL.replace(/\/+$/u, "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    return `${normalizedBase}${normalizedPath}`;
}

function isAbsoluteUrl(url: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/iu.test(url);
}
