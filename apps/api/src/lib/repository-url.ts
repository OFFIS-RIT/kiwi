import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isSupportedCodePath } from "@kiwi/graph/code/file-path";

export type RepositorySourceFile = {
    path: string;
    content: string;
    size: number;
};

export type LoadedRepository = {
    url: string;
    name: string;
    commitSha: string;
    files: RepositorySourceFile[];
};

export type RepositoryUrlErrorKind = "validation" | "limit" | "load";

export class RepositoryUrlError extends Error {
    constructor(
        public readonly kind: RepositoryUrlErrorKind,
        message: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = "RepositoryUrlError";
    }
}

export const MAX_REPOSITORY_URLS = 5;
export const MAX_REPOSITORY_CODE_FILES = 1_000;
export const MAX_REPOSITORY_CODE_BYTES = 100 * 1024 * 1024;
const MAX_REPOSITORY_CODE_FILE_BYTES = 2 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_GIT_OUTPUT_BYTES = 1 * 1024 * 1024;
const ALLOWED_REPOSITORY_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
const SKIPPED_PATH_SEGMENTS = new Set([
    ".git",
    ".next",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "vendor",
]);

export function normalizeRepositoryUrl(input: string): { url: string; name: string } {
    let parsed: URL;
    try {
        parsed = new URL(input.trim());
    } catch (error) {
        throw new RepositoryUrlError("validation", "Repository URL is invalid", { cause: error });
    }
    if (parsed.protocol !== "https:") {
        throw new RepositoryUrlError("validation", "Repository URL must use HTTPS");
    }

    if (parsed.username || parsed.password) {
        throw new RepositoryUrlError("validation", "Repository URL must not include credentials");
    }

    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED_REPOSITORY_HOSTS.has(host)) {
        throw new RepositoryUrlError("validation", "Repository URL host is not supported");
    }

    const segments = parsed.pathname
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean);
    if (segments.length < 2) {
        throw new RepositoryUrlError("validation", "Repository URL must include an owner and repository name");
    }

    if ((host === "github.com" || host === "bitbucket.org") && segments.length !== 2) {
        throw new RepositoryUrlError("validation", "Repository URL must point to a repository root");
    }

    if (host === "gitlab.com" && segments.includes("-")) {
        throw new RepositoryUrlError("validation", "Repository URL must point to a repository root");
    }

    const repositoryName = segments[segments.length - 1]!.replace(/\.git$/u, "") || segments[segments.length - 1]!;
    parsed.hash = "";
    parsed.search = "";
    parsed.username = "";
    parsed.password = "";

    const normalizedPath = `/${segments.join("/").replace(/\.git$/u, "")}.git`;
    return {
        url: `https://${host}${normalizedPath}`,
        name: repositoryName,
    };
}

type GitHubRepositoryParts = {
    owner: string;
    repo: string;
};

export type GitHubExternalCodeFile = {
    provider: "github";
    rawUrl: string;
    htmlUrl: string;
    key: string;
};

function githubRepositoryParts(repositoryUrl: string): GitHubRepositoryParts | null {
    const parsed = new URL(repositoryUrl);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
        return null;
    }

    const segments = parsed.pathname
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean);
    if (segments.length !== 2) {
        return null;
    }

    return {
        owner: segments[0]!,
        repo: segments[1]!.replace(/\.git$/u, ""),
    };
}

function encodePathSegments(value: string): string {
    return value.split("/").map(encodeURIComponent).join("/");
}

export function buildGitHubExternalCodeFile(options: {
    repositoryUrl: string;
    commitSha: string;
    path: string;
}): GitHubExternalCodeFile | null {
    const parts = githubRepositoryParts(options.repositoryUrl);
    if (!parts) {
        return null;
    }

    const owner = encodeURIComponent(parts.owner);
    const repo = encodeURIComponent(parts.repo);
    const commitSha = encodeURIComponent(options.commitSha);
    const filePath = encodePathSegments(options.path);
    const keyPath = options.path.replaceAll("\\", "/");

    return {
        provider: "github",
        rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${filePath}`,
        htmlUrl: `https://github.com/${owner}/${repo}/blob/${commitSha}/${filePath}`,
        key: `external:github:${parts.owner}/${parts.repo}@${options.commitSha}:${keyPath}`,
    };
}

