export type CodeFileMetadataProvider = string;
export type CodeFileMetadataResourceKind = string;

export type CodeFileGitMetadata = {
    repositoryName: string;
    repositoryUrl?: string;
    commitSha: string;
    branch?: string;
};

export type CodeFileMetadata = {
    schemaVersion: 2;
    provider: CodeFileMetadataProvider;
    bindingId: string;
    resourceKind: CodeFileMetadataResourceKind;
    providerResourceId: string;
    resourceDisplayName: string;
    path: string;
    displayName: string;
    versionId?: string;
    providerFileId?: string;
    etag?: string;
    webUrl?: string;
    rawUrl?: string;
    git?: CodeFileGitMetadata;
};

export type LegacyCodeFileMetadata = {
    repositoryUrl: string;
    repositoryName: string;
    commitSha: string;
    path: string;
    external?: { provider: "github"; rawUrl: string; htmlUrl: string };
};

export function serializeCodeFileMetadata(metadata: CodeFileMetadata | LegacyCodeFileMetadata): string {
    return JSON.stringify(metadata);
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function optionalNonEmptyString(value: unknown): string | undefined | null {
    if (value === undefined || value === null) {
        return undefined;
    }
    return nonEmptyString(value) ? value : null;
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

function isHttpsUrl(value: string): boolean {
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

function displayNameFromPath(path: string): string {
    return path.split("/").filter(Boolean).at(-1) ?? path;
}

function providerFromRepositoryUrl(repositoryUrl: string): CodeFileMetadataProvider {
    try {
        return new URL(repositoryUrl).hostname === "github.com" ? "github" : "gitlab";
    } catch {
        return "gitlab";
    }
}

function parseGitMetadata(value: unknown): CodeFileGitMetadata | undefined | null {
    if (value === undefined) {
        return undefined;
    }
    if (!value || typeof value !== "object") {
        return null;
    }

    const candidate = value as Partial<CodeFileGitMetadata>;
    if (!nonEmptyString(candidate.repositoryName) || !nonEmptyString(candidate.commitSha)) {
        return null;
    }

    const repositoryUrl = optionalNonEmptyString(candidate.repositoryUrl);
    const branch = optionalNonEmptyString(candidate.branch);
    if (repositoryUrl === null || branch === null) {
        return null;
    }

    return {
        repositoryName: candidate.repositoryName,
        ...(repositoryUrl ? { repositoryUrl } : {}),
        commitSha: candidate.commitSha,
        ...(branch ? { branch } : {}),
    };
}

function parseV2Metadata(parsed: Record<string, unknown>): CodeFileMetadata | null {
    if (
        parsed.schemaVersion !== 2 ||
        !nonEmptyString(parsed.provider) ||
        !nonEmptyString(parsed.resourceKind) ||
        !nonEmptyString(parsed.bindingId) ||
        !nonEmptyString(parsed.providerResourceId) ||
        !nonEmptyString(parsed.resourceDisplayName) ||
        !nonEmptyString(parsed.path) ||
        !nonEmptyString(parsed.displayName)
    ) {
        return null;
    }

    const provider = parsed.provider as CodeFileMetadataProvider;
    const resourceKind = parsed.resourceKind as CodeFileMetadataResourceKind;
    const versionId = optionalNonEmptyString(parsed.versionId);
    const providerFileId = optionalNonEmptyString(parsed.providerFileId);
    const etag = optionalNonEmptyString(parsed.etag);
    const webUrl = optionalNonEmptyString(parsed.webUrl);
    const rawUrl = optionalNonEmptyString(parsed.rawUrl);
    const git = parseGitMetadata(parsed.git);
    if (
        versionId === null ||
        providerFileId === null ||
        etag === null ||
        webUrl === null ||
        rawUrl === null ||
        git === null
    ) {
        return null;
    }
    if (webUrl && !isHttpsUrl(webUrl)) {
        return null;
    }
    if (rawUrl) {
        if (parsed.provider === "github") {
            if (!isAllowedExternalUrl(rawUrl, "raw.githubusercontent.com")) {
                return null;
            }
        } else if (!isHttpsUrl(rawUrl)) {
            return null;
        }
    }

    return {
        schemaVersion: 2,
        provider,
        bindingId: parsed.bindingId,
        resourceKind,
        providerResourceId: parsed.providerResourceId,
        resourceDisplayName: parsed.resourceDisplayName,
        path: parsed.path,
        displayName: parsed.displayName,
        ...(versionId ? { versionId } : {}),
        ...(providerFileId ? { providerFileId } : {}),
        ...(etag ? { etag } : {}),
        ...(webUrl ? { webUrl } : {}),
        ...(rawUrl ? { rawUrl } : {}),
        ...(git ? { git } : {}),
    };
}

function parseV1Metadata(parsed: Record<string, unknown>): CodeFileMetadata | null {
    if (
        !nonEmptyString(parsed.repositoryUrl) ||
        !nonEmptyString(parsed.repositoryName) ||
        !nonEmptyString(parsed.commitSha) ||
        !nonEmptyString(parsed.path)
    ) {
        return null;
    }

    let rawUrl: string | undefined;
    let webUrl: string | undefined;
    if (parsed.external !== undefined) {
        if (!parsed.external || typeof parsed.external !== "object") {
            return null;
        }
        const external = parsed.external as Record<string, unknown>;
        if (
            external.provider !== "github" ||
            !isAllowedExternalUrl(external.rawUrl, "raw.githubusercontent.com") ||
            !isAllowedExternalUrl(external.htmlUrl, "github.com")
        ) {
            return null;
        }
        rawUrl = external.rawUrl;
        webUrl = external.htmlUrl;
    }

    return {
        schemaVersion: 2,
        provider: providerFromRepositoryUrl(parsed.repositoryUrl),
        bindingId: "",
        resourceKind: "git-repository",
        providerResourceId: "",
        resourceDisplayName: parsed.repositoryName,
        path: parsed.path,
        displayName: displayNameFromPath(parsed.path),
        versionId: parsed.commitSha,
        ...(webUrl ? { webUrl } : {}),
        ...(rawUrl ? { rawUrl } : {}),
        git: {
            repositoryName: parsed.repositoryName,
            repositoryUrl: parsed.repositoryUrl,
            commitSha: parsed.commitSha,
        },
    };
}

export function parseCodeFileMetadata(value: string | null | undefined): CodeFileMetadata | null {
    if (!value) {
        return null;
    }

    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object") {
            return null;
        }
        const record = parsed as Record<string, unknown>;
        return record.schemaVersion === 2 ? parseV2Metadata(record) : parseV1Metadata(record);
    } catch {
        return null;
    }
}
