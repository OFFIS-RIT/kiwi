import { Elysia, t } from "elysia";
import { runApiAction } from "../controllers/_shared/api-effect";
import { listArchivedChats, listPinnedChats } from "../controllers/search/chat-library";
import { authMiddleware } from "../middleware/auth";
import { successResponse } from "../types";

export const chatLibraryRoute = new Elysia({ prefix: "/chats" })
    .use(authMiddleware)
    .get("/pinned", ({ user, status }) =>
        runApiAction({
            status,
            user,
            action: (currentUser) => listPinnedChats({ user: currentUser }),
            success: (value) => status(200, successResponse(value)),
        })
    )
    .get(
        "/archived",
        ({ query, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => listArchivedChats({ user: currentUser, query }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            query: t.Object({
                offset: t.Optional(t.String()),
                limit: t.Optional(t.String()),
            }),
        }
    );
