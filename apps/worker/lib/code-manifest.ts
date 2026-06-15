import { and, eq, inArray } from "drizzle-orm";
import { db } from "@kiwi/db";
import { filesTable } from "@kiwi/db/tables/graph";
import { getFile, putNamedFile } from "@kiwi/files";
import { buildCodeRepositoryManifest } from "@kiwi/graph/code/repository";
import type { CodeRepositoryFile, CodeRepositoryManifest } from "@kiwi/graph/code/repository";
import { env } from "../env";
import { parseCodeFileMetadata } from "./code-file-metadata";
import { fileContentSourceFromRow, readFileContentSource } from "./file-content-source";

type ManifestFileRow = {
    id: string;
    name: string;
    key: string;
    metadata: string | null;
    storageKind: string;
    externalUrl: string | null;
    externalProvider: string | null;
    repositoryBindingId: string | null;
};

export async function prepareCodeManifest(options: {
    graphId: string;
    fileIds: string[];
    processRunId?: string;
}): Promise<string | undefined> {
    if (options.fileIds.length === 0) {
        return undefined;
    }

    const selectedRows = await db
        .select({
            id: filesTable.id,
            name: filesTable.name,
            key: filesTable.key,
            metadata: filesTable.metadata,
            storageKind: filesTable.storageKind,
            externalUrl: filesTable.externalUrl,
            externalProvider: filesTable.externalProvider,
            repositoryBindingId: filesTable.repositoryBindingId,
        })
        .from(filesTable)
        .where(
            and(
                eq(filesTable.graphId, options.graphId),
                eq(filesTable.type, "code"),
                eq(filesTable.deleted, false),
                inArray(filesTable.id, options.fileIds)
            )
        );

    if (selectedRows.length === 0) {
        return undefined;
    }

    const selectedScopes = new Set(selectedRows.map(repositoryManifestScopeKey).filter((scope): scope is string => scope !== null));
    const rows = selectedScopes.size
        ? await db
              .select({
                  id: filesTable.id,
                  name: filesTable.name,
                  key: filesTable.key,
                  metadata: filesTable.metadata,
                  storageKind: filesTable.storageKind,
                  externalUrl: filesTable.externalUrl,
                  externalProvider: filesTable.externalProvider,
                  repositoryBindingId: filesTable.repositoryBindingId,
              })
              .from(filesTable)
              .where(and(eq(filesTable.graphId, options.graphId), eq(filesTable.type, "code"), eq(filesTable.deleted, false)))
        : selectedRows;

    const files: CodeRepositoryFile[] = [];
    for (const row of rows) {
        const metadata = parseCodeFileMetadata(row.metadata);
        const scope = repositoryManifestScopeKey(row);
        if (metadata && selectedScopes.size > 0 && (!scope || !selectedScopes.has(scope))) {
            continue;
        }

        const content = await readFileContentSource(fileContentSourceFromRow(row));
        if (!metadata || content === null) {
            continue;
        }

        files.push({
            fileId: row.id,
            content,
            ...metadata,
        });
    }

    if (files.length === 0) {
        return undefined;
    }

    const manifest = buildCodeRepositoryManifest(files);
    const uploaded = await putNamedFile(
        "code-manifest.json",
        JSON.stringify(manifest),
        `graphs/${options.graphId}/process-runs/${options.processRunId ?? "adhoc"}`,
        env.S3_BUCKET
    );

    return uploaded.key;
}

function repositoryManifestScopeKey(row: Pick<ManifestFileRow, "repositoryBindingId" | "metadata">): string | null {
    if (row.repositoryBindingId) {
        return `binding:${row.repositoryBindingId}`;
    }

    const metadata = parseCodeFileMetadata(row.metadata);
    if (!metadata) {
        return null;
    }

    return `repository:${metadata.repositoryUrl}\0${metadata.commitSha}`;
}

export async function loadCodeManifest(key: string): Promise<CodeRepositoryManifest> {
    const manifest = await getFile<CodeRepositoryManifest>(key, env.S3_BUCKET, "json");
    if (!manifest) {
        throw new Error(`Failed to load code manifest from ${key}`);
    }

    return manifest.content;
}
