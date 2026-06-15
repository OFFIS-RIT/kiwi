import type { CodeRepositoryFile } from "./repository";

export type CodeFileExternalMetadata = {
    provider: "github";
    rawUrl: string;
    htmlUrl: string;
};

export type CodeFileMetadata = Omit<CodeRepositoryFile, "fileId" | "content"> & {
    external?: CodeFileExternalMetadata;
};

export function serializeCodeFileMetadata(metadata: CodeFileMetadata): string {
    return JSON.stringify(metadata);
}


function isAllowedExternalUrl(value: unknown, host: string): value is string {
    if (typeof value !== "string") {
        return false;
    }

    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === host;
    } catch {
        return false;
    }
}

export function parseCodeFileMetadata(value: string | null | undefined): CodeFileMetadata | null {
    if (!value) {
        return null;
    }

    try {
        const parsed = JSON.parse(value) as Partial<CodeFileMetadata>;
        if (
            typeof parsed.repositoryUrl !== "string" ||
            typeof parsed.repositoryName !== "string" ||
            typeof parsed.commitSha !== "string" ||
            typeof parsed.path !== "string"
        ) {
            return null;
        }

        const external =
            parsed.external &&
            typeof parsed.external === "object" &&
            "provider" in parsed.external &&
            parsed.external.provider === "github" &&
            "rawUrl" in parsed.external &&
            isAllowedExternalUrl(parsed.external.rawUrl, "raw.githubusercontent.com") &&
            "htmlUrl" in parsed.external &&
            isAllowedExternalUrl(parsed.external.htmlUrl, "github.com")
                ? {
                      provider: parsed.external.provider,
                      rawUrl: parsed.external.rawUrl,
                      htmlUrl: parsed.external.htmlUrl,
                  }
                : undefined;

        if (parsed.external && !external) {
            return null;
        }

        return {
            repositoryUrl: parsed.repositoryUrl,
            repositoryName: parsed.repositoryName,
            commitSha: parsed.commitSha,
            path: parsed.path,
            ...(external ? { external } : {}),
        };
    } catch {
        return null;
    }
}
