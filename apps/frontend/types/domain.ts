/**
 * Domain-level types for the frontend application.
 * These are transformed versions of API types, using string IDs and camelCase properties.
 * @module types/domain
 */

import type { ApiBatchStepProgress, ProcessStep } from "./api";

/**
 * Project lifecycle states.
 */
export type ProjectState = "ready" | "update";

export type { ProcessStep };

export type ProjectChatSummary = {
    id: string;
    title: string;
    isPinned: boolean;
    updatedAt: string | null;
};

/**
 * Frontend project model with string IDs and processing state.
 */
export type Project = {
    id: string;
    name: string;
    state: ProjectState;
    lastUpdated?: Date;
    sourcesCount?: number;
    hasFailedFiles?: boolean;
    processStep?: ProcessStep;
    processProgress?: ApiBatchStepProgress;
    processPercentage?: number;
    processEstimatedDuration?: number;
    processTimeRemaining?: number;
    recentChats: ProjectChatSummary[];
};

/**
 * Frontend team/organization bucket containing projects.
 */
export type Group = {
    id: string;
    name: string;
    role: "admin" | "moderator" | "member";
    scope: "organization" | "team";
    projects: Project[];
};
