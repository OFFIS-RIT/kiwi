import { createSign } from "node:crypto";
import { isSupportedCodePath } from "./code-files";
import type {
    FetchLike,
    GitHubConnectorCredentials,
    NormalizedWebhookEvent,
    ProviderBranch,
    ProviderCodeFile,
    ProviderInstallationAccount,
    ProviderRepository,
    ProviderRepositoryClient,
    ProviderRepositoryDelta,
    ProviderRepositorySnapshot,
} from "./types";
import { ConnectorProviderError } from "./types";
import { branchNameFromGitRef, verifyHmacSha256Signature } from "./webhooks";

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const MAX_REPOSITORY_CODE_FILES = 1_000;
export const MAX_REPOSITORY_CODE_BYTES = 100 * 1024 * 1024;
export const MAX_REPOSITORY_CODE_FILE_BYTES = 2 * 1024 * 1024;

const GITHUB_JWT_TTL_SECONDS = 9 * 60;
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

type GitHubClientOptions = {
    installationToken: string;
    apiBaseUrl?: string;
    fetch?: FetchLike;
};

type InstallationTokenOptions = {
    credentials: GitHubConnectorCredentials;
    installationId: string;
    apiBaseUrl?: string;
    fetch?: FetchLike;
    now?: Date;
};

type SnapshotOptions = GitHubClientOptions & {
    repository: ProviderRepository;
    branch: string;
    commitSha?: string;
};

export function createGitHubAppJwt(options: {
    appId: string;
    privateKeyPem: string;
    now?: Date;
    expiresInSeconds?: number;
}): string {
    const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1_000);
    const header = encodeJsonBase64Url({ alg: "RS256", typ: "JWT" });
    const payload = encodeJsonBase64Url({
        iat: nowSeconds - 60,
        exp: nowSeconds + (options.expiresInSeconds ?? GITHUB_JWT_TTL_SECONDS),
        iss: options.appId,
    });
    const signingInput = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(signingInput).sign(options.privateKeyPem, "base64url");
    return `${signingInput}.${signature}`;
}

export async function createGitHubInstallationToken(options: InstallationTokenOptions): Promise<{
    token: string;
    expiresAt: string;
}> {
    const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? GITHUB_API_BASE_URL);
    const response = await (options.fetch ?? fetch)(
        `${apiBaseUrl}/app/installations/${encodeURIComponent(options.installationId)}/access_tokens`,
        {
            method: "POST",
            headers: githubHeaders(
                createGitHubAppJwt({
                    appId: options.credentials.appId,
                    privateKeyPem: options.credentials.privateKeyPem,
                    now: options.now,
                })
            ),
            body: JSON.stringify({ permissions: { contents: "read", metadata: "read" } }),
        }
    );
    const json = await readJson(response);
    if (!response.ok || !isObject(json) || typeof json.token !== "string" || typeof json.expires_at !== "string") {
        throw new ConnectorProviderError("auth", "GitHub installation token request failed");
    }
    return { token: json.token, expiresAt: json.expires_at };
}

export async function getGitHubInstallationAccount(
    options: InstallationTokenOptions
): Promise<ProviderInstallationAccount> {
    const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? GITHUB_API_BASE_URL);
    const response = await (options.fetch ?? fetch)(
        `${apiBaseUrl}/app/installations/${encodeURIComponent(options.installationId)}`,
        {
            headers: githubHeaders(
                createGitHubAppJwt({
                    appId: options.credentials.appId,
                    privateKeyPem: options.credentials.privateKeyPem,
                    now: options.now,
                })
            ),
        }
    );
    const json = await readJson(response);
    if (!response.ok || !isObject(json) || !isObject(json.account) || typeof json.account.login !== "string") {
        throw new ConnectorProviderError("provider", "GitHub installation response is invalid");
    }

    return {
        login: json.account.login,
        type: gitHubAccountType(json.account.type),
        repositorySelection:
            json.repository_selection === "all" || json.repository_selection === "selected"
                ? json.repository_selection
                : "unknown",
    };
}

export function createGitHubClient(options: GitHubClientOptions): ProviderRepositoryClient {
    return {
        provider: "github",
        async listRepositories() {
            return listGitHubInstallationRepositories(options);
        },
        async listBranches(repository) {
            return listGitHubBranches({ ...options, repository });
        },
        async loadRepositorySnapshot(repository, branch, commitSha) {
            return loadGitHubRepositorySnapshot({ ...options, repository, branch, commitSha });
        },
        async compareRepository(repository, fromCommitSha, toCommitSha) {
            return compareGitHubRepository({ ...options, repository, fromCommitSha, toCommitSha });
        },
        async readFile(repository, path, commitSha) {
            return readGitHubRepositoryFile({ ...options, repository, path, commitSha });
        },
    };
}

