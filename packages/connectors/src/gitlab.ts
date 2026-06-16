import { createGitRepositoryAdapter, readConnectorWebhookHeader } from "./adapters";
import { isSupportedCodePath } from "./code-files";
import type {
    GitResourceAdapter,
    FetchLike,
    NormalizedWebhookEvent,
    ProviderBranch,
    ProviderCodeFile,
    ProviderRepository,
    ProviderRepositoryClient,
    ProviderRepositoryDelta,
    ProviderRepositorySnapshot,
} from "./types";
import { ConnectorProviderError } from "./types";
import { branchNameFromGitRef, verifySharedSecretToken } from "./webhooks";
import { MAX_REPOSITORY_CODE_BYTES, MAX_REPOSITORY_CODE_FILES, MAX_REPOSITORY_CODE_FILE_BYTES } from "./github";

const SKIPPED_PATH_SEGMENTS: Record<string, true> = {
    ".git": true,
    ".next": true,
    ".turbo": true,
    build: true,
    coverage: true,
    dist: true,
    node_modules: true,
    out: true,
    vendor: true,
};

type GitLabClientOptions = {
    baseUrl: string;
    accessToken: string;
    fetch?: FetchLike;
};

type SnapshotOptions = GitLabClientOptions & {
    repository: ProviderRepository;
    branch: string;
    commitSha?: string;
};

export function normalizeGitLabBaseUrl(value: string): string {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new ConnectorProviderError("validation", "GitLab base URL must use HTTP or HTTPS");
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
}

export function createGitLabClient(options: GitLabClientOptions): GitResourceAdapter {
    const client: ProviderRepositoryClient = {
        provider: "gitlab",
        async getRepository(repositoryId) {
            return getGitLabProject(options, repositoryId);
        },
        async listRepositories() {
            return listGitLabProjects(options);
        },
        async listBranches(repository) {
            return listGitLabBranches({ ...options, repository });
        },
        async loadRepositorySnapshot(repository, branch, commitSha) {
            return loadGitLabRepositorySnapshot({ ...options, repository, branch, commitSha });
        },
        async compareRepository(repository, fromCommitSha, toCommitSha) {
            return compareGitLabRepository({ ...options, repository, fromCommitSha, toCommitSha });
        },
        async readFile(repository, path, commitSha) {
            return readGitLabRepositoryFile({ ...options, repository, path, commitSha });
        },
    };

    return createGitRepositoryAdapter({
        client,
        verifyWebhook(webhook) {
            return verifyGitLabWebhookToken({
                webhookSecret: webhook.webhookSecret,
                tokenHeader: readConnectorWebhookHeader(webhook.headers, "x-gitlab-token"),
            });
        },
        normalizeWebhook(webhook) {
            return normalizeGitLabWebhookEvent(webhook);
        },
    });
}

export async function getGitLabProject(
    options: GitLabClientOptions,
    repositoryId: string
): Promise<ProviderRepository> {
    return mapGitLabProject(
        await getGitLabJson(
            `${gitLabApiBase(options.baseUrl)}/projects/${encodeURIComponent(repositoryId)}`,
            options.accessToken,
            options.fetch
        )
    );
}

export async function listGitLabProjects(options: GitLabClientOptions): Promise<ProviderRepository[]> {
    const repositories: ProviderRepository[] = [];
    for (let page = 1; ; page += 1) {
        const json = await getGitLabJson(
            `${gitLabApiBase(options.baseUrl)}/projects?membership=true&per_page=100&page=${page}`,
            options.accessToken,
            options.fetch
        );
        if (!Array.isArray(json)) {
            throw new ConnectorProviderError("provider", "GitLab projects response is invalid");
        }
        for (const project of json) {
            repositories.push(mapGitLabProject(project));
        }
        if (json.length < 100) {
            return repositories;
        }
    }
}

export async function listGitLabBranches(
    options: GitLabClientOptions & { repository: ProviderRepository }
): Promise<ProviderBranch[]> {
    const branches: ProviderBranch[] = [];
    for (let page = 1; ; page += 1) {
        const json = await getGitLabJson(
            `${gitLabApiBase(options.baseUrl)}/projects/${encodeURIComponent(options.repository.id)}/repository/branches?per_page=100&page=${page}`,
            options.accessToken,
            options.fetch
        );
        if (!Array.isArray(json)) {
            throw new ConnectorProviderError("provider", "GitLab branches response is invalid");
        }
        for (const branch of json) {
            if (
                isObject(branch) &&
                typeof branch.name === "string" &&
                isObject(branch.commit) &&
                typeof branch.commit.id === "string"
            ) {
                branches.push({ name: branch.name, commitSha: branch.commit.id });
            }
        }
        if (json.length < 100) {
            return branches;
        }
    }
}

