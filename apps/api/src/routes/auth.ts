import Elysia from "elysia";
import { auth } from "@kiwi/auth/server";
import { API_ERROR_CODES, errorResponse } from "../types";

const betterAuthMethods = new Set(["POST", "GET", "OPTIONS"]);

export const authRoute = new Elysia({ prefix: "/auth" }).all("*", (context) => {
    if (betterAuthMethods.has(context.request.method)) {
        return auth.handler(context.request);
    }

    return context.status(405, errorResponse("Method not allowed", API_ERROR_CODES.METHOD_NOT_ALLOWED));
});
