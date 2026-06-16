import { describe, expect, test } from "bun:test";
import { GitLabConnectorCreateInputSchema, RepositoryGraphCreateInputSchema } from "../connectors";
import { GraphCreateFieldsSchema } from "../graphs";
import { MIN_MODEL_CONTEXT_WINDOW_TOKENS, ModelCreateInputSchema, ModelPatchInputSchema } from "../models";
import { MAX_PROMPT_LENGTH, NormalizedPromptBodySchema, PromptBodySchema } from "../prompts";
import { decodeApiSchemaSync } from "../schema";
import { TeamUpdateUsersInputSchema } from "../teams";

const decodeModelCreateInput = decodeApiSchemaSync(ModelCreateInputSchema);
const decodeModelPatchInput = decodeApiSchemaSync(ModelPatchInputSchema);
const decodeGitLabConnectorCreateInput = decodeApiSchemaSync(GitLabConnectorCreateInputSchema);
const decodeRepositoryGraphCreateInput = decodeApiSchemaSync(RepositoryGraphCreateInputSchema);
const decodeTeamUpdateUsersInput = decodeApiSchemaSync(TeamUpdateUsersInputSchema);
const decodePromptBody = decodeApiSchemaSync(PromptBodySchema);
const decodeNormalizedPromptBody = decodeApiSchemaSync(NormalizedPromptBodySchema);
const decodeGraphCreateFields = decodeApiSchemaSync(GraphCreateFieldsSchema);

describe("shared contract schema parity", () => {
    test("model create accepts valid payloads and rejects invalid identifiers or context windows", () => {
        expect(
            decodeModelCreateInput({
                model_id: " model-openai ",
                display_name: " GPT 4o ",
                type: "text",
                adapter: "openai",
                provider_model: " gpt-4o ",
                context_window: MIN_MODEL_CONTEXT_WINDOW_TOKENS,
                credentials: {
                    apiKey: " secret ",
                    url: " https://api.openai.com/v1 ",
                    resourceName: " resource-name ",
                },
                is_default: true,
            })
        ).toEqual({
            model_id: "model-openai",
            display_name: "GPT 4o",
            type: "text",
            adapter: "openai",
            provider_model: "gpt-4o",
            context_window: MIN_MODEL_CONTEXT_WINDOW_TOKENS,
            credentials: {
                apiKey: "secret",
                url: "https://api.openai.com/v1",
                resourceName: "resource-name",
            },
            is_default: true,
        });

        expect(() =>
            decodeModelCreateInput({
                model_id: "   ",
                display_name: "GPT 4o",
                type: "text",
                adapter: "openai",
                provider_model: "gpt-4o",
                credentials: {
                    apiKey: "secret",
                },
            })
        ).toThrow();

        expect(() =>
            decodeModelCreateInput({
                model_id: "model-openai",
                display_name: "GPT 4o",
                type: "text",
                adapter: "openai",
                provider_model: "gpt-4o",
                context_window: MIN_MODEL_CONTEXT_WINDOW_TOKENS - 1,
                credentials: {
                    apiKey: "secret",
                },
            })
        ).toThrow();
    });

    test("model patch preserves optional credential fields and empty URL or resource clearing", () => {
        expect(
            decodeModelPatchInput({
                credentials: {
                    apiKey: " refreshed-secret ",
                    url: "   ",
                    resourceName: "\t",
                },
            })
        ).toEqual({
            credentials: {
                apiKey: "refreshed-secret",
                url: "",
                resourceName: "",
            },
        });

        expect(
            decodeModelPatchInput({
                credentials: {},
            })
        ).toEqual({
            credentials: {},
        });
    });

    test("connector create accepts current GitLab and repository graph payloads", () => {
        expect(
            decodeGitLabConnectorCreateInput({
                name: " GitLab Workspace ",
                slug: " gitlab-workspace ",
                baseUrl: " https://gitlab.example.com/root ",
                clientId: " client-id ",
                clientSecret: " client-secret ",
                webhookSecret: " webhook-secret ",
            })
        ).toEqual({
            name: "GitLab Workspace",
            slug: "gitlab-workspace",
            baseUrl: "https://gitlab.example.com/root",
            clientId: "client-id",
            clientSecret: "client-secret",
            webhookSecret: "webhook-secret",
        });

        expect(
            decodeRepositoryGraphCreateInput({
                connectorInstallationId: " installation-1 ",
                repositoryId: " 42 ",
                repositoryFullName: " acme/kiwi ",
                repositoryHtmlUrl: " https://github.com/acme/kiwi ",
                branch: " main ",
                name: " Kiwi Repo ",
                owner: {
                    kind: "team",
                    teamId: " team-1 ",
                },
            })
        ).toEqual({
            connectorInstallationId: "installation-1",
            repositoryId: "42",
            repositoryFullName: "acme/kiwi",
            repositoryHtmlUrl: "https://github.com/acme/kiwi",
            branch: "main",
            name: "Kiwi Repo",
            owner: {
                kind: "team",
                teamId: "team-1",
            },
        });

        expect(() =>
            decodeGitLabConnectorCreateInput({
                name: "GitLab Workspace",
                slug: "gitlab-workspace",
                baseUrl: "notaurl",
                clientId: "client-id",
                clientSecret: "client-secret",
                webhookSecret: "webhook-secret",
            })
        ).toThrow();

        expect(() =>
            decodeRepositoryGraphCreateInput({
                connectorInstallationId: "installation-1",
                repositoryId: "42",
                repositoryFullName: "acme/kiwi",
                repositoryHtmlUrl: "https://github.com/acme/kiwi",
                branch: "main",
                name: "   ",
                owner: {
                    kind: "organization",
                },
            })
        ).toThrow();
    });

    test("team update rejects invalid roles", () => {
        expect(() =>
            decodeTeamUpdateUsersInput({
                users: [
                    {
                        user_id: "user-1",
                        role: "owner",
                    },
                ],
            })
        ).toThrow();
    });

    test("prompt body transport stays permissive while normalized prompt validation rejects blank and over-limit prompts", () => {
        expect(
            decodePromptBody({
                prompt: "  Summarize the latest graph changes.  ",
            })
        ).toEqual({
            prompt: "  Summarize the latest graph changes.  ",
        });

        expect(
            decodeNormalizedPromptBody({
                prompt: "  Summarize the latest graph changes.  ",
            })
        ).toEqual({
            prompt: "Summarize the latest graph changes.",
        });

        expect(() =>
            decodeNormalizedPromptBody({
                prompt: "   ",
            })
        ).toThrow();

        expect(() =>
            decodeNormalizedPromptBody({
                prompt: "x".repeat(MAX_PROMPT_LENGTH + 1),
            })
        ).toThrow();
    });

    test("graph create fields preserve teamId, graphId, and hidden field names", () => {
        expect(
            decodeGraphCreateFields({
                name: "Team graph",
                description: "Shared contract-backed create fields",
                teamId: "team-1",
                graphId: "graph-1",
                hidden: "true",
            })
        ).toEqual({
            name: "Team graph",
            description: "Shared contract-backed create fields",
            teamId: "team-1",
            graphId: "graph-1",
            hidden: "true",
        });
    });
});
