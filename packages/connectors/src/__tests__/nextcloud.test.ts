import * as Effect from "effect/Effect";
import { describe, expect, test } from "bun:test";
import {
    createNextcloudAdapter,
    NEXTCLOUD_RESOURCE_CAPABILITIES,
    normalizeNextcloudBaseUrl,
    normalizeNextcloudFolderPath,
    publicNextcloudResourceId,
} from "../nextcloud";
import type { FetchLike } from "../types";

const TEAM_FOLDER_RESPONSE = responseXml({
    href: "/remote.php/dav/files/alice/Team/",
    displayName: "Team",
    fileId: "folder-team",
    collection: true,
    etag: "team-etag",
});

const TEAM_CHILDREN_RESPONSE = responseXml(
    {
        href: "/remote.php/dav/files/alice/Team/",
        displayName: "Team",
        fileId: "folder-team",
        collection: true,
        etag: "team-etag",
    },
    {
        href: "/remote.php/dav/files/alice/Team/Docs/",
        displayName: "Docs",
        fileId: "folder-docs",
        collection: true,
        etag: "docs-etag",
    },
    {
        href: "/remote.php/dav/files/alice/Team/readme.txt",
        displayName: "readme.txt",
        fileId: "file-readme",
        contentType: "text/plain",
        size: 12,
        etag: "readme-etag",
    }
);

const DOCS_CHILDREN_RESPONSE = responseXml(
    {
        href: "/remote.php/dav/files/alice/Team/Docs/",
        displayName: "Docs",
        fileId: "folder-docs",
        collection: true,
        etag: "docs-etag",
    },
    {
        href: "/remote.php/dav/files/alice/Team/Docs/manual.pdf",
        displayName: "manual.pdf",
        fileId: "file-manual",
        contentType: "application/pdf",
        size: 4,
        etag: "manual-etag",
    }
);

const MANUAL_FILE_RESPONSE = responseXml({
    href: "/remote.php/dav/files/alice/Team/Docs/manual.pdf",
    displayName: "manual.pdf",
    fileId: "file-manual",
    contentType: "application/pdf",
    size: 4,
    etag: "manual-etag",
});

