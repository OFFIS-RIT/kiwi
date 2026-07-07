import type { WorkflowRetryState, WorkflowRunMetadata } from "openworkflow";

const CONTROL_SIGNAL_NAMES = new Set(["SleepSignal", "StaleExecutionBranchError"]);

/**
 * OpenWorkflow control-flow signals (sleep parking, stale parallel branches).
 * They reach workflow code through rejected step promises and catch blocks,
 * must propagate unchanged, and never count as failures.
 */
export function isWorkflowControlSignal(error: unknown): boolean {
    return error instanceof Error && CONTROL_SIGNAL_NAMES.has(error.name);
}

function getWorkflowRetryState(error: unknown): WorkflowRetryState | null {
    if (error instanceof Error && typeof (error as Error & Partial<WorkflowRetryState>).retryTerminal === "boolean") {
        return error as Error & WorkflowRetryState;
    }

    return null;
}

/**
 * Whether rethrowing this error will terminally fail the workflow run.
 * Step errors carry accurate per-step retry state; for app-thrown errors the
 * run-level state mirrors the engine's workflow-retry decision. Note that
 * `run.retryTerminal` counts claims (including sleep wake-ups), so it is only
 * used when no per-step state is available.
 */
export function isTerminalWorkflowFailure(error: unknown, run: WorkflowRunMetadata): boolean {
    if (isWorkflowControlSignal(error)) {
        return false;
    }

    return getWorkflowRetryState(error)?.retryTerminal ?? run.retryTerminal;
}

/**
 * Real failures from a settled batch of step promises. Control signals are
 * dropped: a step rejecting with one means the run is parked to sleep, not
 * that the step failed.
 */
export function settledStepFailures(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
    return results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason)
        .filter((reason) => !isWorkflowControlSignal(reason));
}

/**
 * Normalize an error for rethrowing out of a workflow. Control signals and
 * step errors pass through unchanged so OpenWorkflow keeps its sleep and
 * per-step retry semantics; anything else is wrapped into a plain Error.
 */
export function toWorkflowError(error: unknown): Error {
    if (error instanceof Error) {
        if (isWorkflowControlSignal(error) || getWorkflowRetryState(error)) {
            return error;
        }

        return new Error(error.message, { cause: error });
    }

    return new Error("Workflow failed", { cause: error });
}
