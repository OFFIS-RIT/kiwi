/**
 * Projects API functions for CRUD operations and querying.
 * @module api/projects
 */

import type {
    GraphCreateResponse,
    GraphCreateSuccessData,
    GraphDeleteResponse,
    GraphDeleteSuccessData,
    GraphDetailResponse,
    GraphDetailSuccessData,
    GraphFilesResponse,
    GraphPatchResponse,
    GraphPatchSuccessData,
    TextUnitResponse,
} from "@kiwi/api/types";
import type {
    ApiChatHistoryResponse,
    ApiClientToolCall,
    ApiConversationSummary,
    ApiProjectFile,
    ApiProjectQueryRequest,
    ApiProjectQueryResponse,
    ApiTextUnit,
    SSECitationEvent,
    SSEContentEvent,
    SSEConversationEvent,
    SSEDoneEvent,
    SSEErrorEvent,
    SSEMetricsEvent,
    SSEReasoningEvent,
    SSEStepEvent,
    SSEToolEvent,
} from "@/types/api";
import { apiClient, type SSEFrame, streamSSERequest, unwrapApiResponse } from "./client";

/**
 * Creates a new project within a group with optional file uploads.
 * @param groupId - Parent group ID
 * @param name - Project name
 * @param files - Files to upload initially
 * @param onProgress - Optional callback for upload progress (0-100)
 */
export async function createProject(
    groupId: string,
    name: string,
    files: File[],
    onProgress?: (progress: number, loaded: number, total: number) => void
): Promise<GraphCreateSuccessData> {
    const formData = new FormData();
    formData.append("groupId", groupId);
    formData.append("name", name);
    files.forEach((file) => formData.append("files", file));

    const response = await apiClient.postFormDataWithProgress<GraphCreateResponse>("/graphs", formData, onProgress);

    return unwrapApiResponse(response);
}

/**
 * Updates project metadata.
 * @param projectId - Project to update
 * @param name - New project name
 */
export async function updateProject(projectId: string, name: string): Promise<GraphPatchSuccessData> {
    const response = await apiClient.patch<GraphPatchResponse>(`/graphs/${projectId}`, { name });

    return unwrapApiResponse(response);
}

/**
 * Deletes a project and all associated data.
 * @param projectId - Project to delete
 */
export async function deleteProject(projectId: string): Promise<GraphDeleteSuccessData> {
    const response = await apiClient.delete<GraphDeleteResponse>(`/graphs/${projectId}`);

    return unwrapApiResponse(response);
}

/**
 * Fetches the detailed graph/project record from the current API route.
 */
export async function fetchProjectDetail(projectId: string): Promise<GraphDetailSuccessData> {
    const response = await apiClient.get<GraphDetailResponse>(`/graphs/${projectId}`);

    return unwrapApiResponse(response);
}

/**
 * Fetches all files associated with a project.
 * @param projectId - Project to fetch files from
 */
export async function fetchProjectFiles(projectId: string): Promise<ApiProjectFile[]> {
    const response = await apiClient.get<GraphFilesResponse>(`/graphs/${projectId}/files`);
    const files = unwrapApiResponse(response);

    return files.map((file) => ({
        id: file.id,
        project_id: file.project_id,
        name: file.name,
        file_key: file.file_key,
        created_at: file.created_at,
        updated_at: file.updated_at,
    }));
}

/**
 * Uploads additional files to an existing project.
 * @param projectId - Target project
 * @param files - Files to upload
 * @param onProgress - Optional callback for upload progress (0-100)
 */
