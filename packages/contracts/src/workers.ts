import type { ApiResponse } from "./errors";

export type WorkerEtaRunStatus = "idle" | "pending" | "started" | "completed" | "failed";

export type WorkerGraphEta = {
    graph_id: string;
    process_run_id: string | null;
    status: WorkerEtaRunStatus;
    process_estimated_duration?: number;
    process_time_remaining?: number;
};

export type WorkerGraphEtaResponse = ApiResponse<WorkerGraphEta>;
