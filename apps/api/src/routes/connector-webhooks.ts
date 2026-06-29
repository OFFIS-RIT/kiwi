import Elysia from "elysia";
import { handleConnectorWebhookRequest } from "../controllers/connector/webhooks/receive";

export const connectorWebhookRoute = new Elysia()
    .post("/connectors/webhooks/:provider/:connectorIdOrSlug", ({ params, request }) =>
        handleConnectorWebhookRequest({
            provider: params.provider,
            connectorIdOrSlug: params.connectorIdOrSlug,
            request,
        })
    )
    .post("/connectors/webhooks/:provider", ({ params, request }) =>
        handleConnectorWebhookRequest({
            provider: params.provider,
            request,
        })
    );
