import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
    createGitHubAppJwt,
    createGitHubClient,
    createGitHubInstallationToken,
    getGitHubInstallationAccount,
    loadGitHubRepositorySnapshot,
} from "../github";
import type { ConnectorResource, FetchLike, ProviderRepository } from "../types";

const GITHUB_REPOSITORY: ProviderRepository = {
    provider: "github",
    id: "1",
    fullName: "acme/app",
    name: "app",
    htmlUrl: "https://github.com/acme/app",
    defaultBranch: "main",
    private: true,
};

const GITHUB_RESOURCE: ConnectorResource = {
    provider: "github",
    kind: "git-repository",
    id: "1",
    displayName: "acme/app",
    webUrl: "https://github.com/acme/app",
    private: true,
    defaultBranch: "main",
};

describe("GitHub connector", () => {
    test("creates app JWT and installation tokens", async () => {
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
        const jwt = createGitHubAppJwt({ appId: "42", privateKeyPem, now: new Date("2026-01-01T00:00:00Z") });
        expect(jwt.split(".")).toHaveLength(3);

        const calls: RequestInit[] = [];
        const fetchImpl: FetchLike = async (_input, init) => {
            calls.push(init ?? {});
            return jsonResponse({ token: "installation-token", expires_at: "2026-01-01T01:00:00Z" });
        };

        await expect(
            createGitHubInstallationToken({
                credentials: { provider: "github", appId: "42", privateKeyPem },
                installationId: "99",
                apiBaseUrl: "https://github.test",
                fetch: fetchImpl,
                now: new Date("2026-01-01T00:00:00Z"),
            })
        ).resolves.toEqual({ token: "installation-token", expiresAt: "2026-01-01T01:00:00Z" });
        expect(calls[0]?.method).toBe("POST");
        expect(String((calls[0]?.headers as Record<string, string>).authorization)).toMatch(/^Bearer /);
        expect(calls[0]?.body).toBe(JSON.stringify({ permissions: { contents: "read", metadata: "read" } }));
    });

    test("loads GitHub installation account metadata", async () => {
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
        const calls: string[] = [];
        const fetchImpl: FetchLike = async (input) => {
            calls.push(String(input));
            return jsonResponse({
                account: { login: "acme", type: "Organization" },
                repository_selection: "selected",
            });
        };

        await expect(
            getGitHubInstallationAccount({
                credentials: { provider: "github", appId: "42", privateKeyPem },
                installationId: "99",
                apiBaseUrl: "https://github.test",
                fetch: fetchImpl,
                now: new Date("2026-01-01T00:00:00Z"),
            })
        ).resolves.toEqual({
            login: "acme",
            type: "organization",
            repositorySelection: "selected",
        });
        expect(calls).toEqual(["https://github.test/app/installations/99"]);
    });

    test("lists repositories and resource versions with pagination", async () => {
        const urls: string[] = [];
        const fetchImpl: FetchLike = async (input) => {
            const url = String(input);
            urls.push(url);
            if (url.includes("/installation/repositories")) {
                return jsonResponse({
                    repositories: [
                        {
                            id: 1,
                            full_name: "acme/app",
                            name: "app",
                            html_url: "https://github.com/acme/app",
                            default_branch: "main",
                            private: true,
                        },
                    ],
                });
            }
            if (url.endsWith("/repositories/1")) {
                return jsonResponse({
                    id: 1,
                    full_name: "acme/app",
                    name: "app",
                    html_url: "https://github.com/acme/app",
                    default_branch: "main",
                    private: true,
                });
            }
            return jsonResponse([{ name: "main", commit: { sha: "commit-sha" } }]);
        };
        const client = createGitHubClient({
            installationToken: "token",
            apiBaseUrl: "https://github.test",
            fetch: fetchImpl,
        });

        await expect(client.listRepositories()).resolves.toEqual([GITHUB_REPOSITORY]);
        await expect(client.listResources()).resolves.toEqual([GITHUB_RESOURCE]);
        await expect(client.listResourceVersions("1")).resolves.toEqual([
            { resourceId: "1", name: "main", versionId: "commit-sha" },
        ]);
        expect(urls).toContain("https://github.test/installation/repositories?per_page=100&page=1");
        expect(urls).toContain("https://github.test/repositories/1");
        expect(urls).toContain("https://github.test/repos/acme/app/branches?per_page=100&page=1");
    });

    test("loads supported repository snapshots through tree and blob APIs", async () => {
        const calls: string[] = [];
        const fetchImpl: FetchLike = async (input) => {
            const url = String(input);
            calls.push(url);
            if (url.endsWith("/branches/main")) {
                return jsonResponse({ commit: { sha: "commit-sha", commit: { tree: { sha: "tree-sha" } } } });
            }
            if (url.includes("/git/trees/tree-sha")) {
                return jsonResponse({
                    tree: [
                        { type: "blob", path: "src/index.ts", sha: "blob-sha", size: 18 },
                        { type: "blob", path: "dist/generated.ts", sha: "skip-sha", size: 10 },
                        { type: "blob", path: "README.md", sha: "readme-sha", size: 10 },
                    ],
                });
            }
            if (url.includes("/git/blobs/blob-sha")) {
                return jsonResponse({
                    encoding: "base64",
                    content: Buffer.from("export const ok = 1;", "utf8").toString("base64"),
                });
            }
            throw new Error(`unexpected URL ${url}`);
        };

        await expect(
            loadGitHubRepositorySnapshot({
                installationToken: "token",
                apiBaseUrl: "https://github.test",
                fetch: fetchImpl,
                repository: GITHUB_REPOSITORY,
                branch: "main",
            })
        ).resolves.toEqual({
            repository: GITHUB_REPOSITORY,
            branch: { name: "main", commitSha: "commit-sha" },
            commitSha: "commit-sha",
            files: [
                {
                    path: "src/index.ts",
                    size: 20,
                    checksum: "blob-sha",
                    htmlUrl: "https://github.com/acme/app/blob/commit-sha/src/index.ts",
                    rawUrl: "https://raw.githubusercontent.com/acme/app/commit-sha/src/index.ts",
                    content: "export const ok = 1;",
                },
            ],
        });
        expect(calls.some((url) => url.includes("skip-sha"))).toBe(false);
        expect(calls.some((url) => url.includes("readme-sha"))).toBe(false);
    });

    test("rejects truncated GitHub repository trees", async () => {
        const fetchImpl: FetchLike = async (input) => {
            const url = String(input);
            if (url.endsWith("/branches/main")) {
                return jsonResponse({ commit: { sha: "commit-sha", commit: { tree: { sha: "tree-sha" } } } });
            }
            if (url.includes("/git/trees/tree-sha")) {
                return jsonResponse({ truncated: true, tree: [] });
            }
            throw new Error(`unexpected URL ${url}`);
        };

        await expect(
            loadGitHubRepositorySnapshot({
                installationToken: "token",
                apiBaseUrl: "https://github.test",
                fetch: fetchImpl,
                repository: GITHUB_REPOSITORY,
                branch: "main",
            })
        ).rejects.toMatchObject({
            name: "ConnectorProviderError",
            kind: "limit",
        });
    });

    test("normalizes incremental compare changes for supported code paths", async () => {
        const client = createGitHubClient({
            installationToken: "token",
            apiBaseUrl: "https://github.test",
            fetch: async (input) => {
                const url = String(input);
                if (url.endsWith("/repositories/1")) {
                    return jsonResponse({
                        id: 1,
                        full_name: "acme/app",
                        name: "app",
                        html_url: "https://github.com/acme/app",
                        default_branch: "main",
                        private: true,
                    });
                }

                expect(url).toBe("https://github.test/repos/acme/app/compare/commit-old...commit-new");
                return jsonResponse({
                    status: "ahead",
                    files: [
                        { filename: "src/modified.ts", status: "modified" },
                        { filename: "src/added.ts", status: "added" },
                        { filename: "src/deleted.ts", status: "removed" },
                        { filename: "src/renamed.ts", status: "renamed", previous_filename: "src/old-name.ts" },
                        { filename: "README.md", status: "renamed", previous_filename: "src/renamed-away.ts" },
                        { filename: "README.md", status: "modified" },
                    ],
                });
            },
        });

        await expect(client.compareVersions("1", "commit-old", "commit-new")).resolves.toEqual({
            fromVersionId: "commit-old",
            toVersionId: "commit-new",
            isIncremental: true,
            changes: [
                { status: "modified", newPath: "src/modified.ts" },
                { status: "added", newPath: "src/added.ts" },
                { status: "deleted", oldPath: "src/deleted.ts" },
                { status: "renamed", oldPath: "src/old-name.ts", newPath: "src/renamed.ts" },
                { status: "deleted", oldPath: "src/renamed-away.ts" },
            ],
        });
    });

    test("marks non-forward GitHub compares as requiring a snapshot sync", async () => {
        const client = createGitHubClient({
            installationToken: "token",
            apiBaseUrl: "https://github.test",
            fetch: async () => jsonResponse({ status: "diverged" }),
        });

        await expect(client.compareRepository(GITHUB_REPOSITORY, "commit-old", "commit-new")).resolves.toEqual({
            fromCommitSha: "commit-old",
            toCommitSha: "commit-new",
            isIncremental: false,
            changes: [],
        });
    });

    test("verifies webhooks and normalizes push events through the adapter", () => {
        const client = createGitHubClient({ installationToken: "token" });
        const body = JSON.stringify({ ref: "refs/heads/main" });
        const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;

        expect(
            client.verifyWebhook?.({
                body,
                headers: { "x-hub-signature-256": signature },
                webhookSecret: "secret",
            })
        ).toBe(true);
        expect(
            client.verifyWebhook?.({
                body,
                headers: { "x-hub-signature-256": "sha256=bad" },
                webhookSecret: "secret",
            })
        ).toBe(false);
        expect(
            client.normalizeWebhook?.({
                eventName: "push",
                deliveryId: "delivery",
                payload: {
                    ref: "refs/heads/main",
                    after: "commit-sha",
                    repository: { id: 1, full_name: "acme/app" },
                    installation: { id: 99 },
                },
            })
        ).toMatchObject({
            provider: "github",
            deliveryId: "delivery",
            eventName: "push",
            repositoryId: "1",
            repositoryFullName: "acme/app",
            branch: "main",
            commitSha: "commit-sha",
            installationId: "99",
        });
    });
});

function jsonResponse(value: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
    });
}