describe("Nextcloud connector adapter", () => {
    test("normalizes server and folder inputs", () => {
        expect(normalizeNextcloudBaseUrl("https://cloud.example.com/remote.php/dav/")).toBe(
            "https://cloud.example.com"
        );
        expect(normalizeNextcloudBaseUrl("https://cloud.example.com/nextcloud///")).toBe(
            "https://cloud.example.com/nextcloud"
        );
        expect(normalizeNextcloudFolderPath("/Team/Docs/")).toBe("Team/Docs");
        expect(publicNextcloudResourceId("/")).toBe("/");
    });

    test("lists a configured folder and emits binary document cursor changes", async () => {
        const requests: Array<{ method: string; path: string; depth: string | null }> = [];
        const fetchImpl: FetchLike = async (input, init) => {
            const url = new URL(String(input));
            const method = init?.method ?? "GET";
            const depth = new Headers(init?.headers).get("depth");
            requests.push({ method, path: url.pathname, depth });
            if (method === "PROPFIND" && depth === "0" && url.pathname.endsWith("/remote.php/dav/files/alice/Team")) {
                return xmlResponse(TEAM_FOLDER_RESPONSE);
            }
            if (method === "PROPFIND" && depth === "1" && url.pathname.endsWith("/remote.php/dav/files/alice/Team")) {
                return xmlResponse(TEAM_CHILDREN_RESPONSE);
            }
            if (
                method === "PROPFIND" &&
                depth === "1" &&
                url.pathname.endsWith("/remote.php/dav/files/alice/Team/Docs")
            ) {
                return xmlResponse(DOCS_CHILDREN_RESPONSE);
            }
            if (
                method === "PROPFIND" &&
                depth === "0" &&
                url.pathname.endsWith("/remote.php/dav/files/alice/Team/Docs/manual.pdf")
            ) {
                return xmlResponse(MANUAL_FILE_RESPONSE);
            }
            if (method === "GET" && url.pathname.endsWith("/remote.php/dav/files/alice/Team/Docs/manual.pdf")) {
                return new Response(new Uint8Array([37, 80, 68, 70]), {
                    headers: { "content-type": "application/pdf" },
                });
            }
            return new Response("not found", { status: 404 });
        };
        const adapter = createNextcloudAdapter({
            baseUrl: "https://cloud.example.com/",
            username: "alice",
            appPassword: "app-password",
            folderPath: "/Team",
            fetch: fetchImpl,
        });

        expect(adapter).toMatchObject({
            provider: "nextcloud",
            resourceKind: "folder",
            capabilities: NEXTCLOUD_RESOURCE_CAPABILITIES,
        });
        await expect(Effect.runPromise(adapter.listResources())).resolves.toEqual([
            expect.objectContaining({ id: "Team", displayName: "Team", kind: "folder" }),
        ]);
        await expect(Effect.runPromise(adapter.listChildren?.() ?? Effect.succeed([]))).resolves.toEqual([
            expect.objectContaining({
                id: "Team/Docs",
                providerItemId: "folder-docs",
                kind: "folder",
                path: "Team/Docs",
            }),
            expect.objectContaining({
                id: "Team/readme.txt",
                providerItemId: "file-readme",
                kind: "file",
                path: "Team/readme.txt",
                size: 12,
            }),
        ]);
        await expect(Effect.runPromise(adapter.listChildren?.("Team/Docs") ?? Effect.succeed([]))).resolves.toEqual([
            expect.objectContaining({
                id: "Team/Docs/manual.pdf",
                providerItemId: "file-manual",
                parentId: "Team/Docs",
                kind: "file",
                path: "Team/Docs/manual.pdf",
            }),
        ]);
        const changeSet = await Effect.runPromise(adapter.listChanges?.("Team") ?? Effect.succeed(null));
        expect(changeSet).toMatchObject({ isInitial: true, versionId: expect.stringMatching(/^nextcloud:/u) });
        expect(changeSet?.cursor).toMatch(/^nextcloud:v1:/u);
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
        await expect(Effect.runPromise(adapter.getResource("Team/Docs/manual.pdf"))).resolves.toMatchObject({
            id: "Team/Docs/manual.pdf",
            kind: "file",
            displayName: "manual.pdf",
        });
        const fileChangeSet = await Effect.runPromise(
            adapter.listChanges?.("Team/Docs/manual.pdf") ?? Effect.succeed(null)
        );
        expect(fileChangeSet).toMatchObject({ isInitial: true, versionId: expect.stringMatching(/^nextcloud:/u) });
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
                    resourceId: "Team/Docs/manual.pdf",
                    path: "manual.pdf",
                }) ?? Effect.succeed(null)
            )
        ).resolves.toMatchObject({ size: 4, contentType: "application/pdf" });
        await expect(
            Effect.runPromise(
                adapter.openFile?.({ resourceId: "Team", path: "Docs/manual.pdf" }) ?? Effect.succeed(null)
            )
        ).resolves.toMatchObject({ size: 4, contentType: "application/pdf" });
        expect(requests).toContainEqual({
            method: "GET",
            path: "/remote.php/dav/files/alice/Team/Docs/manual.pdf",
            depth: null,
        });
    });
});

type DavResponse = {
    href: string;
    displayName: string;
    fileId: string;
    collection?: boolean;
    contentType?: string;
    size?: number;
    etag?: string;
};

function responseXml(...responses: DavResponse[]) {
    return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
${responses
    .map(
        (response) => `  <d:response>
    <d:href>${response.href}</d:href>
    <d:propstat>
      <d:status>HTTP/1.1 200 OK</d:status>
      <d:prop>
        <d:displayname>${response.displayName}</d:displayname>
        <oc:fileid>${response.fileId}</oc:fileid>
        <d:getetag>\"${response.etag ?? `${response.fileId}-etag`}\"</d:getetag>
        ${response.collection ? "<d:resourcetype><d:collection /></d:resourcetype>" : "<d:resourcetype />"}
        ${response.contentType ? `<d:getcontenttype>${response.contentType}</d:getcontenttype>` : ""}
        ${response.size === undefined ? "" : `<d:getcontentlength>${response.size}</d:getcontentlength>`}
      </d:prop>
    </d:propstat>
  </d:response>`
    )
    .join("\n")}
</d:multistatus>`;
}

function xmlResponse(body: string) {
    return new Response(body, { status: 207, headers: { "content-type": "application/xml" } });
}
