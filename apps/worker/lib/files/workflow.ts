import type { GraphFileType } from "@kiwi/graph/file-type";
import { processCodeFileSpec } from "../../workflows/process-code-file-spec";
import { processFileSpec } from "../../workflows/process-file-spec";

export function fileProcessingWorkflow(
    graphId: string,
    fileId: string,
    fileType: GraphFileType | undefined,
    codeManifestKey?: string
) {
    return fileType === "code"
        ? {
              spec: processCodeFileSpec,
              input: {
                  graphId,
                  fileId,
                  ...(codeManifestKey ? { codeManifestKey } : {}),
              },
          }
        : {
              spec: processFileSpec,
              input: {
                  graphId,
                  fileId,
              },
          };
}

export function shouldAbortRepositoryBatch(
    code: { kind: "repository"; retiredFileIds?: string[] } | undefined,
    results: PromiseSettledResult<unknown>[]
) {
    return (
        code?.kind === "repository" &&
        code.retiredFileIds !== undefined &&
        results.some((result) => result.status === "rejected")
    );
}

export function shouldFinalizeRepositoryBatch(
    code: { kind: "repository"; retiredFileIds?: string[] } | undefined,
    results: PromiseSettledResult<unknown>[]
) {
    return (
        code?.kind === "repository" &&
        results.every((result) => result.status === "fulfilled") &&
        (results.length > 0 || (code.retiredFileIds?.length ?? 0) > 0)
    );
}
