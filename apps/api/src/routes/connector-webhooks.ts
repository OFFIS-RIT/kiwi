import Elysia from "elysia";
import { handleConnectorWebhookRequest } from "../controllers/connector/webhooks/receive";

export const connectorWebhookRoute = new Elysia().post("/connectors/webhooks/:provider", ({ params, request }) =>
    handleConnectorWebhookRequest({
        provider: params.provider,
        request,
    })
);
