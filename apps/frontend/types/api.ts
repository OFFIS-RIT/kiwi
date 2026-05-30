/**
 * API-facing frontend types derived from the shared backend contract.
 * @module types/api
 */

import type {
    ApiBatchStepProgressLike,
    GraphDetailSuccessData,
    GraphFileListItem,
    GraphListItem,
    OrganizationMemberListItem,
    SourceReferenceRecord,
    TeamUserListItem,
    TeamListItem,
    TextUnitRecord,
    TextUnitResponse,
} from "@kiwi/api/types";

/**
 * Team as returned by the /teams endpoint.
 */
export type ApiGroup = TeamListItem;

/**
 * Processing pipeline stages for project creation/update.
 */
export type ProcessStep =
    | "waiting_worker"
    | "queued"
    | "deleting_files"
    | "processing_files"
    | "graph_creation"
    | "generating_descriptions"
    | "saving"
    | "completed"
    | "failed";

export type ApiBatchStepProgress = ApiBatchStepProgressLike;

/**
 * Graph as returned by the GET /graphs endpoint.
 * Includes processing state for in-progress operations.
 */
export type ApiGraph = GraphListItem;

/**
 * Detailed project payload returned by GET /graphs/:id.
 */
export type ApiProjectDetail = GraphDetailSuccessData;

/**
 * Processing status for individual files in a project.
 */
export type FileStatus = "processing" | "processed" | "failed" | "no_status";

/**
 * File metadata for files uploaded to a project.
 */
export type ApiProjectFile = GraphFileListItem;

/**
 * User membership in a team with role.
 */
export type ApiGroupUser = TeamUserListItem;

export type ApiOrganizationMember = OrganizationMemberListItem;

/**
 * Text unit (chunk) from the knowledge graph.
 */
export type ApiTextUnit = TextUnitRecord;

/**
 * Source reference payload including selected chunks and optional PDF crop regions.
 */
export type ApiSourceReference = SourceReferenceRecord;

/**
 * Wrapper response for text unit fetch.
 */
export type ApiTextUnitResponse = TextUnitResponse;
