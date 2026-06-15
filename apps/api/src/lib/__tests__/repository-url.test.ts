import { describe, expect, test } from "bun:test";
import { isSupportedCodePath } from "@kiwi/graph/code/file-path";
import { buildGitHubExternalCodeFile, normalizeRepositoryUrl } from "../repository-url";

describe("repository URL helpers", () => {
    test("normalizes supported repository roots", () => {
        expect(normalizeRepositoryUrl(" https://github.com/owner/repo ")).toEqual({
            url: "https://github.com/owner/repo.git",
            name: "repo",
        });
        expect(normalizeRepositoryUrl("https://gitlab.com/group/subgroup/repo.git?tab=readme#main")).toEqual({
            url: "https://gitlab.com/group/subgroup/repo.git",
            name: "repo",
        });
        expect(normalizeRepositoryUrl("https://bitbucket.org/team/repo.git")).toEqual({
            url: "https://bitbucket.org/team/repo.git",
            name: "repo",
        });
    });

    test("rejects unsafe or non-root repository URLs", () => {
        expect(() => normalizeRepositoryUrl("http://github.com/owner/repo")).toThrow("HTTPS");
        expect(() => normalizeRepositoryUrl("https://token@github.com/owner/repo")).toThrow("credentials");
        expect(() => normalizeRepositoryUrl("https://example.com/owner/repo")).toThrow("host is not supported");
        expect(() => normalizeRepositoryUrl("https://github.com/owner/repo/tree/main")).toThrow("repository root");
        expect(() => normalizeRepositoryUrl("https://github.com/owner")).toThrow("owner and repository");
        expect(() => normalizeRepositoryUrl("https://gitlab.com/group/repo/-/tree/main")).toThrow("repository root");
    });

    test("recognizes supported code file paths without matching generated directories", () => {
        expect(isSupportedCodePath("src/index.ts")).toBe(true);
        expect(isSupportedCodePath("src/component.tsx")).toBe(true);
        expect(isSupportedCodePath("src/script.js")).toBe(true);
        expect(isSupportedCodePath("src/README.md")).toBe(false);
    });

    test("builds immutable GitHub external code links", () => {
        expect(
            buildGitHubExternalCodeFile({
                repositoryUrl: "https://github.com/owner/repo.git",
                commitSha: "abc123",
                path: "src/nested/my file.ts",
            })
        ).toEqual({
            provider: "github",
            rawUrl: "https://raw.githubusercontent.com/owner/repo/abc123/src/nested/my%20file.ts",
            htmlUrl: "https://github.com/owner/repo/blob/abc123/src/nested/my%20file.ts",
            key: "external:github:owner/repo@abc123:src/nested/my file.ts",
        });
        expect(
            buildGitHubExternalCodeFile({
                repositoryUrl: "https://gitlab.com/group/repo.git",
                commitSha: "abc123",
                path: "src/index.ts",
            })
        ).toBeNull();
    });
});