export async function addFilesToProject(
    projectId: string,
    files: File[],
    onProgress?: (progress: number, loaded: number, total: number) => void
): Promise<GraphPatchSuccessData> {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file));

    const response = await apiClient.patchFormDataWithProgress<GraphPatchResponse>(
        `/graphs/${projectId}`,
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
export async function deleteProjectFiles(projectId: string, fileKeys: string[]): Promise<GraphPatchSuccessData> {
    const response = await apiClient.patch<GraphPatchResponse>(`/graphs/${projectId}`, {
        removedFileIds: fileKeys,
    });

    return unwrapApiResponse(response);
}

export type { GraphCreateSuccessData, GraphDeleteSuccessData, GraphDetailSuccessData, GraphPatchSuccessData };

/**
 * Sends a query to the project's knowledge base (non-streaming).
 * Uses the new contract: prompt + conversation_id.
 */
export async function queryProject(
    projectId: string,
    request: ApiProjectQueryRequest
): Promise<ApiProjectQueryResponse> {
    return apiClient.post<ApiProjectQueryResponse>(`/projects/${projectId}/query`, request);
}

/**
 * Handlers for individual SSE events during a streaming query.
 */
export type StreamEventHandlers = {
    onConversation?: (data: SSEConversationEvent) => void;
    onReasoning?: (data: SSEReasoningEvent) => void;
    onContent?: (data: SSEContentEvent) => void;
    onCitation?: (data: SSECitationEvent) => void;
    onStep?: (data: SSEStepEvent) => void;
    onTool?: (data: SSEToolEvent) => void;
    onClientToolCall?: (data: ApiClientToolCall) => void;
    onMetrics?: (data: SSEMetricsEvent) => void;
    onDone?: (data: SSEDoneEvent) => void;
    onError?: (data: SSEErrorEvent) => void;
};

/**
 * Streams a query to the project's knowledge base using real SSE frames.
 *
 * @param projectId - Project to query
 * @param request - Query request body (prompt, conversation_id, mode, think, tool_id)
 * @param handlers - Callbacks for each SSE event type
 * @param onStreamError - Error callback for network/parse errors
 */
export async function queryProjectStream(
    projectId: string,
    request: ApiProjectQueryRequest,
    handlers: StreamEventHandlers,
    onStreamError?: (error: Error) => void
): Promise<void> {
    return streamSSERequest(
        `/projects/${projectId}/stream`,
        request,
        (frame: SSEFrame) => {
            switch (frame.event) {
                case "conversation":
                    handlers.onConversation?.(frame.data as SSEConversationEvent);
                    break;
                case "reasoning":
                    handlers.onReasoning?.(frame.data as SSEReasoningEvent);
                    break;
                case "content":
                    handlers.onContent?.(frame.data as SSEContentEvent);
                    break;
                case "citation":
                    handlers.onCitation?.(frame.data as SSECitationEvent);
                    break;
                case "step":
                    handlers.onStep?.(frame.data as SSEStepEvent);
                    break;
                case "tool":
                    handlers.onTool?.(frame.data as SSEToolEvent);
                    break;
                case "client_tool_call":
                    handlers.onClientToolCall?.(frame.data as ApiClientToolCall);
                    break;
                case "metrics":
                    handlers.onMetrics?.(frame.data as SSEMetricsEvent);
                    break;
                case "done":
                    handlers.onDone?.(frame.data as SSEDoneEvent);
                    break;
                case "error":
                    handlers.onError?.(frame.data as SSEErrorEvent);
                    break;
                default:
                    console.warn("Unknown SSE event:", frame.event, frame.data);
            }
        },
        onStreamError
    );
}

// ---------------------------------------------------------------------------
// Chat history API
// ---------------------------------------------------------------------------

/**
 * Fetches the list of conversations for a project.
 */
export async function fetchProjectChats(projectId: string): Promise<ApiConversationSummary[]> {
    return apiClient.get<ApiConversationSummary[]>(`/projects/${projectId}/chats`);
}

/**
 * Fetches the full chat transcript for a specific conversation.
 */
export async function fetchProjectChat(projectId: string, conversationId: string): Promise<ApiChatHistoryResponse> {
    return apiClient.get<ApiChatHistoryResponse>(`/projects/${projectId}/chats/${conversationId}`);
}

/**
 * Deletes a conversation.
 */
export async function deleteProjectChat(projectId: string, conversationId: string): Promise<void> {
    await apiClient.delete(`/projects/${projectId}/chats/${conversationId}`);
}

/**
 * Fetches a specific text unit by ID.
 * @param unitId - Text unit identifier
 */
export async function fetchTextUnit(unitId: string): Promise<ApiTextUnit> {
    const response = await apiClient.get<TextUnitResponse>(`/units/${unitId}`);
    return unwrapApiResponse(response);
}

/**
 * Generates a download URL for a project file.
 * @param projectId - Project containing the file
 * @param fileKey - File key to download
 * @returns Presigned download URL
 */
export async function downloadProjectFile(projectId: string, fileKey: string): Promise<string> {
    const response = await apiClient.post<{ message: string }>(`/projects/${projectId}/file`, { file_key: fileKey });
    return response.message;
}
