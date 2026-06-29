import * as Effect from "effect/Effect";
import { describe, expect, test } from "bun:test";
import {
    createSharePointAdapter,
    publicSharePointResourceId,
    SHAREPOINT_PROVIDER,
    SHAREPOINT_RESOURCE_CAPABILITIES,
    normalizeSharePointFolderPath,
    normalizeSharePointGraphBaseUrl,
} from "../sharepoint";
import type { FetchLike } from "../types";

const TEAM_ITEM = driveItem({ id: "folder-team", name: "Team", path: "Team", folder: true, eTag: "team-etag" });
const DOCS_ITEM = driveItem({
    id: "folder-docs",
    name: "Docs",
    path: "Team/Docs",
    parentId: "folder-team",
    folder: true,
    eTag: "docs-etag",
});
const README_ITEM = driveItem({
    id: "file-readme",
    name: "readme.txt",
    path: "Team/readme.txt",
    parentId: "folder-team",
    mimeType: "text/plain",
    size: 12,
    eTag: "readme-etag",
});
const MANUAL_ITEM = driveItem({
    id: "file-manual",
    name: "manual.pdf",
    path: "Team/Docs/manual.pdf",
    parentId: "folder-docs",
    mimeType: "application/pdf",
    size: 4,
    eTag: "manual-etag",
});

const ROOT_DELTA_RESPONSE = {
    value: [omitParentPath(README_ITEM), omitParentPath(MANUAL_ITEM)],
    "@odata.deltaLink": "https://graph.example.test/v1.0/drives/drive-1/items/folder-team/delta?token=next",
};

describe("SharePoint connector adapter", () => {
    test("normalizes Graph and folder inputs", () => {
        expect(normalizeSharePointGraphBaseUrl("https://graph.example.test/v1.0///")).toBe(
            "https://graph.example.test/v1.0"
        );
        expect(normalizeSharePointFolderPath("/Team/Docs/")).toBe("Team/Docs");
        expect(publicSharePointResourceId("/")).toBe("/");
        expect(publicSharePointResourceId("/Team/Docs/")).toBe("Team/Docs");
    });

    test("lists a configured folder, children, and binary document cursor changes", async () => {
        const requests: Array<{ method: string; path: string; search: string }> = [];
        const fetchImpl = createSharePointFetch(requests);
        const adapter = createSharePointAdapter({
            tenantId: "tenant-1",
            clientId: "client-1",
            clientSecret: "secret-1",
            siteId: "site-1",
            driveId: "drive-1",
            folderPath: "/Team",
            graphBaseUrl: "https://graph.example.test/v1.0",
            tokenBaseUrl: "https://login.example.test",
            fetch: fetchImpl,
        });

        expect(adapter).toMatchObject({
            provider: SHAREPOINT_PROVIDER,
            resourceKind: "folder",
            capabilities: SHAREPOINT_RESOURCE_CAPABILITIES,
        });
        await expect(Effect.runPromise(adapter.listResources())).resolves.toEqual([
            expect.objectContaining({
                id: "folder-team",
                providerItemId: "folder-team",
                displayName: "Team",
                kind: "folder",
                path: "Team",
            }),
        ]);
        await expect(Effect.runPromise(adapter.listChildren?.() ?? Effect.succeed([]))).resolves.toEqual([
            expect.objectContaining({
                id: "folder-docs",
                providerItemId: "folder-docs",
                kind: "folder",
                path: "Team/Docs",
            }),
            expect.objectContaining({
                id: "file-readme",
                providerItemId: "file-readme",
                kind: "file",
                path: "Team/readme.txt",
                size: 12,
            }),
        ]);
        await expect(Effect.runPromise(adapter.listChildren?.("folder-docs") ?? Effect.succeed([]))).resolves.toEqual([
            expect.objectContaining({
                id: "file-manual",
                providerItemId: "file-manual",
                parentId: "folder-docs",
                kind: "file",
                path: "Team/Docs/manual.pdf",
            }),
        ]);

        const changeSet = await Effect.runPromise(adapter.listChanges?.("folder-team") ?? Effect.succeed(null));
        expect(changeSet).toMatchObject({ isInitial: true, versionId: expect.stringMatching(/^sharepoint:/u) });
        expect(changeSet?.cursor).toMatch(/^sharepoint:v1:/u);
        expect(changeSet?.changes).toContainEqual(
            expect.objectContaining({
                status: "added",
                providerItemId: "file-readme",
                newPath: "readme.txt",
                displayName: "readme.txt",
                contentAccessMode: "binary",
                processingKind: "document",
            })
        );
        expect(changeSet?.changes).toContainEqual(
            expect.objectContaining({
                status: "added",
                providerItemId: "file-manual",
                newPath: "Docs/manual.pdf",
                mimeType: "application/pdf",
                size: 4,
                etag: "manual-etag",
            })
        );

        const fileChangeSet = await Effect.runPromise(adapter.listChanges?.("file-manual") ?? Effect.succeed(null));
        expect(fileChangeSet).toMatchObject({ isInitial: true, versionId: expect.stringMatching(/^sharepoint:/u) });
        expect(fileChangeSet?.changes).toEqual([
            expect.objectContaining({
                status: "added",
                providerItemId: "file-manual",
                newPath: "manual.pdf",
                mimeType: "application/pdf",
                size: 4,
                etag: "manual-etag",
            }),
        ]);

        await expect(
            Effect.runPromise(
                adapter.openFile?.({
                    resourceKind: "file",
                    resourceId: "file-manual",
                    path: "manual.pdf",
                }) ?? Effect.succeed(null)
            )
        ).resolves.toMatchObject({ size: 4, contentType: "application/pdf" });
        await expect(
            Effect.runPromise(
                adapter.openFile?.({ resourceId: "folder-team", path: "Docs/manual.pdf" }) ?? Effect.succeed(null)
            )
        ).resolves.toMatchObject({ size: 4, contentType: "application/pdf" });
        expect(requests).toContainEqual({
            method: "GET",
            path: "/v1.0/drives/drive-1/items/file-manual/content",
            search: "",
        });
    });
});

