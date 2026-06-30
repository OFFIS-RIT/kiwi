import { and, eq, inArray } from "@kiwi/db/drizzle";
import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import { withWorkerDb } from "../runtime/effect";
import { filesTable } from "@kiwi/db/tables/graph";
import { getFile, putNamedFile, type FileStorage } from "@kiwi/files";
import { buildCodeRepositoryManifest } from "@kiwi/graph/code/repository";
import type { CodeRepositoryFile, CodeRepositoryManifest } from "@kiwi/graph/code/repository";
import { env } from "../../env";
import { codeRepositoryFileFieldsFromMetadata, parseCodeFileMetadata } from "./metadata";
import { fileContentSourceFromRow, readFileContentSource } from "../files/content-source";

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

export type CodeRepositoryContext = {
    files: CodeRepositoryFile[];
    manifest: CodeRepositoryManifest;
    repositoryScopes: string[];
    branch: string;
    defaultBranch?: string;
    isDefaultBranch: boolean;
};

export type CodeRepositoryBranchContext = CodeRepositoryContext;

export function prepareCodeManifest(options: {
    graphId: string;
    fileIds: string[];
    processRunId?: string;
}): Effect.Effect<string | undefined, unknown, Database | FileStorage> {
    return Effect.gen(function* () {
        const context = yield* loadDefaultBranchCodeRepositoryContext({
            graphId: options.graphId,
            fileIds: options.fileIds,
        });
        if (!context) {
            return undefined;
        }
        return yield* uploadCodeManifest(context, { graphId: options.graphId, processRunId: options.processRunId });
    });
}

export function uploadCodeManifest(
    context: Pick<CodeRepositoryContext, "manifest">,
    options: { graphId: string; processRunId?: string }
): Effect.Effect<string, unknown, FileStorage> {
    return Effect.gen(function* () {
        const uploaded = yield* putNamedFile(
            "manifest.json",
            JSON.stringify(context.manifest),
            `graphs/${options.graphId}/process-runs/${options.processRunId ?? "latest"}/code`,
            env.S3_BUCKET
        );
        return uploaded.key;
    });
}

export function loadCodeRepositoryContext(options: {
    graphId: string;
    fileIds: string[];
}): Effect.Effect<CodeRepositoryContext | undefined, unknown, Database | FileStorage> {
    return loadDefaultBranchCodeRepositoryContext(options);
}

export function loadDefaultBranchCodeRepositoryContext(options: {
    graphId: string;
    fileIds: string[];
}): Effect.Effect<CodeRepositoryBranchContext | undefined, unknown, Database | FileStorage> {
    return Effect.gen(function* () {
        const contexts = yield* loadCodeRepositoryContextsByBranch(options);
        return contexts.find((context) => context.isDefaultBranch) ?? contexts[0];
    });
}

