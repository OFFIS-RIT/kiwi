import { beforeEach, describe, expect, mock, test } from "bun:test";

type TestRepository = {
    provider: "github";
    id: string;
    fullName: string;
    name: string;
    htmlUrl: string;
    defaultBranch: string;
    private: boolean;
};

const branchRepositoryCalls: TestRepository[] = [];
let listRepositoriesCalls = 0;

mock.module("@kiwi/connectors", () => ({
    createGitHubClient: () => ({
        provider: "github",
        getRepository: async (repositoryId: string) => ({
            provider: "github",
            id: "1",
            fullName: repositoryId,
            name: "app",
            htmlUrl: `https://github.com/${repositoryId}`,
            defaultBranch: "main",
            private: true,
        }),
        listRepositories: async () => {
            listRepositoriesCalls += 1;
            return [];
        },
        listBranches: async (repository: TestRepository) => {
            branchRepositoryCalls.push(repository);
            return [{ name: "main", commitSha: "commit-sha" }];
        },
    }),
    createGitHubInstallationToken: async () => ({ token: "installation-token", expiresAt: "2026-01-01T01:00:00Z" }),
    createGitLabClient: () => {
        throw new Error("GitLab client was not expected");
    },
    getGitHubInstallationAccount: async () => ({
        login: "acme",
        type: "organization",
        repositorySelection: "selected",
    }),
}));

mock.module("@kiwi/connectors/credentials", () => ({
    decryptConnectorCredentials: () => ({ provider: "github", appId: "app-1", privateKeyPem: "pem" }),
    decryptConnectorSecret: () => "secret",
    encryptConnectorCredentials: () => "encrypted",
    encryptConnectorSecret: () => "encrypted-secret",
}));

mock.module("../env", () => ({
    env: {
        AUTH_SECRET: "test-secret",
        API_URL: "http://localhost:4321",
        TRUSTED_ORIGINS: "http://localhost:3000",
    },
}));

const { listProviderBranches } = await import("../connectors");

describe("connector library helpers", () => {
    beforeEach(() => {
        branchRepositoryCalls.length = 0;
        listRepositoriesCalls = 0;
    });

    test("loads branches through direct repository lookup", async () => {
        await expect(
            listProviderBranches(
                {
                    id: "connector-1",
                    provider: "github",
                    encryptedCredentials: "encrypted",
                } as never,
                {
                    id: "installation-1",
                    providerInstallationId: "99",
                } as never,
                "acme/app"
            )
        ).resolves.toEqual([{ name: "main", commitSha: "commit-sha" }]);

        expect(listRepositoriesCalls).toBe(0);
        expect(branchRepositoryCalls[0]).toMatchObject({ fullName: "acme/app" });
    });
});
