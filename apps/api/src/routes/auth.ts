import Elysia, { Context } from "elysia";
import { auth } from "@kiwi/auth/server";
import { API_ERROR_CODES, errorResponse } from "../types";

const betterAuthView = (context: Context) => {
    const BETTER_AUTH_ACCEPT_METHODS = ["POST", "GET", "OPTIONS"];
    if (BETTER_AUTH_ACCEPT_METHODS.includes(context.request.method)) {
        return auth.handler(context.request);
    } else {
        return context.status(405, errorResponse("Method not allowed", API_ERROR_CODES.METHOD_NOT_ALLOWED));
    }
};

export const authRoute = new Elysia({ prefix: "/auth" }).all("*", betterAuthView);
