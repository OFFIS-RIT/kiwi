import Elysia from "elysia";
import { handleBetterAuthRequest } from "../controllers/auth/handle-better-auth-request";

export const authRoute = new Elysia({ prefix: "/auth" }).all("*", ({ request, status }) =>
    handleBetterAuthRequest({ request, status })
);
