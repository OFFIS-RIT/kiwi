import type { CodeRepositoryFile } from "@kiwi/graph/code/repository";
import { parseCodeFileMetadata, serializeCodeFileMetadata } from "@kiwi/graph/code/metadata";
import type { CodeFileMetadata } from "@kiwi/graph/code/metadata";

type CodeRepositoryFileMetadataFields = Omit<CodeRepositoryFile, "fileId" | "content">;

export function codeRepositoryFileFieldsFromMetadata(
    metadata: CodeFileMetadata | null,
    fallback: { graphId: string; name: string }
): CodeRepositoryFileMetadataFields {
    if (!metadata) {
        return {
            repositoryUrl: `graph:${fallback.graphId}`,
            repositoryName: "code",
            commitSha: "unknown",
            path: fallback.name,
        };
    }

    return {
        repositoryUrl: metadata.git?.repositoryUrl ?? `connector:${metadata.bindingId}:${metadata.providerResourceId}`,
        repositoryName: metadata.git?.repositoryName ?? metadata.resourceDisplayName,
        commitSha: metadata.git?.commitSha ?? metadata.versionId ?? "unknown",
        path: metadata.path,
    };
}

export { parseCodeFileMetadata, serializeCodeFileMetadata };
export type { CodeFileMetadata };
