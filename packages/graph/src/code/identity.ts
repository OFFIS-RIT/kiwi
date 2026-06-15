import { createHash } from "node:crypto";
import type { CodeManifestDefinition, CodeRepositoryFile } from "./types";

export function entityName(definition: CodeManifestDefinition): string {
    return `${fileEntityName(definition)}#${definition.qualifiedName}`;
}

export function fileEntityName(file: Pick<CodeRepositoryFile, "repositoryUrl" | "path">): string {
    return `${file.repositoryUrl}:${file.path}`;
}

export function fileEntityId(repositoryUrl: string, commitSha: string, filePath: string): string {
    return stableId("code_file", repositoryUrl, commitSha, filePath);
}

export function definitionKey(filePath: string, simpleName: string): string {
    return `${filePath}\0${simpleName}`;
}

export function stableId(prefix: string, ...parts: string[]): string {
    const hash = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
    return `${prefix}_${hash}`;
}
