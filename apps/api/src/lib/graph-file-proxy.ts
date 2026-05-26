import { and, eq } from "drizzle-orm";
import { db } from "@kiwi/db";
import { filesTable } from "@kiwi/db/tables/graph";
import { getFileMetadata, getFileStream } from "@kiwi/files";
import { contentDispositionForFile, contentDispositionHeader, parseByteRange } from "./file-proxy";

export type GraphFileProxyRecord = {
    key: string;
    name: string;
    mimeType: string;
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

    const stream = await getFileStream(file.key, options.bucket, range ?? undefined);
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