export function loadCodeRepositoryContextsByBranch(options: {
    graphId: string;
    fileIds: string[];
}): Effect.Effect<CodeRepositoryBranchContext[], unknown, Database | FileStorage> {
    return Effect.gen(function* () {
        if (options.fileIds.length === 0) {
            return [];
        }

        const selectedRows = yield* selectCodeFileRows(options.graphId, options.fileIds);
        if (selectedRows.length === 0) {
            return [];
        }

        const selectedBranchesByScope = new Map<string, Set<string>>();
        for (const row of selectedRows) {
            const metadata = parseCodeFileMetadata(row.metadata);
            if (!metadata) {
                continue;
            }
            const fields = codeRepositoryFileFieldsFromMetadata(metadata, { graphId: options.graphId, name: row.name });
            const scope = repositoryManifestScopeKey(row, fields);
            if (!scope) {
                continue;
            }
            const branches = selectedBranchesByScope.get(scope) ?? new Set<string>();
            branches.add(branchFromFile(fields));
            selectedBranchesByScope.set(scope, branches);
        }

        const selectedScopes = new Set(selectedBranchesByScope.keys());
        const candidateRows = selectedScopes.size > 0 ? yield* selectActiveCodeFileRows(options.graphId) : selectedRows;
        const filesByBranch = new Map<
            string,
            {
                files: CodeRepositoryFile[];
                repositoryScopes: Set<string>;
                defaultBranch: string;
                isDefaultBranch: boolean;
            }
        >();

        for (const row of candidateRows) {
            const metadata = parseCodeFileMetadata(row.metadata);
            if (!metadata) {
                continue;
            }
            const fields = codeRepositoryFileFieldsFromMetadata(metadata, { graphId: options.graphId, name: row.name });
            const scope = repositoryManifestScopeKey(row, fields);
            const branch = branchFromFile(fields);
            if (selectedScopes.size > 0) {
                const selectedBranches = scope ? selectedBranchesByScope.get(scope) : undefined;
                if (!scope || !selectedBranches?.has(branch)) {
                    continue;
                }
            }

            const content = yield* readFileContentSource(fileContentSourceFromRow(row));
            if (content === null) {
                continue;
            }

            const defaultBranch = defaultBranchFromFile(fields, branch);
            const entry = filesByBranch.get(branch) ?? {
                files: [],
                repositoryScopes: new Set<string>(),
                defaultBranch,
                isDefaultBranch: branch === defaultBranch,
            };
            entry.files.push({ fileId: row.id, content, ...fields });
            if (scope) {
                entry.repositoryScopes.add(scope);
            }
            if (fields.defaultBranch) {
                entry.defaultBranch = fields.defaultBranch;
                entry.isDefaultBranch = branch === fields.defaultBranch;
            }
            filesByBranch.set(branch, entry);
        }

        return [...filesByBranch.entries()]
            .filter(([, entry]) => entry.files.length > 0)
            .map(([branch, entry]) => ({
                files: entry.files,
                manifest: buildCodeRepositoryManifest(entry.files),
                repositoryScopes: [...entry.repositoryScopes].sort(),
                branch,
                defaultBranch: entry.defaultBranch,
                isDefaultBranch: entry.isDefaultBranch,
            }))
            .sort(
                (left, right) =>
                    Number(right.isDefaultBranch) - Number(left.isDefaultBranch) ||
                    left.branch.localeCompare(right.branch)
            );
    });
}

function selectCodeFileRows(graphId: string, fileIds: string[]): Effect.Effect<ManifestFileRow[], unknown, Database> {
    return withWorkerDb((db) =>
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
                    eq(filesTable.graphId, graphId),
                    eq(filesTable.type, "code"),
                    eq(filesTable.deleted, false),
                    inArray(filesTable.id, fileIds)
                )
            )
    );
}

function selectActiveCodeFileRows(graphId: string): Effect.Effect<ManifestFileRow[], unknown, Database> {
    return withWorkerDb((db) =>
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
            .where(and(eq(filesTable.graphId, graphId), eq(filesTable.type, "code"), eq(filesTable.deleted, false)))
    );
}

function repositoryManifestScopeKey(
    row: Pick<ManifestFileRow, "connectorBindingId">,
    fields: Pick<CodeRepositoryFile, "repositoryUrl" | "commitSha">
): string | null {
    if (row.connectorBindingId) {
        return `binding:${row.connectorBindingId}`;
    }

    return `repository:${fields.repositoryUrl}\0${fields.commitSha}`;
}

function branchFromFile(file: Pick<CodeRepositoryFile, "branch" | "defaultBranch">): string {
    return file.branch ?? file.defaultBranch ?? "default";
}

function defaultBranchFromFile(file: Pick<CodeRepositoryFile, "defaultBranch">, branch: string): string {
    return file.defaultBranch ?? branch;
}

export function loadCodeManifest(key: string): Effect.Effect<CodeRepositoryManifest, unknown, FileStorage> {
    return Effect.gen(function* () {
        const manifest = yield* getFile<CodeRepositoryManifest>(key, env.S3_BUCKET, "json");
        if (!manifest) {
            return yield* Effect.fail(new Error(`Failed to load code manifest from ${key}`));
        }

        return manifest.content;
    });
}
