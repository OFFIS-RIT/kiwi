/**
 * Projects API functions for CRUD operations and querying.
 * @module api/projects
 */

import type {
  ApiChatHistoryResponse,
  ApiClientToolCall,
  ApiConversationSummary,
  ApiProjectFile,
  ApiProjectQueryRequest,
  ApiProjectQueryResponse,
  ApiTextUnit,
  ApiTextUnitResponse,
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
import { apiClient, type SSEFrame, streamSSERequest } from "./client";

type CreateProjectResponse = {
  project?: {
    id: number;
    name: string;
  };
};

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
): Promise<CreateProjectResponse> {
  const formData = new FormData();
  formData.append("group_id", groupId);
  formData.append("name", name);
  files.forEach((file) => formData.append("files", file));

  return apiClient.postFormDataWithProgress<CreateProjectResponse>(
    "/projects",
    formData,
    onProgress
  );
}

/**
 * Updates project metadata.
 * @param projectId - Project to update
 * @param name - New project name
 */
export async function updateProject(projectId: string, name: string) {
  return apiClient.patch(`/projects/${projectId}`, { name });
}

/**
 * Deletes a project and all associated data.
 * @param projectId - Project to delete
 */
export async function deleteProject(projectId: string) {
  return apiClient.delete(`/projects/${projectId}`);
}

/**
 * Fetches all files associated with a project.
 * @param projectId - Project to fetch files from
 */
export async function fetchProjectFiles(
  projectId: string
): Promise<ApiProjectFile[]> {
  return apiClient.get<ApiProjectFile[]>(`/projects/${projectId}/files`);
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
) {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  return apiClient.postFormDataWithProgress(
    `/projects/${projectId}/files`,
    formData,
    onProgress
  );
}

/**
 * Deletes files from a project by their keys.
 * @param projectId - Project containing the files
 * @param fileKeys - Array of file keys to delete
 */
export async function deleteProjectFiles(
  projectId: string,
  fileKeys: string[]
) {
  return apiClient.delete(`/projects/${projectId}/files`, {
    file_keys: fileKeys,
  });
}

/**
 * Sends a query to the project's knowledge base (non-streaming).
 * Uses the new contract: prompt + conversation_id.
 */
export async function queryProject(
  projectId: string,
  request: ApiProjectQueryRequest
): Promise<ApiProjectQueryResponse> {
  return apiClient.post<ApiProjectQueryResponse>(
    `/projects/${projectId}/query`,
    request
  );
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
 * @param request - Query request body (prompt, conversation_id, mode, model, think, tool_id)
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
export async function fetchProjectChats(
  projectId: string
): Promise<ApiConversationSummary[]> {
  return apiClient.get<ApiConversationSummary[]>(
    `/projects/${projectId}/chats`
  );
}

/**
 * Fetches the full chat transcript for a specific conversation.
 */
export async function fetchProjectChat(
  projectId: string,
  conversationId: string
): Promise<ApiChatHistoryResponse> {
  return apiClient.get<ApiChatHistoryResponse>(
    `/projects/${projectId}/chats/${conversationId}`
  );
}

/**
 * Deletes a conversation.
 */
export async function deleteProjectChat(
  projectId: string,
  conversationId: string
): Promise<void> {
  await apiClient.delete(`/projects/${projectId}/chats/${conversationId}`);
}

/**
 * Fetches a specific text unit by ID.
 * @param unitId - Text unit identifier
 */
export async function fetchTextUnit(unitId: string): Promise<ApiTextUnit> {
  const response = await apiClient.get<ApiTextUnitResponse>(
    `/projects/units/${unitId}`
  );
  return response.data;
}

/**
 * Generates a download URL for a project file.
 * @param projectId - Project containing the file
 * @param fileKey - File key to download
 * @returns Presigned download URL
 */
export async function downloadProjectFile(
  projectId: string,
  fileKey: string
): Promise<string> {
  const response = await apiClient.post<{ message: string }>(
    `/projects/${projectId}/file`,
    { file_key: fileKey }
  );
  return response.message;
}
