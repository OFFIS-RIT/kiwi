import { describe, expect, test } from "bun:test";
import { parseCodeFileMetadata, serializeCodeFileMetadata, type CodeFileMetadata } from "../metadata";

describe("code file metadata", () => {
    test("round-trips schema v2 connector metadata", () => {
        const metadata: CodeFileMetadata = {
            schemaVersion: 2,
            provider: "github",
            bindingId: "binding-1",
            resourceKind: "git-repository",
            providerResourceId: "repo-1",
            resourceDisplayName: "acme/widgets",
            path: "src/index.ts",
            displayName: "index.ts",
            versionId: "commit-1",
            providerFileId: "file-1",
            etag: "etag-1",
            webUrl: "https://github.com/acme/widgets/blob/commit-1/src/index.ts",
            rawUrl: "https://raw.githubusercontent.com/acme/widgets/commit-1/src/index.ts",
            git: {
                repositoryName: "acme/widgets",
                commitSha: "commit-1",
                branch: "main",
            },
        };

        expect(parseCodeFileMetadata(serializeCodeFileMetadata(metadata))).toEqual(metadata);
    });

    test("converts v1 repository metadata to schema v2", () => {
        expect(
            parseCodeFileMetadata(
                JSON.stringify({
                    repositoryUrl: "https://github.com/acme/widgets.git",
                    repositoryName: "widgets",
                    commitSha: "commit-1",
                    path: "src/index.ts",
                    external: {
                        provider: "github",
                        rawUrl: "https://raw.githubusercontent.com/acme/widgets/commit-1/src/index.ts",
                        htmlUrl: "https://github.com/acme/widgets/blob/commit-1/src/index.ts",
                    },
                })
            )
        ).toEqual({
            schemaVersion: 2,
            provider: "github",
            bindingId: "",
            resourceKind: "git-repository",
            providerResourceId: "",
            resourceDisplayName: "widgets",
            path: "src/index.ts",
            displayName: "index.ts",
            versionId: "commit-1",
            webUrl: "https://github.com/acme/widgets/blob/commit-1/src/index.ts",
            rawUrl: "https://raw.githubusercontent.com/acme/widgets/commit-1/src/index.ts",
            git: {
                repositoryName: "widgets",
                repositoryUrl: "https://github.com/acme/widgets.git",
                commitSha: "commit-1",
            },
        });
    });

    test("rejects GitHub raw URLs outside the allowlist", () => {
        expect(
            parseCodeFileMetadata(
                JSON.stringify({
                    schemaVersion: 2,
                    provider: "github",
                    bindingId: "binding-1",
                    resourceKind: "git-repository",
                    providerResourceId: "repo-1",
                    resourceDisplayName: "acme/widgets",
                    path: "src/index.ts",
                    displayName: "index.ts",
                    versionId: "commit-1",
                    rawUrl: "https://example.com/acme/widgets/commit-1/src/index.ts",
                })
            )
        ).toBeNull();
    });

    test("rejects v1 GitHub external URLs outside the allowlist", () => {
        expect(
            parseCodeFileMetadata(
                JSON.stringify({
                    repositoryUrl: "https://github.com/acme/widgets.git",
                    repositoryName: "widgets",
                    commitSha: "commit-1",
                    path: "src/index.ts",
                    external: {
                        provider: "github",
                        rawUrl: "https://example.com/acme/widgets/commit-1/src/index.ts",
                        htmlUrl: "https://github.com/acme/widgets/blob/commit-1/src/index.ts",
                    },
                })
            )
        ).toBeNull();
    });
});
