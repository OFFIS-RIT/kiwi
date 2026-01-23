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
 * Project as returned by the /projects endpoint.
 * Includes processing state for in-progress operations.
 */
export type ApiProject = {
  project_id: number;
  project_name: string;
  project_state: "ready" | "create" | "update";
  process_step?: ProcessStep;
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
 * File metadata for files uploaded to a project.
 */
export type ApiProjectFile = {
  id: number;
  project_id: number;
  name: string;
  file_key: string;
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
 * Chat message format for the query API.
 */
export type ApiChatMessage = {
  role: "user" | "assistant";
  message: string;
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

/**
 * Response structure from the /projects/:id/query and /projects/:id/stream endpoints.
 */
export type ApiQueryResponse = {
  step?: QueryStep;
  message: string;
  reasoning?: string;
  data: {
    id: string;
    name: string;
    key: string;
  }[];
  metrics?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    duration_ms: number;
    tokens_per_second: number;
  };
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
