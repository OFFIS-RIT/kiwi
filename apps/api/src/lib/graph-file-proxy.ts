import type { ConnectorProvider, ProviderRepository } from "@kiwi/connectors";
import { and, eq } from "drizzle-orm";
import { db } from "@kiwi/db";
import { connectorInstallationsTable, connectorsTable, repositoryGraphBindingsTable } from "@kiwi/db/tables/connectors";
import { filesTable } from "@kiwi/db/tables/graph";
import { getFileMetadata, getFileStream } from "@kiwi/files";
import { parseCodeFileMetadata } from "@kiwi/graph/code/metadata";
import { createProviderClient } from "./connectors";
import { contentDispositionForFile, contentDispositionHeader, parseByteRange } from "./file-proxy";

export type GraphFileProxyRecord = {
    key: string;
    name: string;
    mimeType: string;
    storageKind: string;
    externalProvider: string | null;
    externalUrl: string | null;
    repositoryBindingId: string | null;
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

export async function loadGraphFileByKey(
    graphId: string,
    fileKey: string
): Promise<{ id: string; name: string } | null> {
    const [file] = await db
        .select({ id: filesTable.id, name: filesTable.name })
        .from(filesTable)
        .where(and(eq(filesTable.graphId, graphId), eq(filesTable.key, fileKey), eq(filesTable.deleted, false)))
        .limit(1);

    return file ?? null;
}

export async function loadGraphFileForProxy(graphId: string, fileId: string): Promise<GraphFileProxyRecord | null> {
    const [file] = await db
        .select({
            key: filesTable.key,
            name: filesTable.name,
            mimeType: filesTable.mimeType,
            storageKind: filesTable.storageKind,
            externalProvider: filesTable.externalProvider,
            externalUrl: filesTable.externalUrl,
            repositoryBindingId: filesTable.repositoryBindingId,
            metadata: filesTable.metadata,
        })
        .from(filesTable)
        .where(and(eq(filesTable.graphId, graphId), eq(filesTable.id, fileId), eq(filesTable.deleted, false)))
        .limit(1);

    return file ?? null;
}

export async function getGraphFileProxyResponse(options: {
    graphId: string;
    fileId: string;
    request: Request;
    bucket: string;
    head?: boolean;
}): Promise<GraphFileProxyResult> {
    const file = await loadGraphFileForProxy(options.graphId, options.fileId);
    if (!file) {
        return { status: "not_found" };
    }

    if (file.storageKind === "external") {
        if (file.repositoryBindingId) {
            const content = await readConnectorFile(file.repositoryBindingId, file.metadata);
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

        if (file.externalProvider !== "github" || !file.externalUrl) {
            return { status: "not_found" };
        }

        const metadata = parseCodeFileMetadata(file.metadata);
        if (!metadata?.external || metadata.external.provider !== "github") {
            return { status: "not_found" };
        }

        return {
            status: "ok",
            response: new Response(null, {
                status: 307,
                headers: {
                    "Cache-Control": "private, no-cache",
                    Location: file.externalUrl,
                    "X-Content-Type-Options": "nosniff",
                },
            }),
        };
    }

    const metadata = await getFileMetadata(file.key, options.bucket);
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

    const stream = await getFileStream(file.key, options.bucket, range ?? undefined, metadata);
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
}

async function readConnectorFile(bindingId: string, metadataValue: string | null): Promise<string | null> {
    const metadata = parseCodeFileMetadata(metadataValue);
    if (!metadata) {
        return null;
    }

    const [row] = await db
        .select({
            binding: repositoryGraphBindingsTable,
            installation: connectorInstallationsTable,
            connector: connectorsTable,
        })
        .from(repositoryGraphBindingsTable)
        .innerJoin(
            connectorInstallationsTable,
            eq(connectorInstallationsTable.id, repositoryGraphBindingsTable.connectorInstallationId)
        )
        .innerJoin(connectorsTable, eq(connectorsTable.id, connectorInstallationsTable.connectorId))
        .where(eq(repositoryGraphBindingsTable.id, bindingId))
        .limit(1);

    if (!row || row.connector.status !== "active" || row.installation.status !== "active") {
        return null;
    }

    const client = await createProviderClient(row.connector, row.installation);
    const repository: ProviderRepository = {
        provider: row.connector.provider as ConnectorProvider,
        id: row.binding.providerRepositoryId,
        fullName: row.binding.repositoryFullName,
        name: row.binding.repositoryFullName.split("/").at(-1) ?? row.binding.repositoryFullName,
        htmlUrl: row.binding.repositoryHtmlUrl,
        defaultBranch: row.binding.branch,
        private: true,
    };
    return client.readFile(repository, metadata.path, metadata.commitSha);
}