export async function listGitHubInstallationRepositories(options: GitHubClientOptions): Promise<ProviderRepository[]> {
    const repositories: ProviderRepository[] = [];
    for (let page = 1; ; page += 1) {
        const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? GITHUB_API_BASE_URL);
        const json = await getGitHubJson(
            `${apiBaseUrl}/installation/repositories?per_page=100&page=${page}`,
            options.installationToken,
            options.fetch
        );
        if (!isObject(json) || !Array.isArray(json.repositories)) {
            throw new ConnectorProviderError("provider", "GitHub repository response is invalid");
        }
        for (const repo of json.repositories) {
            repositories.push(mapGitHubRepository(repo));
        }
        if (json.repositories.length < 100) {
            return repositories;
        }
    }
}

export async function listGitHubBranches(
    options: GitHubClientOptions & { repository: ProviderRepository }
): Promise<ProviderBranch[]> {
    const [owner, repo] = splitFullName(options.repository.fullName);
    const branches: ProviderBranch[] = [];
    for (let page = 1; ; page += 1) {
        const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? GITHUB_API_BASE_URL);
        const json = await getGitHubJson(
            `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100&page=${page}`,
            options.installationToken,
            options.fetch
        );
        if (!Array.isArray(json)) {
            throw new ConnectorProviderError("provider", "GitHub branches response is invalid");
        }
        for (const branch of json) {
            if (
                isObject(branch) &&
                typeof branch.name === "string" &&
                isObject(branch.commit) &&
                typeof branch.commit.sha === "string"
            ) {
                branches.push({ name: branch.name, commitSha: branch.commit.sha });
            }
        }
        if (json.length < 100) {
            return branches;
        }
    }
}

