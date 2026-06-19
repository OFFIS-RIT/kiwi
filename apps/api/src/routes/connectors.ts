import {
    ConnectorConnectQuerySchema,
    ConnectorPatchInputSchema,
    ConnectorRepositoryQuerySchema,
    GitHubConnectorManifestStartInputSchema,
    GitHubInstallCallbackQuerySchema,
    GitHubManifestCallbackQuerySchema,
    GitLabConnectorCreateInputSchema,
    RepositoryGraphCreateInputSchema,
} from "@kiwi/contracts/connectors";
import { successResponse } from "@kiwi/contracts/errors";
import { asApiSchema } from "@kiwi/contracts/schema";
import Elysia from "elysia";
import { connectorApiErrorOptions, runApiAction } from "../controllers/_shared/api-effect";
import { createGitLabConnector } from "../controllers/connector/create-gitlab";
import { createConnectorGraphBinding } from "../controllers/connector/bindings/create-graph";
import { getConnectorGraphBinding } from "../controllers/connector/bindings/get";
import { syncConnectorGraphBinding } from "../controllers/connector/bindings/sync";
import { completeGitHubConnectorInstall } from "../controllers/connector/install/complete-github";
import { startConnectorInstall } from "../controllers/connector/install/start";
import { listConnectorInstallations } from "../controllers/connector/installations/list";
import { listConnectors } from "../controllers/connector/list";
import { completeGitHubConnectorManifest } from "../controllers/connector/manifest/complete-github";
import { startGitHubConnectorManifest } from "../controllers/connector/manifest/start-github";
import { patchConnector } from "../controllers/connector/patch";
import { listConnectorResources } from "../controllers/connector/resources/list";
import { listConnectorResourceVersions } from "../controllers/connector/resources/list-versions";
import { authMiddleware } from "../middleware/auth";

export const connectorRoute = new Elysia({ prefix: "/connectors" })
    .use(authMiddleware)
    .get("/", ({ status, user }) =>
        runApiAction({
            status,
            user,
            action: (currentUser) => listConnectors({ user: currentUser }),
            success: (value) => status(200, successResponse(value)),
            ...connectorApiErrorOptions,
        })
    )
    .post(
        "/github/manifest/start",
        ({ body, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => startGitHubConnectorManifest({ user: currentUser, body }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { body: asApiSchema(GitHubConnectorManifestStartInputSchema) }
    )
    .get(
        "/github/manifest/callback",
        ({ query, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => completeGitHubConnectorManifest({ user: currentUser, query }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { query: asApiSchema(GitHubManifestCallbackQuerySchema) }
    )
    .post(
        "/gitlab",
        ({ body, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => createGitLabConnector({ user: currentUser, body }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { body: asApiSchema(GitLabConnectorCreateInputSchema) }
    )
    .patch(
        "/:id",
        ({ params, body, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => patchConnector({ user: currentUser, connectorId: params.id, body }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { body: asApiSchema(ConnectorPatchInputSchema) }
    )
    .get(
        "/:id/connect",
        ({ params, query, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => startConnectorInstall({ user: currentUser, connectorId: params.id, query }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { query: asApiSchema(ConnectorConnectQuerySchema) }
    )
    .get(
        "/github/install/callback",
        ({ query, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => completeGitHubConnectorInstall({ user: currentUser, query }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { query: asApiSchema(GitHubInstallCallbackQuerySchema) }
    )
    .get("/:id/installations", ({ params, status, user }) =>
        runApiAction({
            status,
            user,
            action: (currentUser) => listConnectorInstallations({ user: currentUser, connectorId: params.id }),
            success: (value) => status(200, successResponse(value)),
            ...connectorApiErrorOptions,
        })
    )
    .get(
        "/:id/repositories",
        ({ params, query, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    listConnectorResources({
                        user: currentUser,
                        connectorId: params.id,
                        installationId: query.installationId,
                    }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { query: asApiSchema(ConnectorRepositoryQuerySchema) }
    )
    .get(
        "/:id/repositories/:repositoryId/branches",
        ({ params, query, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    listConnectorResourceVersions({
                        user: currentUser,
                        connectorId: params.id,
                        installationId: query.installationId,
                        resourceId: params.repositoryId,
                    }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { query: asApiSchema(ConnectorRepositoryQuerySchema) }
    )
    .post(
        "/:id/repository-graphs",
        ({ params, body, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    createConnectorGraphBinding({ user: currentUser, connectorId: params.id, body }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { body: asApiSchema(RepositoryGraphCreateInputSchema) }
    );

export const repositoryGraphBindingRoute = new Elysia({ prefix: "/repository-graph-bindings" })
    .use(authMiddleware)
    .get("/:id", ({ params, status, user }) =>
        runApiAction({
            status,
            user,
            action: (currentUser) => getConnectorGraphBinding({ user: currentUser, bindingId: params.id }),
            success: (value) => status(200, successResponse(value)),
            ...connectorApiErrorOptions,
        })
    )
    .post("/:id/sync", ({ params, status, user }) =>
        runApiAction({
            status,
            user,
            action: (currentUser) => syncConnectorGraphBinding({ user: currentUser, bindingId: params.id }),
            success: (value) => status(200, successResponse(value)),
            ...connectorApiErrorOptions,
        })
    );
