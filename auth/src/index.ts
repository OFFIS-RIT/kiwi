import { cors } from "@elysiajs/cors";
import { Context, Elysia } from "elysia";
import { auth, trustedOrigins } from "./auth";

const betterAuthView = (context: Context) => {
    const BETTER_AUTH_ACCEPT_METHODS = ["POST", "GET"];
    if (BETTER_AUTH_ACCEPT_METHODS.includes(context.request.method)) {
        return auth.handler(context.request);
    } else {
        context.status("Forbidden", { error: "Method not allowed" });
    }
};

const app = new Elysia()
    .use(cors({
        origin: (request) => {
            const origin = request.headers.get("origin");
            return origin ? trustedOrigins.includes(origin) : false;
        },
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"],
    }))
    .get("/auth/health", () => ({ status: "ok" }))
    .all("/auth/*", betterAuthView)
    .listen(4321);

console.log(`Auth server is running at ${app.server?.hostname}:${app.server?.port}`);
