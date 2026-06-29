import { createHmac, generateKeyPairSync } from "node:crypto";
import * as Effect from "effect/Effect";
import { describe, expect, test } from "bun:test";
import {
    connectorAdapterRegistry,
    createConnectorAdapter,
    getConnectorAdapterRegistryEntry,
    normalizeConnectorWebhook,
    registerConnectorAdapter,
    verifyConnectorWebhook,
} from "../registry";
import type { ConnectorResource, FetchLike } from "../types";
import { IN_MEMORY_RESOURCE_PROVIDER, inMemoryResourceConnectorRegistryEntry } from "../in-memory-resource";
import { NEXTCLOUD_PROVIDER } from "../nextcloud";

const GITHUB_RESOURCE: ConnectorResource = {
    provider: "github",
    kind: "git-repository",
    id: "1",
    displayName: "acme/app",
    webUrl: "https://github.com/acme/app",
    private: true,
    defaultBranch: "main",
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

describe("connector adapter registry", () => {
    test("creates a GitHub adapter from generic credentials", async () => {
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
        const urls: string[] = [];
        const fetchImpl: FetchLike = async (input) => {
            const url = String(input);
            urls.push(url);
            if (url.endsWith("/app/installations/99/access_tokens")) {
                return jsonResponse({ token: "installation-token", expires_at: "2026-01-01T01:00:00Z" });
            }
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
        };

        const adapter = await Effect.runPromise(
            createConnectorAdapter({
                provider: "github",
                credentials: { provider: "github", appId: "42", privateKeyPem, webhookSecret: "secret" },
                installation: { provider: "github", installationId: "99" },
                apiBaseUrl: "https://github.test",
                fetch: fetchImpl,
            })
        );

        await expect(Effect.runPromise(adapter.listResources())).resolves.toEqual([GITHUB_RESOURCE]);
        expect(getConnectorAdapterRegistryEntry("github").resourceKind).toBe("git-repository");
        expect(urls).toContain("https://github.test/app/installations/99/access_tokens");
        expect(urls).toContain("https://github.test/installation/repositories?per_page=100&page=1");
    });

    test("creates a GitLab adapter from generic credentials", async () => {
        const urls: string[] = [];
        const fetchImpl: FetchLike = async (input) => {
            urls.push(String(input));
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
        };

        const adapter = await Effect.runPromise(
            createConnectorAdapter({
                provider: "gitlab",
                credentials: {
                    provider: "gitlab",
                    baseUrl: "https://gitlab.test///",
                    clientId: "client-id",
                    clientSecret: "client-secret",
                    webhookSecret: "secret",
                },
                installation: { provider: "gitlab", accessToken: "token" },
                fetch: fetchImpl,
            })
        );

        await expect(Effect.runPromise(adapter.listResources())).resolves.toEqual([GITLAB_RESOURCE]);
        expect(getConnectorAdapterRegistryEntry("gitlab").resourceKind).toBe("git-repository");
        expect(urls).toEqual(["https://gitlab.test/api/v4/projects?membership=true&per_page=100&page=1"]);
    });

    test("routes webhook helpers through the registry", () => {
        const githubBody = JSON.stringify({ ref: "refs/heads/main" });
        const githubSignature = `sha256=${createHmac("sha256", "secret").update(githubBody).digest("hex")}`;

        expect(
            verifyConnectorWebhook("github", {
                body: githubBody,
                headers: { "X-Hub-Signature-256": githubSignature },
                webhookSecret: "secret",
            })
        ).toBe(true);
        expect(
            normalizeConnectorWebhook("github", {
                eventName: "push",
                deliveryId: "delivery",
                payload: {
                    ref: "refs/heads/main",
                    after: "commit-sha",
                    repository: { id: 1, full_name: "acme/app" },
                },
            })
        ).toMatchObject({
            provider: "github",
            resourceKind: "git-repository",
            resourceId: "1",
            resourceDisplayName: "acme/app",
            resourceName: "acme/app",
            versionName: "main",
            versionId: "commit-sha",
            repositoryId: "1",
            repositoryFullName: "acme/app",
            branch: "main",
            commitSha: "commit-sha",
        });

        expect(
            verifyConnectorWebhook("gitlab", {
                body: "",
                headers: new Headers({ "X-Gitlab-Token": "secret" }),
                webhookSecret: "secret",
            })
        ).toBe(true);
        expect(
            normalizeConnectorWebhook("gitlab", {
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
            resourceKind: "git-repository",
            resourceId: "7",
            resourceDisplayName: "acme/app",
            resourceName: "acme/app",
            versionName: "main",
            versionId: "commit-sha",
            repositoryId: "7",
            repositoryFullName: "acme/app",
            branch: "main",
            commitSha: "commit-sha",
        });
    });

    test("includes Nextcloud as a built-in folder source provider", () => {
        const descriptor = getConnectorAdapterRegistryEntry(NEXTCLOUD_PROVIDER);
        expect(descriptor).toMatchObject({
            provider: NEXTCLOUD_PROVIDER,
            family: "resource-source",
            resourceKind: "folder",
            capabilities: { versions: false, cursorSync: true, children: true, binaryFiles: true },
        });
        expect(descriptor.setup.map((setup) => setup.kind)).toEqual(["manualCredentials"]);
        expect(descriptor.install.map((install) => install.kind)).toEqual(["manualActivation"]);
        expect(
            descriptor.validateCredentials?.({
                provider: NEXTCLOUD_PROVIDER,
                subject: "app",
                version: "v1",
                data: { baseUrl: "https://cloud.example.com" },
            })
        ).toBe(true);
        expect(
            descriptor.validateInstallation?.({
                provider: NEXTCLOUD_PROVIDER,
                subject: "installation",
                version: "v1",
                data: { username: "alice", appPassword: "app-password", folderPath: "/Team" },
            })
        ).toBe(true);
    });

    test("supports the in-memory non-git provider descriptor with cursor children and binary capabilities", async () => {
        const provider = IN_MEMORY_RESOURCE_PROVIDER;
        const previous = connectorAdapterRegistry[provider];
        registerConnectorAdapter(inMemoryResourceConnectorRegistryEntry);

        try {
            const descriptor = getConnectorAdapterRegistryEntry(provider);
            expect(descriptor).toMatchObject({
                provider,
                family: "resource-source",
                resourceKind: "folder",
                capabilities: { versions: false, cursorSync: true, children: true, binaryFiles: true },
            });
            expect(descriptor.setup.map((setup) => setup.kind)).toEqual(["none"]);
            expect(descriptor.install.map((install) => install.kind)).toEqual(["manualActivation"]);
            expect(
                descriptor.validateCredentials?.({
                    provider,
                    subject: "app",
                    version: "v1",
                    data: { fixture: "test" },
                })
            ).toBe(true);
            expect(
                descriptor.validateInstallation?.({
                    provider,
                    subject: "installation",
                    version: "v1",
                    data: { accountId: "fixture-account" },
                })
            ).toBe(true);

            const adapter = await Effect.runPromise(
                createConnectorAdapter({
                    provider,
                    credentials: { provider, subject: "app", version: "v1", data: { fixture: "test" } },
                    installation: {
                        provider,
                        subject: "installation",
                        version: "v1",
                        data: { accountId: "fixture-account" },
                    },
                })
            );

            expect(adapter).toMatchObject({
                provider,
                resourceKind: "folder",
                capabilities: { versions: false, cursorSync: true, children: true, binaryFiles: true },
            });
            await expect(Effect.runPromise(adapter.listChildren?.() ?? Effect.succeed([]))).resolves.toEqual([
                expect.objectContaining({ id: "folder:docs", kind: "folder", parentId: null }),
            ]);
            const changeSet = await Effect.runPromise(adapter.listChanges?.("drive:fixture") ?? Effect.succeed(null));
            expect(changeSet).toMatchObject({ cursor: "cursor:fixture:1" });
            expect(changeSet?.changes).toEqual(
                expect.arrayContaining([expect.objectContaining({ providerItemId: "file:docs/readme.txt" })])
            );
            await expect(
                Effect.runPromise(
                    adapter.openFile?.({ resourceId: "drive:fixture", path: "docs/manual.pdf", etag: "etag-pdf" }) ??
                        Effect.succeed(null)
                )
            ).resolves.toMatchObject({ size: 4, contentType: "application/pdf" });
        } finally {
            if (previous) {
                connectorAdapterRegistry[provider] = previous;
            } else {
                delete connectorAdapterRegistry[provider];
            }
        }
    });

    test("rejects provider mismatches", async () => {
        await expect(
            Effect.runPromise(
                createConnectorAdapter({
                    provider: "github",
                    credentials: {
                        provider: "gitlab",
                        baseUrl: "https://gitlab.test",
                        clientId: "client-id",
                        clientSecret: "client-secret",
                    },
                    installation: { provider: "gitlab", accessToken: "token" },
                })
            )
        ).rejects.toMatchObject({
            name: "ConnectorProviderError",
            kind: "validation",
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
