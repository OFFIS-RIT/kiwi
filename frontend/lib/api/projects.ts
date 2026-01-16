/**
 * Projects API functions for CRUD operations and querying.
 * @module api/projects
 */

import type {
  ApiChatMessage,
  ApiProjectFile,
  ApiQueryResponse,
  ApiTextUnit,
  ApiTextUnitResponse,
  QueryMode,
  QueryStep,
} from "@/types/api";
import { apiClient, streamRequest } from "./client";

/**
 * Maps frontend query modes to backend API modes.
 */
const MODE_MAPPING: Record<QueryMode, string> = {
  detailed: "detailed",
  normal: "normal",
  fast: "fast",
};

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
  onProgress?: (progress: number) => void
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
  onProgress?: (progress: number) => void
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
 * @param projectId - Project to query
 * @param messages - Chat message history
 */
export async function queryProject(
  projectId: string,
  messages: ApiChatMessage[]
): Promise<ApiQueryResponse> {
  return apiClient.post<ApiQueryResponse>(`/projects/${projectId}/query`, {
    messages,
  });
}

/**
 * Response metrics from streaming queries.
 */
type StreamMetrics = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  duration_ms: number;
  tokens_per_second: number;
};

/**
 * Source file reference returned in query responses.
 */
type SourceFile = {
  id: string;
  name: string;
  key: string;
};

/**
 * Streams a query to the project's knowledge base with real-time responses.
 * @param projectId - Project to query
 * @param messages - Chat message history
 * @param onMessage - Callback for each streamed response chunk
 * @param mode - Query mode: "fast", "normal", or "detailed"
 * @param model - Optional model override
 * @param think - Enable thinking mode
 * @param onError - Error callback
 * @param onComplete - Completion callback
 */
export async function queryProjectStream(
  projectId: string,
  messages: ApiChatMessage[],
  onMessage: (
    message: string,
    data: SourceFile[],
    metrics?: StreamMetrics,
    step?: QueryStep,
    reasoning?: string
  ) => void,
  mode?: QueryMode,
  model?: string,
  think?: boolean,
  onError?: (error: Error) => void,
  onComplete?: () => void
): Promise<void> {
  const body = {
    messages,
    ...(mode && { mode: MODE_MAPPING[mode] }),
    ...(model && { model }),
    ...(think !== undefined && { think }),
  };

  return streamRequest(
    `/projects/${projectId}/stream`,
    body,
    (line) => {
      try {
        const response = JSON.parse(line) as ApiQueryResponse;
        onMessage(
          response.message,
          response.data,
          response.metrics,
          response.step,
          response.reasoning
        );
      } catch (parseError) {
        console.error("Failed to parse stream response:", line, parseError);
      }
    },
    onError,
    onComplete
  );
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
