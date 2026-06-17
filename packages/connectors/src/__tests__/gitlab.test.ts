import * as Effect from "effect/Effect";
import { describe, expect, test } from "bun:test";
import { createGitLabClient, loadGitLabRepositorySnapshot, normalizeGitLabBaseUrl } from "../gitlab";
import type { ConnectorResource, FetchLike, ProviderRepository } from "../types";

const GITLAB_REPOSITORY: ProviderRepository = {
    provider: "gitlab",
    id: "7",
    fullName: "acme/app",
    name: "app",
    htmlUrl: "https://gitlab.test/acme/app",
    defaultBranch: "main",
    private: true,
};

const GITLAB_RESOURCE: ConnectorResource = {
    provider: "gitlab",
    kind: "git-repository",
    id: "7",
    displayName: "acme/app",
    webUrl: "https://gitlab.test/acme/app",
    private: true,
    defaultBranch: "main",
};

describe("GitLab connector", () => {
    test("normalizes base URLs", () => {
        expect(normalizeGitLabBaseUrl("https://gitlab.example.com///")).toBe("https://gitlab.example.com");
        expect(normalizeGitLabBaseUrl("https://gitlab.example.com/root/")).toBe("https://gitlab.example.com/root");
        expect(() => normalizeGitLabBaseUrl("ftp://gitlab.example.com")).toThrow(
            "GitLab base URL must use HTTP or HTTPS"
        );
    });

    test("lists projects and resource versions", async () => {
        const urls: string[] = [];
        const fetchImpl: FetchLike = async (input) => {
            const url = String(input);
            urls.push(url);
            if (url.includes("/projects?")) {
                return jsonResponse([
                    {
                        id: 7,
                        path_with_namespace: "acme/app",
                        name: "app",
                        web_url: "https://gitlab.test/acme/app",
                        default_branch: "main",
                        visibility: "private",
                    },
                ]);
            }
            if (url.endsWith("/projects/7")) {
                return jsonResponse({
                    id: 7,
                    path_with_namespace: "acme/app",
                    name: "app",
                    web_url: "https://gitlab.test/acme/app",
                    default_branch: "main",
                    visibility: "private",
                });
            }
            return jsonResponse([{ name: "main", commit: { id: "commit-sha" } }]);
        };
        const client = createGitLabClient({ baseUrl: "https://gitlab.test", accessToken: "token", fetch: fetchImpl });

        await expect(Effect.runPromise(client.listRepositories())).resolves.toEqual([GITLAB_REPOSITORY]);
        await expect(Effect.runPromise(client.listResources())).resolves.toEqual([GITLAB_RESOURCE]);
        await expect(Effect.runPromise(client.listResourceVersions("7"))).resolves.toEqual([
            { resourceId: "7", name: "main", versionId: "commit-sha" },
        ]);
        expect(urls).toContain("https://gitlab.test/api/v4/projects?membership=true&per_page=100&page=1");
        expect(urls).toContain("https://gitlab.test/api/v4/projects/7");
        expect(urls).toContain("https://gitlab.test/api/v4/projects/7/repository/branches?per_page=100&page=1");
    });

    test("throws typed provider errors for non-json GitLab error responses", async () => {
        const client = createGitLabClient({
            baseUrl: "https://gitlab.test",
            accessToken: "token",
            fetch: async () => new Response("upstream unavailable", { status: 500 }),
        });

        await expect(Effect.runPromise(client.listBranches(GITLAB_REPOSITORY))).rejects.toMatchObject({
            name: "ConnectorProviderError",
            kind: "provider",
        });
    });

    test("loads supported repository snapshots through tree and file APIs", async () => {
        const calls: string[] = [];
        const fetchImpl: FetchLike = async (input) => {
            const url = String(input);
            calls.push(url);
            if (url.endsWith("/repository/branches/main")) {
                return jsonResponse({ commit: { id: "commit-sha" } });
            }
            if (url.includes("/repository/tree?")) {
                return jsonResponse([
                    { type: "blob", id: "file-sha", path: "src/index.ts" },
                    { type: "blob", id: "generated-sha", path: "node_modules/pkg/index.ts" },
                    { type: "blob", id: "readme-sha", path: "README.md" },
                ]);
            }
            if (url.includes("/repository/files/src%2Findex.ts/raw?")) {
                return new Response("export const ok = 1;", { status: 200, headers: { "content-length": "20" } });
            }
            throw new Error(`unexpected URL ${url}`);
        };

        await expect(
            Effect.runPromise(
                loadGitLabRepositorySnapshot({
                    baseUrl: "https://gitlab.test",
                    accessToken: "token",
                    fetch: fetchImpl,
                    repository: GITLAB_REPOSITORY,
                    branch: "main",
                })
            )
        ).resolves.toEqual({
            repository: GITLAB_REPOSITORY,
            branch: { name: "main", commitSha: "commit-sha" },
            commitSha: "commit-sha",
            files: [
                {
                    path: "src/index.ts",
                    size: 20,
                    checksum: "file-sha",
                    htmlUrl: "https://gitlab.test/acme/app/-/blob/commit-sha/src/index.ts",
                    rawUrl: "https://gitlab.test/api/v4/projects/7/repository/files/src%2Findex.ts/raw?ref=commit-sha",
                    content: "export const ok = 1;",
                },
            ],
        });
        expect(calls.some((url) => url.includes("generated-sha"))).toBe(false);
        expect(calls.some((url) => url.includes("readme-sha"))).toBe(false);
    });

    test("normalizes incremental compare changes for supported code paths", async () => {
        const client = createGitLabClient({
            baseUrl: "https://gitlab.test",
            accessToken: "token",
            fetch: async (input) => {
                const url = String(input);
                if (url.endsWith("/projects/7")) {
                    return jsonResponse({
                        id: 7,
                        path_with_namespace: "acme/app",
                        name: "app",
                        web_url: "https://gitlab.test/acme/app",
                        default_branch: "main",
                        visibility: "private",
                    });
                }

                expect(url).toBe(
                    "https://gitlab.test/api/v4/projects/7/repository/compare?from=commit-old&to=commit-new&straight=true"
                );
                return jsonResponse({
                    compare_timeout: false,
                    diffs: [
                        {
                            old_path: "src/modified.ts",
                            new_path: "src/modified.ts",
                            new_file: false,
                            renamed_file: false,
                            deleted_file: false,
                        },
                        {
                            old_path: "src/added.ts",
                            new_path: "src/added.ts",
                            new_file: true,
                            renamed_file: false,
                            deleted_file: false,
                        },
                        {
                            old_path: "src/deleted.ts",
                            new_path: "src/deleted.ts",
                            new_file: false,
                            renamed_file: false,
                            deleted_file: true,
                        },
                        {
                            old_path: "src/old-name.ts",
                            new_path: "src/renamed.ts",
                            new_file: false,
                            renamed_file: true,
                            deleted_file: false,
                        },
                        {
                            old_path: "src/renamed-away.ts",
                            new_path: "README.md",
                            new_file: false,
                            renamed_file: true,
                            deleted_file: false,
                        },
                        {
                            old_path: "README.md",
                            new_path: "README.md",
                            new_file: false,
                            renamed_file: false,
                            deleted_file: false,
                        },
                    ],
                });
            },
        });

        await expect(Effect.runPromise(client.compareVersions("7", "commit-old", "commit-new"))).resolves.toEqual({
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

    test("falls back to full snapshot when GitLab compare times out", async () => {
        const client = createGitLabClient({
            baseUrl: "https://gitlab.test",
            accessToken: "token",
            fetch: async () => jsonResponse({ compare_timeout: true, diffs: [] }),
        });

        await expect(Effect.runPromise(client.compareRepository(GITLAB_REPOSITORY, "commit-old", "commit-new"))).resolves.toEqual({
            fromCommitSha: "commit-old",
            toCommitSha: "commit-new",
            isIncremental: false,
            changes: [],
        });
    });

    test("rejects malformed GitLab compare responses", async () => {
        const client = createGitLabClient({
            baseUrl: "https://gitlab.test",
            accessToken: "token",
            fetch: async () =>
                jsonResponse({
                    compare_timeout: false,
                    diffs: [{ old_path: "src/index.ts", new_path: "src/index.ts" }],
                }),
        });

        await expect(
            Effect.runPromise(client.compareRepository(GITLAB_REPOSITORY, "commit-old", "commit-new"))
        ).rejects.toThrow("GitLab compare response is invalid");
    });

    test("verifies webhook tokens and normalizes push events through the adapter", () => {
        const client = createGitLabClient({ baseUrl: "https://gitlab.test", accessToken: "token" });

        expect(
            client.verifyWebhook?.({
                headers: { "x-gitlab-token": "secret" },
                body: "",
                webhookSecret: "secret",
            })
        ).toBe(true);
        expect(
            client.verifyWebhook?.({
                headers: { "x-gitlab-token": "wrong" },
                body: "",
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
                    project: { id: 7, path_with_namespace: "acme/app" },
                },
            })
        ).toMatchObject({
            provider: "gitlab",
            deliveryId: "delivery",
            eventName: "push",
            repositoryId: "7",
            repositoryFullName: "acme/app",
            branch: "main",
            commitSha: "commit-sha",
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
