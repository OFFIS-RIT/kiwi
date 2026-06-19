import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Elysia } from "elysia";

const selectedRows: Array<{
    fileType: string;
    chunker: string;
    chunkSize: number | null;
    documentMode: string | null;
}> = [];
let insertedValues: Record<string, unknown> | null = null;
let updateSet: Record<string, unknown> | null = null;

const db = {
    select: () => ({
        from: () => ({
            where: () => ({
                orderBy: async () => selectedRows,
            }),
        }),
    }),
    insert: () => ({
        values: (values: Record<string, unknown>) => {
            insertedValues = values;
            return {
                onConflictDoUpdate: (options: { set: Record<string, unknown> }) => {
                    updateSet = options.set;
                    return {
                        returning: async () => [{ ...values, ...options.set }],
                    };
                },
            };
        },
    }),
};

function runMockDbEffect(thunk: (database: typeof db) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) {
    const result = thunk(db);
    return Effect.isEffect(result) ? result : Effect.promise(async () => await result);
}

mock.module("@kiwi/db/effect", () => ({
    DatabaseLayer: Layer.empty,
    tryDb: runMockDbEffect,
}));

mock.module("../../lib/team/access", () => ({
    requireOrganizationAdmin: () => Effect.succeed({ organizationId: "org-1", role: "admin" }),
}));

mock.module("../../middleware/auth", () => ({
    authMiddleware: new Elysia({ name: "test-auth" }).derive({ as: "scoped" }, () => ({
        user: {
            id: "user-1",
            email: "user@example.com",
            isSystemAdmin: false,
        },
    })),
}));

// Test exception: mocks must be registered before evaluating the route module.
const { fileTypesRoute } = await import("../file-types");

function app() {
    return new Elysia().use(fileTypesRoute);
}

describe("file type route", () => {
    beforeEach(() => {
        selectedRows.length = 0;
        insertedValues = null;
        updateSet = null;
    });

    test("lists configured and default file type processing settings", async () => {
        selectedRows.push({ fileType: "pdf", chunker: "single", chunkSize: 1600, documentMode: "plain" });

        const response = await app().handle(new Request("http://localhost/file-types/"));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.status).toBe("success");
        expect(body.data).toContainEqual({
            file_type: "pdf",
            loader: "pdf",
            chunker: "single",
            chunk_size: 1600,
            document_mode: "plain",
            chunk_size_editable: true,
            document_mode_editable: true,
        });
        expect(body.data).toContainEqual({
            file_type: "code",
            loader: "text",
            chunker: "semantic",
            chunk_size: 2000,
            document_mode: null,
            chunk_size_editable: true,
            document_mode_editable: false,
        });
    });

    test("patches editable file type settings", async () => {
        const response = await app().handle(
            new Request("http://localhost/file-types/pdf", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ chunk_size: 1800, document_mode: "plain" }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(insertedValues).toMatchObject({
            organizationId: "org-1",
            fileType: "pdf",
            loader: "pdf",
            chunker: "semantic",
            chunkSize: 1800,
            documentMode: "plain",
        });
        expect(updateSet).toMatchObject({ chunkSize: 1800, documentMode: "plain" });
        expect(body.data).toMatchObject({ file_type: "pdf", chunk_size: 1800, document_mode: "plain" });
    });

    test("rejects unsupported file type settings", async () => {
        const response = await app().handle(
            new Request("http://localhost/file-types/csv", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ document_mode: "plain" }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body).toMatchObject({
            status: "error",
            code: "INVALID_FILE_TYPE_CONFIG",
            message: "Invalid file type configuration",
        });
        expect(insertedValues).toBeNull();
    });

    test("rejects empty patches with file type error response", async () => {
        const response = await app().handle(
            new Request("http://localhost/file-types/pdf", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({}),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body).toMatchObject({ status: "error", code: "NO_CHANGES", message: "No changes provided" });
    });
});