type RequestRecord = { method: string; path: string; search: string };

type DriveItemInput = {
    id: string;
    name: string;
    path: string;
    parentId?: string;
    folder?: boolean;
    mimeType?: string;
    size?: number;
    eTag?: string;
};

function createSharePointFetch(requests: RequestRecord[]): FetchLike {
    return async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        requests.push({ method, path: url.pathname, search: url.search });

        if (url.hostname === "login.example.test" && method === "POST") {
            return jsonResponse({ token_type: "Bearer", access_token: "token-1" });
        }
        if (method === "GET" && url.pathname === "/v1.0/drives/drive-1/root:/Team:") {
            return jsonResponse(TEAM_ITEM);
        }
        if (method === "GET" && url.pathname === "/v1.0/drives/drive-1/items/folder-team") {
            return jsonResponse(TEAM_ITEM);
        }
        if (method === "GET" && url.pathname === "/v1.0/drives/drive-1/items/folder-docs") {
            return jsonResponse(DOCS_ITEM);
        }
        if (method === "GET" && url.pathname === "/v1.0/drives/drive-1/items/file-readme") {
            return jsonResponse(README_ITEM);
        }
        if (method === "GET" && url.pathname === "/v1.0/drives/drive-1/items/file-manual") {
            return jsonResponse(MANUAL_ITEM);
        }
        if (method === "GET" && url.pathname === "/v1.0/drives/drive-1/items/folder-team/children") {
            return jsonResponse({ value: [DOCS_ITEM, README_ITEM] });
        }
        if (method === "GET" && url.pathname === "/v1.0/drives/drive-1/items/folder-docs/children") {
            return jsonResponse({ value: [MANUAL_ITEM] });
        }
        if (method === "GET" && url.pathname === "/v1.0/drives/drive-1/items/folder-team/delta") {
            return jsonResponse(ROOT_DELTA_RESPONSE);
        }
        if (method === "GET" && url.pathname === "/v1.0/drives/drive-1/root:/Team/Docs/manual.pdf:") {
            return jsonResponse(MANUAL_ITEM);
        }
        if (method === "GET" && url.pathname === "/v1.0/drives/drive-1/items/file-manual/content") {
            return new Response(new Uint8Array([37, 80, 68, 70]), {
                headers: { "content-type": "application/pdf" },
            });
        }
        return new Response("not found", { status: 404 });
    };
}

function driveItem(input: DriveItemInput): Record<string, unknown> {
    return {
        id: input.id,
        name: input.name,
        eTag: input.eTag ?? `${input.id}-etag`,
        size: input.size,
        webUrl: `https://tenant.sharepoint.test/${input.path}`,
        parentReference: {
            id: input.parentId,
            path: `/drives/drive-1/root:/${input.path.split("/").slice(0, -1).join("/")}`,
        },
        ...(input.folder ? { folder: {} } : { file: { mimeType: input.mimeType ?? "application/octet-stream" } }),
    };
}

function omitParentPath(item: Record<string, unknown>): Record<string, unknown> {
    const parentReference = item.parentReference as Record<string, unknown> | undefined;
    return {
        ...item,
        parentReference: parentReference === undefined ? undefined : { id: parentReference.id },
    };
}

function jsonResponse(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