export async function loadRepositoryFromUrl(input: string): Promise<LoadedRepository> {
    const repository = normalizeRepositoryUrl(input);
    const tempDir = await mkdtemp(path.join(tmpdir(), "kiwi-repository-"));
    const repoPath = path.join(tempDir, "repo");

    try {
        await runGit(["clone", "--depth", "1", "--", repository.url, repoPath], tempDir);
        const commitSha = (await runGit(["rev-parse", "HEAD"], repoPath)).trim();
        const listedFiles = (await runGit(["ls-files", "-z"], repoPath)).split("\0").filter(Boolean);
        const files: RepositorySourceFile[] = [];
        const repoRoot = path.resolve(repoPath);
        let totalBytes = 0;

        for (const filePath of listedFiles) {
            if (!shouldLoadCodePath(filePath)) {
                continue;
            }

            const absolutePath = path.resolve(repoPath, filePath);
            if (!absolutePath.startsWith(`${repoRoot}${path.sep}`)) {
                continue;
            }

            const info = await stat(absolutePath);
            if (!info.isFile() || info.size > MAX_REPOSITORY_CODE_FILE_BYTES) {
                continue;
            }

            if (files.length + 1 > MAX_REPOSITORY_CODE_FILES) {
                throw new RepositoryUrlError("limit", "Repository contains too many supported code files");
            }

            if (totalBytes + info.size > MAX_REPOSITORY_CODE_BYTES) {
                throw new RepositoryUrlError("limit", "Repository contains too much supported code");
            }

            const content = await readFile(absolutePath, "utf8");
            files.push({ path: filePath, content, size: info.size });
            totalBytes += info.size;
        }

        return {
            url: repository.url,
            name: repository.name,
            commitSha,
            files,
        };
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

function shouldLoadCodePath(filePath: string): boolean {
    const normalized = filePath.replaceAll("\\", "/");
    if (!isSupportedCodePath(normalized)) {
        return false;
    }

    return normalized.split("/").every((segment) => !SKIPPED_PATH_SEGMENTS.has(segment));
}

function runGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("git", args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: "0",
            },
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutLimitExceeded = false;
        let settled = false;

        const finish = (callback: () => void) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);
            callback();
        };

        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            finish(() =>
                reject(
                    new RepositoryUrlError("load", "Repository could not be loaded", {
                        cause: new Error("Repository git command timed out"),
                    })
                )
            );
        }, GIT_COMMAND_TIMEOUT_MS);

        child.stdout.on("data", (chunk: Buffer) => {
            stdoutBytes += chunk.byteLength;
            if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) {
                stdoutLimitExceeded = true;
                child.kill("SIGKILL");
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderrBytes += chunk.byteLength;
            if (stderrBytes <= MAX_GIT_OUTPUT_BYTES) {
                stderr.push(chunk);
            }
        });
        child.on("error", (error) =>
            finish(() =>
                reject(
                    stdoutLimitExceeded
                        ? new RepositoryUrlError("limit", "Repository git output exceeded the supported size")
                        : new RepositoryUrlError("load", "Repository could not be loaded", { cause: error })
                )
            )
        );
        child.on("close", (code) => {
            if (stdoutLimitExceeded) {
                finish(() =>
                    reject(new RepositoryUrlError("limit", "Repository git output exceeded the supported size"))
                );
                return;
            }

            if (code === 0) {
                finish(() => resolve(Buffer.concat(stdout).toString("utf8")));
                return;
            }

            finish(() => {
                const stderrText = Buffer.concat(stderr).toString("utf8").trim();
                reject(
                    new RepositoryUrlError("load", "Repository could not be loaded", {
                        cause: new Error(stderrText || "Repository git command failed"),
                    })
                );
            });
        });
    });
}
