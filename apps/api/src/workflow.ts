import { WorkflowBackend, WorkflowClient } from "@kiwi/workflow";

export const workflowBackend = new WorkflowBackend();
export const wo = new WorkflowClient({ backend: workflowBackend });
