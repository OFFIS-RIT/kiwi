/**
 * API module - centralized exports for all API functions
 */

// Re-export client utilities
export { ApiError, createKiwiApiClient, unwrapApiResponse } from "./client";
export type { KiwiApiClient } from "./client";
export type {
    ApiErrorCode,
    BaseResponse,
    ChatCreateResponse,
    ChatDetailResponse,
    ChatHistoryRecord,
    ChatLibraryItem,
    ChatLibrarySuccessData,
    ChatListResponse,
    ChatListSuccessData,
    ChatRequestBody,
    SearchChatItem,
    SearchProjectItem,
    SearchResponse,
    SearchSuccessData,
    SearchTeamItem,
    ChatSummaryItem,
    ErrorResponse,
    GraphAddFilesResponse,
    GraphFilesResponse,
    GraphListResponse,
    SuccessfulResponse,
    GraphCreateResponse,
    GraphDeleteFilesResponse,
    GraphDeleteResponse,
    GraphDetailResponse,
    GraphFileDownloadResponse,
    GraphPatchResponse,
    TeamAvailableUsersResponse,
    TeamCreateResponse,
    TeamDeleteResponse,
    TeamListResponse,
    TeamUsersResponse,
    TeamPatchResponse,
    SourceReferenceBatchResponse,
    SourceReferenceResponse,
    TextUnitResponse,
} from "@kiwi/contracts";
export type {
    ConnectorBranchListResponse,
    ConnectorBranchRecord,
    ConnectorInstallationListResponse,
    ConnectorInstallationRecord,
    ConnectorListResponse,
    ConnectorProvider,
    ConnectorRecord,
    ConnectorRepositoryListResponse,
    ConnectorRepositoryRecord,
    GitHubConnectorManifestStartInput,
    GitHubConnectorManifestStartResponse,
    GitHubConnectorManifestStartSuccessData,
    GitLabConnectorCreateInput,
    GitLabConnectorCreateResponse,
    RepositoryGraphBindingRecord,
    RepositoryGraphBindingResponse,
    RepositoryGraphBindingSyncResponse,
    RepositoryGraphBindingSyncSuccessData,
    RepositoryGraphCreateInput,
    RepositoryGraphCreateResponse,
    RepositoryGraphCreateSuccessData,
} from "@kiwi/contracts";


// Re-export team API helpers under the existing frontend group names.
export {
    addGroupUser,
    createGroup,
    deleteGroup,
    fetchGraphs,
    fetchGroups,
    fetchGroupAvailableUsers,
    fetchGroupUsers,
    removeGroupUser,
    updateGroup,
    updateGroupUsers,
} from "./groups";
export {
    completeGitHubConnectorInstallation,
    completeGitHubConnectorManifest,
    createGitLabConnector,
    createRepositoryGraph,
    fetchConnectorBranches,
    fetchConnectorInstallations,
    fetchConnectorRepositories,
    fetchConnectors,
    fetchRepositoryGraphBinding,
    startConnectorConnect,
    startGitHubConnectorManifest,
    syncRepositoryGraphBinding,
} from "./connectors";


// Re-export projects API
export {
    addFilesToProject,
    applyProjectSuggestion,
    archiveProjectChat,
    archiveTeamChat,
    createProject,
    deleteProject,
    deleteProjectChat,
    deleteProjectFiles,
    deleteProjectSuggestion,
    deleteTeamChat,
    downloadProjectFile,
    fetchArchivedChats,
    fetchPinnedChats,
    fetchProjectChat,
    fetchProjectChats,
    fetchProjectChatsPage,
    fetchProjectDetail,
    fetchProjectFiles,
    fetchProjectSuggestions,
    fetchSourceReference,
    fetchSourceReferences,
    fetchTextUnit,
    getApiAssetUrl,
    getProjectFileUrl,
    pinProjectChat,
    pinTeamChat,
    retryProjectFile,
    searchSidebarTargets,
    unarchiveProjectChat,
    unarchiveTeamChat,
    unpinProjectChat,
    unpinTeamChat,
    updateProject,
} from "./projects";

// Re-export models API
export {
    createModel,
    deleteModel,
    fetchAdminModels,
    fetchSelectableModels,
    setDefaultModel,
    updateModel,
} from "./models";

// Re-export prompts API
export { createPrompt, deletePrompt, fetchPrompts, savePromptText, updatePrompt } from "./prompts";
export type { PromptRecord, PromptScope } from "./prompts";

// Re-export types for convenience
export type {
    ApiGraph,
    ApiGroup,
    ApiGroupUser,
    ApiProjectFile,
    ApiSourceReference,
    ApiTextUnit,
    ApiTextUnitResponse,
} from "@/types/api";
