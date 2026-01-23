/**
 * Domain-level types for the frontend application.
 * These are transformed versions of API types, using string IDs and camelCase properties.
 * @module types/domain
 */

import type { ApiBatchStepProgress, ProcessStep } from "./api";

/**
 * Project lifecycle states.
 */
export type ProjectState = "ready" | "create" | "update";

export type { ProcessStep };

/**
 * Frontend project model with string IDs and processing state.
 */
export type Project = {
  id: string;
  name: string;
  state: ProjectState;
  lastUpdated?: Date;
  sourcesCount?: number;
  processStep?: ProcessStep;
  processProgress?: ApiBatchStepProgress;
  processPercentage?: number;
  processEstimatedDuration?: number;
  processTimeRemaining?: number;
};

/**
 * Frontend group model containing projects.
 */
export type Group = {
  id: string;
  name: string;
  projects: Project[];
};
