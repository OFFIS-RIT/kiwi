import type { ApiBatchStepProgress, ApiGraph, ApiGroup, ApiProjectFile, Group, ProcessStep } from "@/types";

function parseCount(value?: string): number {
    if (!value) return 0;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? 0 : parsed;
}

function determineProcessStep(progress?: ApiBatchStepProgress): ProcessStep | undefined {
    if (!progress) return undefined;

    const queuedCount = parseCount(progress.pending);
    const processingFilesCount =
        parseCount(progress.preprocessing) + parseCount(progress.metadata) + parseCount(progress.chunking);
    const graphCreationCount = parseCount(progress.extracting) + parseCount(progress.deduplicating);
    const savingCount = parseCount(progress.saving);
    const describingCount = parseCount(progress.describing);
    const failedCount = parseCount(progress.failed);
    const completedCount = parseCount(progress.completed);

    const activeStepCounts: { step: ProcessStep; count: number }[] = [
        { step: "generating_descriptions", count: describingCount },
        { step: "saving", count: savingCount },
        { step: "graph_creation", count: graphCreationCount },
        { step: "processing_files", count: processingFilesCount },
        { step: "failed", count: failedCount },
    ];

    let maxStep: ProcessStep | undefined = undefined;
    let maxCount = 0;

    for (const { step, count } of activeStepCounts) {
        if (count > maxCount) {
            maxCount = count;
            maxStep = step;
        }
    }

    if (maxStep) return maxStep;
    if (queuedCount > 0) return "queued";
    if (completedCount > 0) return "saving";
    return undefined;
}

export function transformGroupsWithGraphs(apiGroups: ApiGroup[], apiGraphs: ApiGraph[]): Group[] {
    return apiGroups.map((apiGroup) => {
        const projects = apiGraphs
            .filter((apiGraph) => apiGraph.group_id === apiGroup.group_id)
            .map((apiGraph) => ({
                id: apiGraph.graph_id,
                name: apiGraph.graph_name,
                state: apiGraph.graph_state,
                processStep: determineProcessStep(apiGraph.process_step as ApiBatchStepProgress | undefined),
                processProgress: apiGraph.process_step as ApiBatchStepProgress | undefined,
                processPercentage: apiGraph.process_percentage ?? (apiGraph.graph_state === "update" ? 0 : undefined),
                processEstimatedDuration: apiGraph.process_estimated_duration,
                processTimeRemaining: apiGraph.process_time_remaining,
                processEtaConfidence: apiGraph.process_eta_confidence,
                processEtaSampleCount: apiGraph.process_eta_sample_count,
            }));

        return {
            id: apiGroup.group_id,
            name: apiGroup.group_name,
            projects,
        };
    });
}

export function hasActiveProcessing(groups?: Group[]): boolean {
    return (
        groups?.some((group) =>
            group.projects.some(
                (project) =>
                    project.state !== "ready" ||
                    (project.processPercentage !== undefined &&
                        project.processPercentage >= 0 &&
                        project.processPercentage < 100)
            )
        ) ?? false
    );
}

export function hasProcessingFiles(files?: ApiProjectFile[]): boolean {
    return files?.some((file) => file.status === "processing") ?? false;
}
