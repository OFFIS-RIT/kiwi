import { and, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { tryDb, type Database } from "@kiwi/db/effect";
import { connectorInstallationsTable, connectorsTable, connectorResourceBindingsTable } from "@kiwi/db/tables/connectors";
import { filesTable } from "@kiwi/db/tables/graph";
import { getFileMetadata, getFileStream } from "@kiwi/files";
import { parseCodeFileMetadata } from "@kiwi/graph/code/metadata";
import { createProviderClient } from "../connectors";
import { contentDispositionForFile, contentDispositionHeader, parseByteRange } from "../file-proxy";


export type GraphFileProxyRecord = {
    key: string;
    name: string;
    mimeType: string;
    storageKind: string;
    externalProvider: string | null;
    externalUrl: string | null;
    connectorBindingId: string | null;
    metadata: string | null;
};

export type GraphFileProxyResult =
    | {
          status: "ok";
          response: Response;
      }
    | {
          status: "not_found";
      }
    | {
          status: "invalid_range";
          size: number;
      };

export function loadGraphFileByKey(
    graphId: string,
    fileKey: string
): Effect.Effect<{ id: string; name: string } | null, unknown, Database> {
    return Effect.map(
        tryDb((db) =>
            db
                .select({ id: filesTable.id, name: filesTable.name })
                .from(filesTable)
                .where(and(eq(filesTable.graphId, graphId), eq(filesTable.key, fileKey), eq(filesTable.deleted, false)))
                .limit(1)
        ),
        ([file]) => file ?? null
    );
}

export function loadGraphFileForProxy(
    graphId: string,
    fileId: string
): Effect.Effect<GraphFileProxyRecord | null, unknown, Database> {
    return Effect.map(
        tryDb((db) =>
            db
                .select({
                    key: filesTable.key,
                    name: filesTable.name,
                    mimeType: filesTable.mimeType,
                    storageKind: filesTable.storageKind,
                    externalProvider: filesTable.externalProvider,
                    externalUrl: filesTable.externalUrl,
                    connectorBindingId: filesTable.connectorBindingId,
                    metadata: filesTable.metadata,
                })
                .from(filesTable)
                .where(and(eq(filesTable.graphId, graphId), eq(filesTable.id, fileId), eq(filesTable.deleted, false)))
                .limit(1)
        ),
        ([file]) => file ?? null
    );
}

export function getGraphFileProxyResponse(options: {
    graphId: string;
    fileId: string;
    request: Request;
    bucket: string;
    head?: boolean;
}): Effect.Effect<GraphFileProxyResult, unknown, Database> {
    return Effect.catchDefect(Effect.gen(function* () {
        const file = yield* loadGraphFileForProxy(options.graphId, options.fileId);
        if (!file) {
            return { status: "not_found" };
        }

        if (file.storageKind === "external") {
            if (file.connectorBindingId) {
                const content = yield* readConnectorFile(file.connectorBindingId, file.metadata);
                if (content === null) {
                    return { status: "not_found" };
                }
                const bytes = new TextEncoder().encode(content);
                const range = parseByteRange(options.request.headers.get("range"), bytes.byteLength);
                if (range === "invalid") {
                    return { status: "invalid_range", size: bytes.byteLength };
                }
                const body = range ? bytes.slice(range.start, range.end + 1) : bytes;
                const headers = new Headers({
                    "Accept-Ranges": "bytes",
                    "Cache-Control": "private, no-cache",
                    "Content-Length": String(body.byteLength),
                    "Content-Type": file.mimeType || "text/plain; charset=utf-8",
                    "X-Content-Type-Options": "nosniff",
                });
                if (range) {
                    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
                }
                return {
                    status: "ok",
                    response: new Response(options.head ? null : body, { status: range ? 206 : 200, headers }),
                };
            }

            if (file.externalProvider !== "github") {
                return { status: "not_found" };
            }

            const metadata = parseCodeFileMetadata(file.metadata);
            if (metadata?.provider !== "github" || !metadata.rawUrl) {
                return { status: "not_found" };
            }

            return {
                status: "ok",
                response: new Response(null, {
                    status: 307,
                    headers: {
                        "Cache-Control": "private, no-cache",
                        Location: metadata.rawUrl,
                        "X-Content-Type-Options": "nosniff",
                    },
                }),
            };
        }

        const metadata = yield* getFileMetadata(file.key, options.bucket);
        if (!metadata) {
            return { status: "not_found" };
        }

        const range = parseByteRange(options.request.headers.get("range"), metadata.size);
        if (range === "invalid") {
            return { status: "invalid_range", size: metadata.size };
        }

        const contentType = file.mimeType || metadata.type || "application/octet-stream";
        const disposition = contentDispositionForFile(file.name, contentType);
        const headers = new Headers({
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-cache",
            "Content-Length": String(range ? range.end - range.start + 1 : metadata.size),
            "Content-Type": contentType,
            "X-Content-Type-Options": "nosniff",
        });

        if (disposition === "attachment") {
            headers.set("Content-Disposition", contentDispositionHeader(file.name, disposition));
        }

        if (metadata.lastModified) {
            headers.set("Last-Modified", metadata.lastModified.toUTCString());
        }

        if (range) {
            headers.set("Content-Range", `bytes ${range.start}-${range.end}/${metadata.size}`);
        }

        if (options.head) {
            return {
                status: "ok",
                response: new Response(null, {
                    status: range ? 206 : 200,
                    headers,
                }),
            };
        }

        const stream = yield* getFileStream(file.key, options.bucket, range ?? undefined, metadata);
        if (!stream) {
            return { status: "not_found" };
        }

        return {
            status: "ok",
            response: new Response(stream.content, {
                status: range ? 206 : 200,
                headers,
            }),
        };
    }), (defect) => Effect.fail(defect));
}

function readConnectorFile(bindingId: string, metadataValue: string | null): Effect.Effect<string | null, unknown, Database> {
    return Effect.catchDefect(Effect.gen(function* () {
        const metadata = parseCodeFileMetadata(metadataValue);
        if (!metadata) {
            return null;
        }

        const [row] = yield* tryDb((db) =>
            db
                .select({
                    binding: connectorResourceBindingsTable,
                    installation: connectorInstallationsTable,
                    connector: connectorsTable,
                })
                .from(connectorResourceBindingsTable)
                .innerJoin(
                    connectorInstallationsTable,
                    eq(connectorInstallationsTable.id, connectorResourceBindingsTable.connectorInstallationId)
                )
                .innerJoin(connectorsTable, eq(connectorsTable.id, connectorInstallationsTable.connectorId))
                .where(eq(connectorResourceBindingsTable.id, bindingId))
                .limit(1)
        );

        if (!row || row.connector.status !== "active" || row.installation.status !== "active") {
            return null;
        }
        if (metadata.bindingId && metadata.bindingId !== bindingId) {
            return null;
        }

        const client = yield* createProviderClient(row.connector, row.installation);
        return yield* client.readFile({
            resourceId: metadata.providerResourceId || row.binding.providerResourceId,
            path: metadata.path,
            versionId: metadata.versionId ?? metadata.git?.commitSha,
            etag: metadata.etag,
        });
    }), (defect) => Effect.fail(defect));
}