export async function loadGitLabRepositorySnapshot(options: SnapshotOptions): Promise<ProviderRepositorySnapshot> {
    let commitSha = options.commitSha;
    if (!commitSha) {
        const branchJson = await getGitLabJson(
            `${gitLabApiBase(options.baseUrl)}/projects/${encodeURIComponent(options.repository.id)}/repository/branches/${encodeURIComponent(options.branch)}`,
            options.accessToken,
            options.fetch
        );
        if (!isObject(branchJson) || !isObject(branchJson.commit) || typeof branchJson.commit.id !== "string") {
            throw new ConnectorProviderError("not-found", "GitLab branch was not found");
        }
        commitSha = branchJson.commit.id;
    }
    const branch: ProviderBranch = { name: options.branch, commitSha };
    const tree = await listGitLabTree(options, commitSha);
    const files: ProviderCodeFile[] = [];
    let totalBytes = 0;

    for (const item of tree) {
        if (!isGitLabBlob(item) || !shouldLoadCodePath(item.path)) {
            continue;
        }
        if (files.length + 1 > MAX_REPOSITORY_CODE_FILES) {
            throw new ConnectorProviderError("limit", "Repository contains too many supported code files");
        }
        const rawUrl = `${gitLabApiBase(options.baseUrl)}/projects/${encodeURIComponent(options.repository.id)}/repository/files/${encodeURIComponent(item.path)}/raw?ref=${encodeURIComponent(branch.commitSha)}`;
        const content = await getGitLabText(rawUrl, options.accessToken, options.fetch);
        const size = Buffer.byteLength(content, "utf8");
        if (size > MAX_REPOSITORY_CODE_FILE_BYTES) {
            continue;
        }
        if (totalBytes + size > MAX_REPOSITORY_CODE_BYTES) {
            throw new ConnectorProviderError("limit", "Repository contains too much supported code");
        }
        files.push({
            path: item.path,
            size,
            checksum: item.id,
            htmlUrl: `${options.repository.htmlUrl}/-/blob/${branch.commitSha}/${item.path}`,
            rawUrl,
            content,
        });
        totalBytes += size;
    }

    return { repository: options.repository, branch, commitSha: branch.commitSha, files };
}
export async function compareGitLabRepository(
    options: GitLabClientOptions & {
        repository: ProviderRepository;
        fromCommitSha: string;
        toCommitSha: string;
    }
): Promise<ProviderRepositoryDelta> {
    const json = await getGitLabJson(
        `${gitLabApiBase(options.baseUrl)}/projects/${encodeURIComponent(options.repository.id)}/repository/compare?from=${encodeURIComponent(options.fromCommitSha)}&to=${encodeURIComponent(options.toCommitSha)}&straight=true`,
        options.accessToken,
        options.fetch
    );
    if (!isObject(json)) {
        throw new ConnectorProviderError("provider", "GitLab compare response is invalid");
    }

    if (json.compare_timeout === true) {
        return {
            fromCommitSha: options.fromCommitSha,
            toCommitSha: options.toCommitSha,
            isIncremental: false,
            changes: [],
        };
    }

    if (!Array.isArray(json.diffs)) {
        throw new ConnectorProviderError("provider", "GitLab compare response is invalid");
    }

    const changes: ProviderRepositoryDelta["changes"] = [];
    for (const entry of json.diffs) {
        if (!isGitLabCompareFile(entry)) {
            throw new ConnectorProviderError("provider", "GitLab compare response is invalid");
        }

        if (entry.renamed_file) {
            const oldSupported = shouldLoadCodePath(entry.old_path);
            const newSupported = shouldLoadCodePath(entry.new_path);
            if (oldSupported && newSupported) {
                changes.push({ status: "renamed", oldPath: entry.old_path, newPath: entry.new_path });
            } else if (oldSupported) {
                changes.push({ status: "deleted", oldPath: entry.old_path });
            } else if (newSupported) {
                changes.push({ status: "added", newPath: entry.new_path });
            }
            continue;
        }

        if (entry.deleted_file) {
            if (shouldLoadCodePath(entry.old_path)) {
                changes.push({ status: "deleted", oldPath: entry.old_path });
            }
            continue;
        }

        if (entry.new_file) {
            if (shouldLoadCodePath(entry.new_path)) {
                changes.push({ status: "added", newPath: entry.new_path });
            }
            continue;
        }

        if (shouldLoadCodePath(entry.new_path)) {
            changes.push({ status: "modified", newPath: entry.new_path });
        }
    }

    return {
        fromCommitSha: options.fromCommitSha,
        toCommitSha: options.toCommitSha,
        isIncremental: true,
        changes,
    };
}

export async function readGitLabRepositoryFile(
    options: GitLabClientOptions & {
        repository: ProviderRepository;
        path: string;
        commitSha: string;
    }
): Promise<string> {
    const rawUrl = `${gitLabApiBase(options.baseUrl)}/projects/${encodeURIComponent(options.repository.id)}/repository/files/${encodeURIComponent(options.path)}/raw?ref=${encodeURIComponent(options.commitSha)}`;
    const content = await getGitLabText(rawUrl, options.accessToken, options.fetch);
    if (Buffer.byteLength(content, "utf8") > MAX_REPOSITORY_CODE_FILE_BYTES) {
        throw new ConnectorProviderError("limit", "Repository file is too large");
    }
    return content;
}

