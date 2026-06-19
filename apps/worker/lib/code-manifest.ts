import { and, eq, inArray } from "drizzle-orm";
import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import { withWorkerDb } from "./effect";
import { filesTable } from "@kiwi/db/tables/graph";
import { getFile, putNamedFile } from "@kiwi/files";
import { buildCodeRepositoryManifest } from "@kiwi/graph/code/repository";
import type { CodeRepositoryFile, CodeRepositoryManifest } from "@kiwi/graph/code/repository";
import { env } from "../env";
import { codeRepositoryFileFieldsFromMetadata, parseCodeFileMetadata } from "./code-file-metadata";
import { fileContentSourceFromRow, readFileContentSource } from "./file-content-source";

type ManifestFileRow = {
    id: string;
    name: string;
    key: string;
    metadata: string | null;
    storageKind: string;
    externalUrl: string | null;
    externalProvider: string | null;
    connectorBindingId: string | null;
};

export function prepareCodeManifest(options: {
    graphId: string;
    fileIds: string[];
    processRunId?: string;
}): Effect.Effect<string | undefined, unknown, Database> {
    return Effect.gen(function* () {
        if (options.fileIds.length === 0) {
            return undefined;
        }

        const selectedRows = yield* withWorkerDb((db) =>
            db
                .select({
                    id: filesTable.id,
                    name: filesTable.name,
                    key: filesTable.key,
                    metadata: filesTable.metadata,
                    storageKind: filesTable.storageKind,
                    externalUrl: filesTable.externalUrl,
                    externalProvider: filesTable.externalProvider,
                    connectorBindingId: filesTable.connectorBindingId,
                })
                .from(filesTable)
                .where(
                    and(
                        eq(filesTable.graphId, options.graphId),
                        eq(filesTable.type, "code"),
                        eq(filesTable.deleted, false),
                        inArray(filesTable.id, options.fileIds)
                    )
                )
        );

        if (selectedRows.length === 0) {
            return undefined;
        }

        const selectedScopes = new Set(selectedRows.map(repositoryManifestScopeKey).filter((scope): scope is string => scope !== null));
        const rows = selectedScopes.size
            ? yield* withWorkerDb((db) =>
                  db
                      .select({
                          id: filesTable.id,
                          name: filesTable.name,
                          key: filesTable.key,
                          metadata: filesTable.metadata,
                          storageKind: filesTable.storageKind,
                          externalUrl: filesTable.externalUrl,
                          externalProvider: filesTable.externalProvider,
                          connectorBindingId: filesTable.connectorBindingId,
                      })
                      .from(filesTable)
                      .where(and(eq(filesTable.graphId, options.graphId), eq(filesTable.type, "code"), eq(filesTable.deleted, false)))
              )
            : selectedRows;

        const files: CodeRepositoryFile[] = [];
        for (const row of rows) {
            const metadata = parseCodeFileMetadata(row.metadata);
            const scope = repositoryManifestScopeKey(row);
            if (metadata && selectedScopes.size > 0 && (!scope || !selectedScopes.has(scope))) {
                continue;
            }

            const content = yield* readFileContentSource(fileContentSourceFromRow(row));
            if (!metadata || content === null) {
                continue;
            }

            files.push({
                fileId: row.id,
                content,
                ...codeRepositoryFileFieldsFromMetadata(metadata, { graphId: options.graphId, name: row.name }),
            });
        }

        if (files.length === 0) {
            return undefined;
        }

        const manifest = buildCodeRepositoryManifest(files);
        const uploaded = yield* putNamedFile(
            "code-manifest.json",
            JSON.stringify(manifest),
            `graphs/${options.graphId}/process-runs/${options.processRunId ?? "adhoc"}`,
            env.S3_BUCKET
        );

        return uploaded.key;
    });
}

function repositoryManifestScopeKey(row: Pick<ManifestFileRow, "connectorBindingId" | "metadata">): string | null {
    if (row.connectorBindingId) {
        return `binding:${row.connectorBindingId}`;
    }

    const metadata = parseCodeFileMetadata(row.metadata);
    if (!metadata) {
        return null;
    }

    const fields = codeRepositoryFileFieldsFromMetadata(metadata, { graphId: "", name: "" });
    return `repository:${fields.repositoryUrl}\0${fields.commitSha}`;
}

export function loadCodeManifest(key: string): Effect.Effect<CodeRepositoryManifest, unknown> {
    return Effect.gen(function* () {
        const manifest = yield* getFile<CodeRepositoryManifest>(key, env.S3_BUCKET, "json");
        if (!manifest) {
            return yield* Effect.fail(new Error(`Failed to load code manifest from ${key}`));
        }

        return manifest.content;
    });
}
