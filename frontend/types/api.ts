/**
 * API response and request types matching the backend API contract.
 * These types represent the raw JSON structures returned by the Go backend.
 * @module types/api
 */

/**
 * Group as returned by the /groups endpoint.
 */
export type ApiGroup = {
  group_id: number;
  group_name: string;
  role: string;
};

/**
 * Processing pipeline stages for project creation/update.
 */
export type ProcessStep =
  | "queued"
  | "processing_files"
  | "graph_creation"
  | "generating_descriptions"
  | "saving"
  | "completed"
  | "failed";

/**
 * Detailed progress counts for batch processing steps.
 * Matches BatchStepProgress in backend.
 */
export type ApiBatchStepProgress = {
  pending?: string;
  preprocessing?: string;
  preprocessed?: string;
  extracting?: string;
  indexing?: string;
  completed?: string;
  failed?: string;
};

/**
 * Project as returned by the /projects endpoint.
 * Includes processing state for in-progress operations.
 */
export type ApiProject = {
  project_id: number;
  project_name: string;
  project_state: "ready" | "create" | "update";
  process_step?: ApiBatchStepProgress;
  process_percentage?: number;
  process_estimated_duration?: number;
  process_time_remaining?: number;
};

/**
 * Group with nested projects array.
 */
export type ApiGroupWithProjects = {
  group_id: number;
  group_name: string;
  role: string;
  projects: ApiProject[];
};

/**
 * Processing status for individual files in a project.
 */
export type FileStatus = "processing" | "processed" | "failed" | "no_status";

/**
 * File metadata for files uploaded to a project.
 */
export type ApiProjectFile = {
  id: number;
  project_id: number;
  name: string;
  file_key: string;
  status?: FileStatus;
  created_at: {
    Time: string;
    Valid: boolean;
  };
  updated_at: {
    Time: string;
    Valid: boolean;
  };
};

/**
 * User membership in a group with role.
 */
export type ApiGroupUser = {
  group_id: number;
  user_id: number;
  role: string;
  created_at: {
    Time: string;
    Valid: boolean;
  };
  updated_at: {
    Time: string;
    Valid: boolean;
  };
};

/**
 * Query speed/depth modes.
 */
export type QueryMode = "agentic" | "normal";

/**
 * Query processing stages shown during streaming responses.
 */
export type QueryStep =
  | "thinking"
  | "db_query"
  | "search_entities"
  | "get_entity_neighbours"
  | "path_between_entities"
  | "get_entity_sources"
  | "get_relationship_sources"
  | "get_entity_details"
  | "get_entity_types"
  | "search_entities_by_type";

// ---------------------------------------------------------------------------
// Query contract
// ---------------------------------------------------------------------------

/**
 * Request body for POST /projects/:id/query and POST /projects/:id/stream.
 */
export type ApiProjectQueryRequest = {
  prompt: string;
  conversation_id?: string;
  mode?: QueryMode;
  model?: string;
  think?: boolean;
  tool_id?: string;
};

/**
 * Client-side tool call emitted by the backend when clarification is needed.
 */
export type ApiClientToolCall = {
  tool_call_id: string;
  tool_name: string;
  /** JSON-encoded arguments, typically `{ questions: string[], reason?: string }` */
  tool_arguments: string;
};

/**
 * Source file / citation reference returned in query responses.
 */
export type ApiResponseData = {
  id: string;
  name: string;
  key: string;
  text?: string;
};

/**
 * Response metrics from query endpoints.
 */
export type ApiQueryMetrics = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  duration_ms: number;
  wall_clock_ms?: number;
  tokens_per_second: number;
};

/**
 * Non-streaming response from POST /projects/:id/query.
 */
export type ApiProjectQueryResponse = {
  conversation_id: string;
  message: string;
  data: ApiResponseData[];
  client_tool_call?: ApiClientToolCall;
  reasoning?: string;
  considered_file_count: number;
  used_file_count: number;
};

// ---------------------------------------------------------------------------
// SSE event payloads for POST /projects/:id/stream
// ---------------------------------------------------------------------------

export type SSEConversationEvent = {
  conversation_id: string;
  is_new: boolean;
};

export type SSEReasoningEvent = {
  content: string;
};

export type SSEContentEvent = {
  content: string;
};

export type SSECitationEvent = {
  id: string;
  name?: string;
  key?: string;
  text?: string;
};

export type SSEStepEvent = {
  name: string;
};

export type SSEToolEvent = {
  name: string;
};

export type SSEMetricsEvent = ApiQueryMetrics;

export type SSEDoneEvent = {
  conversation_id: string;
  message: string;
  data: ApiResponseData[];
  reasoning?: string;
  client_tool_call?: ApiClientToolCall;
  used_file_count?: number;
  considered_file_count?: number;
};

export type SSEErrorEvent = {
  message: string;
};

/**
 * Discriminated union of all SSE events the frontend handles.
 */
export type SSEEvent =
  | { event: "conversation"; data: SSEConversationEvent }
  | { event: "reasoning"; data: SSEReasoningEvent }
  | { event: "content"; data: SSEContentEvent }
  | { event: "citation"; data: SSECitationEvent }
  | { event: "step"; data: SSEStepEvent }
  | { event: "tool"; data: SSEToolEvent }
  | { event: "client_tool_call"; data: ApiClientToolCall }
  | { event: "metrics"; data: SSEMetricsEvent }
  | { event: "done"; data: SSEDoneEvent }
  | { event: "error"; data: SSEErrorEvent };

// ---------------------------------------------------------------------------
// Chat history API types
// ---------------------------------------------------------------------------

/**
 * Conversation summary from GET /projects/:id/chats.
 */
export type ApiConversationSummary = {
  conversation_id: string;
  title: string;
};

/**
 * Single message in a chat transcript.
 */
export type ApiChatHistoryMessage = {
  role: "user" | "assistant";
  message: string;
  reasoning?: string;
  metrics?: ApiQueryMetrics;
  data?: ApiResponseData[];
};

/**
 * Full chat transcript from GET /projects/:id/chats/:conversation_id.
 */
export type ApiChatHistoryResponse = {
  conversation_id: string;
  title: string;
  messages: ApiChatHistoryMessage[];
};

/**
 * Text unit (chunk) from the knowledge graph.
 */
export type ApiTextUnit = {
  id: number;
  public_id: string;
  project_file_id: number;
  text: string;
  created_at: string;
  updated_at: string;
};

/**
 * Wrapper response for text unit fetch.
 */
export type ApiTextUnitResponse = {
  message: string;
  data: ApiTextUnit;
};
