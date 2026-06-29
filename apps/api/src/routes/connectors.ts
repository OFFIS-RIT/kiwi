import {
    ConnectorConnectQuerySchema,
    ConnectorPatchInputSchema,
    ConnectorDiscoverQuerySchema,
    ConnectorResourceQuerySchema,
    GitHubConnectorManifestStartInputSchema,
    GitHubInstallCallbackQuerySchema,
    GitHubManifestCallbackQuerySchema,
    GitLabConnectorCreateInputSchema,
    NextcloudConnectorCreateInputSchema,
    NextcloudConnectorInstallationCreateInputSchema,
    ConnectorResourceGraphCreateInputSchema,
    RepositoryGraphCreateInputSchema,
} from "@kiwi/contracts/connectors";
import { successResponse } from "@kiwi/contracts/errors";
import { asApiSchema } from "@kiwi/contracts/schema";
import Elysia from "elysia";
import { connectorApiErrorOptions, runApiAction } from "../controllers/_shared/api-effect";
import { createGitLabConnector } from "../controllers/connector/create-gitlab";
import { createNextcloudConnector } from "../controllers/connector/create-nextcloud";
import {
    createConnectorGraphBinding,
    type ConnectorGraphCreateRequest,
} from "../controllers/connector/bindings/create-graph";
import { getConnectorGraphBinding } from "../controllers/connector/bindings/get";
import { syncConnectorGraphBinding } from "../controllers/connector/bindings/sync";
import { completeGitHubConnectorInstall } from "../controllers/connector/install/complete-github";
import { startConnectorInstall } from "../controllers/connector/install/start";
import { listConnectorInstallations } from "../controllers/connector/installations/list";
import { createNextcloudConnectorInstallation } from "../controllers/connector/installations/create-nextcloud";
import { listConnectors } from "../controllers/connector/list";
import { completeGitHubConnectorManifest } from "../controllers/connector/manifest/complete-github";
import { startGitHubConnectorManifest } from "../controllers/connector/manifest/start-github";
import { patchConnector } from "../controllers/connector/patch";
import { discoverConnectorResources } from "../controllers/connector/resources/discover";
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
    .post(
        "/nextcloud",
        ({ body, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => createNextcloudConnector({ user: currentUser, body }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { body: asApiSchema(NextcloudConnectorCreateInputSchema) }
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
    .post(
        "/:id/nextcloud/installations",
        ({ params, body, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    createNextcloudConnectorInstallation({ user: currentUser, connectorId: params.id, body }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { body: asApiSchema(NextcloudConnectorInstallationCreateInputSchema) }
    )
    .get(
        "/:id/discover",
        ({ params, query, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    discoverConnectorResources({
                        user: currentUser,
                        connectorId: params.id,
                        installationId: query.installationId,
                        parentId: query.parentId,
                    }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { query: asApiSchema(ConnectorDiscoverQuerySchema) }
    )
    .get(
        "/:id/resources",
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
        { query: asApiSchema(ConnectorResourceQuerySchema) }
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
        { query: asApiSchema(ConnectorResourceQuerySchema) }
    )
    .get(
        "/:id/resources/:resourceId/versions",
        ({ params, query, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    listConnectorResourceVersions({
                        user: currentUser,
                        connectorId: params.id,
                        installationId: query.installationId,
                        resourceId: params.resourceId,
                    }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { query: asApiSchema(ConnectorResourceQuerySchema) }
    )
    .get(
        "/:id/repositories/:resourceId/branches",
        ({ params, query, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    listConnectorResourceVersions({
                        user: currentUser,
                        connectorId: params.id,
                        installationId: query.installationId,
                        resourceId: params.resourceId,
                    }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { query: asApiSchema(ConnectorResourceQuerySchema) }
    )
    .post(
        "/:id/resource-graphs",
        ({ params, body, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    createConnectorGraphBinding({
                        user: currentUser,
                        connectorId: params.id,
                        body: body as ConnectorGraphCreateRequest,
                    }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { body: asApiSchema(ConnectorResourceGraphCreateInputSchema) }
    )
    .post(
        "/:id/repository-graphs",
        ({ params, body, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    createConnectorGraphBinding({
                        user: currentUser,
                        connectorId: params.id,
                        body: body as ConnectorGraphCreateRequest,
                    }),
                success: (value) => status(200, successResponse(value)),
                ...connectorApiErrorOptions,
            }),
        { body: asApiSchema(RepositoryGraphCreateInputSchema) }
    );

export const connectorResourceBindingRoute = new Elysia()
    .use(authMiddleware)
    .get("/connector-resource-bindings/:id", ({ params, status, user }) =>
        runApiAction({
            status,
            user,
            action: (currentUser) => getConnectorGraphBinding({ user: currentUser, bindingId: params.id }),
            success: (value) => status(200, successResponse(value)),
            ...connectorApiErrorOptions,
        })
    )
    .get("/repository-graph-bindings/:id", ({ params, status, user }) =>
        runApiAction({
            status,
            user,
            action: (currentUser) => getConnectorGraphBinding({ user: currentUser, bindingId: params.id }),
            success: (value) => status(200, successResponse(value)),
            ...connectorApiErrorOptions,
        })
    )
    .post("/connector-resource-bindings/:id/sync", ({ params, status, user }) =>
        runApiAction({
            status,
            user,
            action: (currentUser) => syncConnectorGraphBinding({ user: currentUser, bindingId: params.id }),
            success: (value) => status(200, successResponse(value)),
            ...connectorApiErrorOptions,
        })
    )
    .post("/repository-graph-bindings/:id/sync", ({ params, status, user }) =>
        runApiAction({
            status,
            user,
            action: (currentUser) => syncConnectorGraphBinding({ user: currentUser, bindingId: params.id }),
            success: (value) => status(200, successResponse(value)),
            ...connectorApiErrorOptions,
        })
    );