export async function loadGitHubRepositorySnapshot(options: SnapshotOptions): Promise<ProviderRepositorySnapshot> {
    const [owner, repo] = splitFullName(options.repository.fullName);
    const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? GITHUB_API_BASE_URL);
    let treeSha: string;
    let branch: ProviderBranch;
    if (options.commitSha) {
        const commitJson = await getGitHubJson(
            `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(options.commitSha)}`,
            options.installationToken,
            options.fetch
        );
        if (!isObject(commitJson) || !isObject(commitJson.tree) || typeof commitJson.tree.sha !== "string") {
            throw new ConnectorProviderError("not-found", "GitHub commit was not found");
        }
        treeSha = commitJson.tree.sha;
        branch = { name: options.branch, commitSha: options.commitSha };
    } else {
        const branchJson = await getGitHubJson(
            `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(options.branch)}`,
            options.installationToken,
            options.fetch
        );
        if (!isObject(branchJson) || !isObject(branchJson.commit) || typeof branchJson.commit.sha !== "string") {
            throw new ConnectorProviderError("not-found", "GitHub branch was not found");
        }
        treeSha =
            isObject(branchJson.commit.commit) &&
            isObject(branchJson.commit.commit.tree) &&
            typeof branchJson.commit.commit.tree.sha === "string"
                ? branchJson.commit.commit.tree.sha
                : branchJson.commit.sha;
        branch = { name: options.branch, commitSha: branchJson.commit.sha };
    }
    const treeJson = await getGitHubJson(
        `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
        options.installationToken,
        options.fetch
    );
    if (!isObject(treeJson) || !Array.isArray(treeJson.tree)) {
        throw new ConnectorProviderError("provider", "GitHub tree response is invalid");
    }
    if (treeJson.truncated === true) {
        throw new ConnectorProviderError("limit", "GitHub repository tree is too large to load completely");
    }

    const files: ProviderCodeFile[] = [];
    let totalBytes = 0;
    for (const item of treeJson.tree) {
        if (!isGitHubBlob(item) || !shouldLoadCodePath(item.path) || item.size > MAX_REPOSITORY_CODE_FILE_BYTES) {
            continue;
        }
        if (files.length + 1 > MAX_REPOSITORY_CODE_FILES) {
            throw new ConnectorProviderError("limit", "Repository contains too many supported code files");
        }
        if (totalBytes + item.size > MAX_REPOSITORY_CODE_BYTES) {
            throw new ConnectorProviderError("limit", "Repository contains too much supported code");
        }
        const blobJson = await getGitHubJson(
            `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(item.sha)}`,
            options.installationToken,
            options.fetch
        );
        if (!isObject(blobJson) || typeof blobJson.content !== "string" || blobJson.encoding !== "base64") {
            throw new ConnectorProviderError("provider", "GitHub blob response is invalid");
        }
        const content = Buffer.from(blobJson.content.replaceAll("\n", ""), "base64").toString("utf8");
        const size = Buffer.byteLength(content, "utf8");
        if (size > MAX_REPOSITORY_CODE_FILE_BYTES || totalBytes + size > MAX_REPOSITORY_CODE_BYTES) {
            throw new ConnectorProviderError("limit", "Repository contains too much supported code");
        }
        files.push({
            path: item.path,
            size,
            checksum: item.sha,
            htmlUrl: `https://github.com/${options.repository.fullName}/blob/${branch.commitSha}/${item.path}`,
            rawUrl: `https://raw.githubusercontent.com/${options.repository.fullName}/${branch.commitSha}/${item.path}`,
            content,
        });
        totalBytes += size;
    }

    return { repository: options.repository, branch, commitSha: branch.commitSha, files };
}
export async function compareGitHubRepository(
    options: GitHubClientOptions & {
        repository: ProviderRepository;
        fromCommitSha: string;
        toCommitSha: string;
    }
): Promise<ProviderRepositoryDelta> {
    const [owner, repo] = splitFullName(options.repository.fullName);
    const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? GITHUB_API_BASE_URL);
    const json = await getGitHubJson(
        `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(options.fromCommitSha)}...${encodeURIComponent(options.toCommitSha)}`,
        options.installationToken,
        options.fetch
    );
    if (!isObject(json) || !isGitHubCompareStatus(json.status)) {
        throw new ConnectorProviderError("provider", "GitHub compare response is invalid");
    }

    if (json.status === "behind" || json.status === "diverged") {
        return {
            fromCommitSha: options.fromCommitSha,
            toCommitSha: options.toCommitSha,
            isIncremental: false,
            changes: [],
        };
    }

    if (!Array.isArray(json.files)) {
        throw new ConnectorProviderError("provider", "GitHub compare response is invalid");
    }

    const changes: ProviderRepositoryDelta["changes"] = [];
    for (const entry of json.files) {
        if (!isGitHubCompareFile(entry)) {
            throw new ConnectorProviderError("provider", "GitHub compare response is invalid");
        }

        switch (entry.status) {
            case "added":
            case "copied":
                if (shouldLoadCodePath(entry.filename)) {
                    changes.push({ status: "added", newPath: entry.filename });
                }
                break;
            case "modified":
            case "changed":
                if (shouldLoadCodePath(entry.filename)) {
                    changes.push({ status: "modified", newPath: entry.filename });
                }
                break;
            case "removed":
                if (shouldLoadCodePath(entry.filename)) {
                    changes.push({ status: "deleted", oldPath: entry.filename });
                }
                break;
            case "renamed": {
                const oldSupported = shouldLoadCodePath(entry.previous_filename);
                const newSupported = shouldLoadCodePath(entry.filename);
                if (oldSupported && newSupported) {
                    changes.push({ status: "renamed", oldPath: entry.previous_filename, newPath: entry.filename });
                } else if (oldSupported) {
                    changes.push({ status: "deleted", oldPath: entry.previous_filename });
                } else if (newSupported) {
                    changes.push({ status: "added", newPath: entry.filename });
                }
                break;
            }
            case "unchanged":
                break;
            default:
                throw new ConnectorProviderError("provider", "GitHub compare response is invalid");
        }
    }

    return {
        fromCommitSha: options.fromCommitSha,
        toCommitSha: options.toCommitSha,
        isIncremental: true,
        changes,
    };
}

export async function readGitHubRepositoryFile(
    options: GitHubClientOptions & {
        repository: ProviderRepository;
        path: string;
        commitSha: string;
    }
): Promise<string> {
    const [owner, repo] = splitFullName(options.repository.fullName);
    const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? GITHUB_API_BASE_URL);
    const response = await (options.fetch ?? fetch)(
        `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathSegments(options.path)}?ref=${encodeURIComponent(options.commitSha)}`,
        {
            headers: {
                ...githubHeaders(options.installationToken),
                Accept: "application/vnd.github.raw+json",
            },
        }
    );

    if (!response.ok) {
        throw new ConnectorProviderError("not-found", "GitHub file was not found");
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_REPOSITORY_CODE_FILE_BYTES) {
        throw new ConnectorProviderError("limit", "Repository file is too large");
    }

    const content = await response.text();
    if (Buffer.byteLength(content, "utf8") > MAX_REPOSITORY_CODE_FILE_BYTES) {
        throw new ConnectorProviderError("limit", "Repository file is too large");
    }

    return content;
}