export function verifyGitLabWebhookToken(options: {
    webhookSecret: string;
    tokenHeader: string | null | undefined;
}): boolean {
    return verifySharedSecretToken(options.tokenHeader, options.webhookSecret);
}

export function normalizeGitLabWebhookEvent(options: {
    eventName: string;
    deliveryId: string;
    payload: unknown;
}): NormalizedWebhookEvent {
    const payload = isObject(options.payload) ? options.payload : {};
    const project = isObject(payload.project) ? payload.project : null;
    const resourceId =
        project && (typeof project.id === "string" || typeof project.id === "number") ? String(project.id) : null;
    const resourceDisplayName =
        project && typeof project.path_with_namespace === "string" ? project.path_with_namespace : null;
    const versionName = branchNameFromGitRef(payload.ref);
    const versionId = typeof payload.after === "string" ? payload.after : null;
    return {
        provider: "gitlab",
        deliveryId: options.deliveryId,
        eventName: options.eventName,
        resourceKind: "git-repository",
        resourceId,
        resourceDisplayName,
        resourceName: resourceDisplayName,
        versionName,
        versionId,
        repositoryId: resourceId,
        repositoryFullName: resourceDisplayName,
        branch: versionName,
        commitSha: versionId,
        raw: options.payload,
    };
}

async function listGitLabTree(options: SnapshotOptions, ref: string): Promise<unknown[]> {
    const entries: unknown[] = [];
    for (let page = 1; ; page += 1) {
        const json = await getGitLabJson(
            `${gitLabApiBase(options.baseUrl)}/projects/${encodeURIComponent(options.repository.id)}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}`,
            options.accessToken,
            options.fetch
        );
        if (!Array.isArray(json)) {
            throw new ConnectorProviderError("provider", "GitLab tree response is invalid");
        }
        entries.push(...json);
        if (json.length < 100) {
            return entries;
        }
    }
}

async function getGitLabJson(url: string, token: string, fetchImpl: FetchLike | undefined): Promise<unknown> {
    const response = await (fetchImpl ?? fetch)(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const text = await response.text();
    if (!response.ok) {
        throw new ConnectorProviderError(
            response.status === 404 ? "not-found" : "provider",
            "GitLab API request failed"
        );
    }
    return text.length === 0 ? null : JSON.parse(text);
}

async function getGitLabText(url: string, token: string, fetchImpl: FetchLike | undefined): Promise<string> {
    const response = await (fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${token}` } });
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_REPOSITORY_CODE_FILE_BYTES) {
        throw new ConnectorProviderError("limit", "Repository contains a code file that is too large");
    }
    const text = await response.text();
    if (!response.ok) {
        throw new ConnectorProviderError(
            response.status === 404 ? "not-found" : "provider",
            "GitLab raw file request failed"
        );
    }
    return text;
}

function mapGitLabProject(value: unknown): ProviderRepository {
    if (
        !isObject(value) ||
        typeof value.path_with_namespace !== "string" ||
        typeof value.name !== "string" ||
        (typeof value.id !== "string" && typeof value.id !== "number")
    ) {
        throw new ConnectorProviderError("provider", "GitLab project response is invalid");
    }
    return {
        provider: "gitlab",
        id: String(value.id),
        fullName: value.path_with_namespace,
        name: value.name,
        htmlUrl: typeof value.web_url === "string" ? value.web_url : "",
        defaultBranch: typeof value.default_branch === "string" ? value.default_branch : null,
        private: value.visibility !== "public",
    };
}

function gitLabApiBase(baseUrl: string): string {
    return `${normalizeGitLabBaseUrl(baseUrl)}/api/v4`;
}

function shouldLoadCodePath(filePath: string): boolean {
    const normalized = filePath.replaceAll("\\", "/");
    return (
        isSupportedCodePath(normalized) &&
        normalized.split("/").every((segment) => SKIPPED_PATH_SEGMENTS[segment] !== true)
    );
}

function isGitLabBlob(value: unknown): value is { id: string; path: string } {
    return isObject(value) && value.type === "blob" && typeof value.id === "string" && typeof value.path === "string";
}
function isGitLabCompareFile(value: unknown): value is {
    old_path: string;
    new_path: string;
    new_file: boolean;
    renamed_file: boolean;
    deleted_file: boolean;
} {
    return (
        isObject(value) &&
        typeof value.old_path === "string" &&
        typeof value.new_path === "string" &&
        typeof value.new_file === "boolean" &&
        typeof value.renamed_file === "boolean" &&
        typeof value.deleted_file === "boolean"
    );
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