export function verifyGitHubWebhookSignature(options: {
    body: string | Buffer | Uint8Array;
    webhookSecret: string;
    signatureHeader: string | null | undefined;
}): boolean {
    return verifyHmacSha256Signature({
        body: options.body,
        secret: options.webhookSecret,
        signatureHeader: options.signatureHeader,
        prefix: "sha256=",
    });
}

export function normalizeGitHubWebhookEvent(options: {
    eventName: string;
    deliveryId: string;
    payload: unknown;
}): NormalizedWebhookEvent {
    const payload = isObject(options.payload) ? options.payload : {};
    const repository = isObject(payload.repository) ? payload.repository : null;
    const installation = isObject(payload.installation) ? payload.installation : null;
    return {
        provider: "github",
        deliveryId: options.deliveryId,
        eventName: options.eventName,
        repositoryId:
            repository && (typeof repository.id === "string" || typeof repository.id === "number")
                ? String(repository.id)
                : null,
        repositoryFullName: repository && typeof repository.full_name === "string" ? repository.full_name : null,
        branch: branchNameFromGitRef(payload.ref),
        commitSha: typeof payload.after === "string" ? payload.after : null,
        installationId:
            installation && (typeof installation.id === "string" || typeof installation.id === "number")
                ? String(installation.id)
                : undefined,
        raw: options.payload,
    };
}

async function getGitHubJson(url: string, token: string, fetchImpl: FetchLike | undefined): Promise<unknown> {
    const response = await (fetchImpl ?? fetch)(url, { headers: githubHeaders(token) });
    const json = await readJson(response);
    if (!response.ok) {
        throw new ConnectorProviderError(
            response.status === 404 ? "not-found" : "provider",
            "GitHub API request failed"
        );
    }
    return json;
}

function githubHeaders(token: string): Record<string, string> {
    return {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
    };
}

function mapGitHubRepository(value: unknown): ProviderRepository {
    if (
        !isObject(value) ||
        typeof value.full_name !== "string" ||
        typeof value.name !== "string" ||
        (typeof value.id !== "string" && typeof value.id !== "number")
    ) {
        throw new ConnectorProviderError("provider", "GitHub repository response is invalid");
    }
    return {
        provider: "github",
        id: String(value.id),
        fullName: value.full_name,
        name: value.name,
        htmlUrl: typeof value.html_url === "string" ? value.html_url : `https://github.com/${value.full_name}`,
        defaultBranch: typeof value.default_branch === "string" ? value.default_branch : null,
        private: value.private === true,
    };
}

function splitFullName(fullName: string): [string, string] {
    const [owner, repo, ...extra] = fullName.split("/");
    if (!owner || !repo || extra.length > 0) {
        throw new ConnectorProviderError("validation", "Repository full name is invalid");
    }
    return [owner, repo];
}

function encodePathSegments(value: string): string {
    return value.split("/").map(encodeURIComponent).join("/");
}

function gitHubAccountType(value: unknown): ProviderInstallationAccount["type"] {
    if (value === "User") {
        return "user";
    }
    if (value === "Organization") {
        return "organization";
    }
    return null;
}

async function readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    return text.length === 0 ? null : JSON.parse(text);
}

function shouldLoadCodePath(filePath: string): boolean {
    const normalized = filePath.replaceAll("\\", "/");
    return (
        isSupportedCodePath(normalized) &&
        normalized.split("/").every((segment) => SKIPPED_PATH_SEGMENTS[segment] !== true)
    );
}

function normalizeApiBaseUrl(value: string): string {
    return value.replace(/\/+$/, "");
}

function encodeJsonBase64Url(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function isGitHubBlob(value: unknown): value is { path: string; sha: string; size: number } {
    return (
        isObject(value) &&
        value.type === "blob" &&
        typeof value.path === "string" &&
        typeof value.sha === "string" &&
        typeof value.size === "number"
    );
}
function isGitHubCompareStatus(value: unknown): value is "ahead" | "behind" | "diverged" | "identical" {
    return value === "ahead" || value === "behind" || value === "diverged" || value === "identical";
}

function isGitHubCompareFile(value: unknown): value is {
    filename: string;
    status: "added" | "changed" | "copied" | "modified" | "removed" | "renamed" | "unchanged";
    previous_filename: string;
} {
    return (
        isObject(value) &&
        typeof value.filename === "string" &&
        typeof value.status === "string" &&
        (value.status !== "renamed" || typeof value.previous_filename === "string")
    );
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
