# Plan 009: Incremental connector repository updates for changed files only

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1dea5eb77..HEAD -- packages/connectors/src apps/worker/workflows/sync-repository-graph.ts apps/worker/lib/code-manifest.ts apps/worker/lib/code-repository-finalizer.ts apps/api/src/routes/connector-webhooks.ts apps/api/src/lib/graph-file-proxy.ts apps/worker/lib/file-content-source.ts packages/graph/src/code/metadata.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `007-version-code-sources-with-valid-until`, `008-provider-connectors-for-repository-graphs`
- **Category**: performance / correctness / repository sync
- **Planned at**: commit `1dea5eb77`, 2026-06-14

## Why this matters

Connector-backed repository graphs now stay fresh via manual sync and push webhooks, but every update still rebuilds the entire supported-code snapshot for the bound branch. That means:

1. A one-file change on `main` re-reads every supported code file from the provider API.
2. KIWI creates new file rows for the whole repository instead of just the touched paths.
3. The code workflow reprocesses unchanged files, wasting worker time and provider rate limit budget.
4. Large repositories pay full-branch rebuild cost on every push even when only a handful of files changed.

The product requirement is narrower and stricter: the initial connector import may stay full-snapshot, but **subsequent branch updates must only process changed supported code files, not silently reprocess the whole repository again**.

## Current state

Relevant files:

- `packages/connectors/src/types.ts` — provider client interface; it can list repos/branches, load a full snapshot, and read one file, but it cannot compare two revisions.
- `packages/connectors/src/github.ts` and `packages/connectors/src/gitlab.ts` — current provider clients load whole supported-code snapshots and fetch per-file content.
- `apps/worker/workflows/sync-repository-graph.ts` — connector sync loads a full branch snapshot, inserts a row per file, marks all prior binding rows deleted, and processes every inserted file.
- `apps/worker/lib/code-manifest.ts` — repository code manifests are still grouped by `repositoryUrl + commitSha`, so changed-file processing assumes one full-snapshot commit scope.
- `apps/worker/lib/code-repository-finalizer.ts` — current invalidation helper is repository-wide for the latest import batch, not path-targeted.
- `apps/api/src/routes/connector-webhooks.ts` — push webhooks already enqueue one sync per bound branch and commit.
- `plans/008-provider-connectors-for-repository-graphs.md` — incremental file-level updates were explicitly left out of scope when connectors landed.

Current provider client contract:

```ts
// packages/connectors/src/types.ts:81-86
export type ProviderRepositoryClient = {
    readonly provider: ConnectorProvider;
    listRepositories(): Promise<ProviderRepository[]>;
    listBranches(repository: ProviderRepository): Promise<ProviderBranch[]>;
    loadRepositorySnapshot(repository: ProviderRepository, branch: string, commitSha?: string): Promise<ProviderRepositorySnapshot>;
    readFile(repository: ProviderRepository, path: string, commitSha: string): Promise<string>;
};
```

Current connector sync rebuilds the whole binding snapshot:

```ts
// apps/worker/workflows/sync-repository-graph.ts:190-235
const insertedFiles = await tx.insert(filesTable).values(fileRows(row, snapshot, commitSha)).onConflictDoNothing().returning({ id: filesTable.id });
...
await tx
    .update(filesTable)
    .set({ deleted: true })
    .where(and(eq(filesTable.repositoryBindingId, row.binding.id), notInArray(filesTable.id, insertedFiles.map((file) => file.id))));
...
await step.runWorkflow(processFilesSpec, {
    graphId: row.binding.graphId,
    fileIds: created.fileIds,
    processRunId: created.processRunId,
    code: { kind: "repository" },
});
```

Current code-manifest scope is commit-wide:

```ts
// apps/worker/lib/code-manifest.ts:45-65,102-104
const selectedRepositoryKeys = new Set(
    selectedRows
        .map((row) => parseCodeFileMetadata(row.metadata))
        .filter((metadata) => metadata !== null)
        .map(repositoryManifestScopeKey)
);
...
function repositoryManifestScopeKey(metadata: Pick<CodeRepositoryFile, "repositoryUrl" | "commitSha">): string {
    return `${metadata.repositoryUrl}\0${metadata.commitSha}`;
}
```

Current repository-source invalidation is repo-wide for older batches:

```ts
// apps/worker/lib/code-repository-finalizer.ts:64-68,96-103
const candidateRows = await tx
    .select({ id: filesTable.id, metadata: filesTable.metadata })
    .from(filesTable)
    .where(and(eq(filesTable.graphId, options.graphId), eq(filesTable.type, "code")));
...
await tx.execute(sql`
    UPDATE sources source
    SET valid_until = NOW()
    FROM text_units text_unit
    WHERE source.text_unit_id = text_unit.id
      AND text_unit.file_id = ANY(${textArray(targets.olderFileIds)})
      AND ${currentSourceSql("source")}
`);
```

Current webhook route already passes one binding + commit into the sync workflow:

```ts
// apps/api/src/routes/connector-webhooks.ts:180-191
if (status === "enqueued" && normalized.commitSha) {
    for (const binding of bindings) {
        await db
            .update(repositoryGraphBindingsTable)
            .set({ lastSeenCommitSha: normalized.commitSha, syncStatus: "pending", syncErrorCode: null })
            .where(eq(repositoryGraphBindingsTable.id, binding.id));
        await ow.runWorkflow(syncRepositoryGraphSpec, {
            bindingId: binding.id,
            reason: "webhook",
            commitSha: normalized.commitSha,
            deliveryId,
        });
    }
}
```

Current connector plan explicitly deferred this work:

```md
<!-- plans/008-provider-connectors-for-repository-graphs.md:219-226 -->
- Fine-grained per-file incremental graph updates; rebuild the selected branch snapshot and rely on plan 007 source invalidation.
```

Provider docs observed during planning:

- GitHub supports `GET /repos/{owner}/{repo}/compare/{base...head}` and returns changed files between two refs/commits, plus raw file reads at `GET /repos/{owner}/{repo}/contents/{path}?ref=<sha>`.
- GitLab supports `GET /projects/:id/repository/compare?from=<sha>&to=<sha>` and returns `diffs[]` with `new_path`, `old_path`, `new_file`, `renamed_file`, `deleted_file`, and `compare_timeout`, plus raw file reads at `GET /projects/:id/repository/files/:path/raw?ref=<sha>`.

## Design decision

Keep the connector feature set and DB model from plan 008, but change update semantics from **branch snapshot replacement** to **binding-scoped incremental cutover**.

Core rules:

- **Initial connector graph creation stays full-snapshot.** The repository has no prior binding state to diff against.
- **Later manual syncs and push-webhook syncs are incremental.** Only changed supported code paths create new file rows and enter the code workflow.
- **Unchanged active file rows stay active.** Do not mint duplicate rows just to refresh `commitSha` metadata when the file content and path did not change.
- **Current binding state is the set of non-deleted code files for one `repositoryBindingId`, not “every file from one commit”.**
- **Repository code manifests for connector-backed files must be binding-scoped, not `repositoryUrl + commitSha` scoped.** Changed files still need unchanged siblings present for import resolution.
- **Removed/replaced paths invalidate only their own current sources.** Do not invalidate the whole binding when one file changes.
- **Normal document uploads and public URL imports remain unchanged.** This plan is connector-only.
- **No silent full-sync fallback for a routine update path.** If a provider compare cannot produce a safe delta, stop/report instead of quietly reprocessing the whole branch.

This deliberately keeps exact provenance for unchanged files: a source citation can still point at the last commit where that file content changed. If product later wants branch-head links for unchanged files too, that is a separate feature and must not reintroduce full-file churn here.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Connector provider tests | `bun test packages/connectors/src/__tests__/credentials.test.ts packages/connectors/src/__tests__/github.test.ts packages/connectors/src/__tests__/gitlab.test.ts` | exit 0 |
| Worker manifest + sync tests | `bun test apps/worker/lib/__tests__/code-manifest.test.ts apps/worker/workflows/process-file.test.ts apps/worker/workflows/sync-repository-graph.test.ts` | exit 0 |
| API regression tests | `bun test apps/api/src/lib/__tests__/graph-file-proxy.test.ts apps/api/src/lib/__tests__/source-reference.test.ts apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` | exit 0 |
| Workspace tests | `bun run test` | exit 0 |
| Lint | `bun run lint` | exit 0; no new errors |

## Scope

**In scope**:

- Extend `@kiwi/connectors` with provider-neutral compare/change APIs.
- GitHub and GitLab provider implementations for changed-path detection between two commits.
- Incremental connector sync in `sync-repository-graph.ts`.
- Binding-scoped repository manifests for connector-backed code files.
- Targeted file deletion/source invalidation for removed or replaced paths.
- Tests for changed-only sync, delete/rename handling, and no-op syncs when no supported code changed.

**Out of scope**:

- Changing the normal document pipeline.
- Changing public URL repository imports.
- Rewriting unchanged file rows solely to update commit metadata.
- Pull request preview graphs.
- Automatic repair for provider compare timeouts or missing compare ancestry.
- Provider support beyond GitHub and GitLab.

## Git workflow

- Branch name suggestion: `advisor/009-incremental-connector-updates`.
- Commit message style: `feat(connectors): sync only changed repository files`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Extend provider APIs with compare/change support

Add a provider-neutral change model in `packages/connectors/src/types.ts`, for example:

- `ProviderRepositoryChange`
- `ProviderRepositoryDelta`
- statuses covering `added`, `modified`, `deleted`, and `renamed`
- both `oldPath` and `newPath` where rename/delete semantics need them

Then add a new method to `ProviderRepositoryClient`, for example:

```ts
compareRepository(repository, fromCommitSha, toCommitSha): Promise<ProviderRepositoryDelta>
```

Implementation requirements:

- **GitHub**: call the compare endpoint for `base...head`, normalize changed-file records, and reject responses that do not safely describe changed paths.
- **GitLab**: call the compare endpoint, reject `compare_timeout === true`, and normalize `diffs[]` into the same provider-neutral shape.
- Preserve existing `readFile()` methods; incremental sync should reuse them to fetch only the touched file contents at the target commit.
- Keep path filtering consistent with current supported-code rules (`isSupportedCodePath`, skipped path segments, file-size limits).

Add/extend tests in `packages/connectors/src/__tests__/github.test.ts` and `packages/connectors/src/__tests__/gitlab.test.ts` for:

- modified supported file
- added supported file
- deleted supported file
- rename from supported → supported
- rename from supported → unsupported
- compare-timeout / malformed-response rejection

### Step 2: Teach code manifests about binding-scoped current snapshots

`prepareCodeManifest()` currently groups repository context by `repositoryUrl + commitSha`. That is incompatible with changed-only updates because unchanged active files will often keep older commit metadata.

Change the manifest scope logic so connector-backed repository files use a **binding-wide active snapshot** instead:

- if `repositoryBindingId` exists, scope by `repositoryBindingId`
- otherwise keep the existing public URL import behavior (`repositoryUrl + commitSha`)

Implementation notes:

- Keep normal document files and non-repository code files unchanged.
- Continue reading content through `readFileContentSource()`.
- Do not broaden the manifest beyond the selected binding; one repository binding should never leak another repository’s files into import resolution.

Add worker tests covering:

- incremental connector reprocessing where selected file IDs are at a newer commit but unchanged sibling files remain on older rows
- public URL repository imports still using the old commit-scoped manifest behavior

### Step 3: Compute incremental connector deltas instead of full snapshots

Update `apps/worker/workflows/sync-repository-graph.ts`.

Required behavior:

1. If `lastSyncedCommitSha` is missing, keep the current full-snapshot bootstrap behavior.
2. If `lastSyncedCommitSha === targetCommitSha`, keep the existing fast no-op.
3. Otherwise:
   - call the provider compare API
   - derive the set of affected supported code paths
   - load the current active binding rows keyed by path
   - build three sets:
     - **new/updated paths** → need new file rows + code processing
     - **removed/replaced old paths** → need targeted invalidation after successful cutover
     - **unchanged paths** → keep current active rows untouched

Path rules:

- `added` / `modified` / rename target with a supported path → fetch target file content and insert a new external file row for that path.
- `deleted` / rename source from a supported path → keep the old active row until success, then mark it deleted and invalidate its current sources.
- rename supported → supported is both a delete for the old path and an add for the new path.
- changes that only touch unsupported paths must not create a process run.

Do **not** call `loadRepositorySnapshot()` for incremental updates. The whole point of this plan is to stop loading every file when one file changed.

### Step 4: Cut over only the touched file rows

Replace the current “insert whole snapshot, mark everything else deleted” transaction with a targeted cutover:

- insert only new/updated file rows
- create a process run only when there are changed supported files to process
- do not mark old rows deleted until the changed-file workflows succeed
- if the changed-file workflow batch fails, leave the previous active rows intact

Use `repositoryBindingId` + parsed metadata path to identify the active row being replaced or removed.

Important edge cases:

- If compare says the branch changed but none of the changed paths are supported code, mark the binding synced and advance `lastSeenCommitSha` / `lastSyncedCommitSha` without a process run.
- If the same path appears twice in the delta after provider normalization, treat that as a bug and STOP rather than guessing.
- If a path was already deleted from the active binding state, ignore duplicate delete signals.

### Step 5: Make source invalidation path-targeted

`invalidateSupersededRepositorySources()` currently derives “older file IDs” by repository URL across the latest import batch. That is too broad for incremental sync.

Refactor it so the caller can pass explicit file IDs to retire, or add a new helper dedicated to binding/path cutover.

Required behavior after a successful incremental batch:

- mark only removed/replaced active file rows `deleted = true`
- set `sources.valid_until = NOW()` only for current sources attached to those retired file IDs
- keep unchanged file rows and their current sources active
- regenerate descriptions only for affected entities/relationships returned by the targeted invalidation helper

Keep the existing full-batch repository invalidation path for public URL imports if it is still used there. Do not accidentally couple connector-only incremental semantics back into the URL-import path.

### Step 6: Verification and regression coverage

Add or update focused tests for the behaviors above.

Minimum coverage:

- `packages/connectors/src/__tests__/github.test.ts` — compare normalization
- `packages/connectors/src/__tests__/gitlab.test.ts` — compare normalization and timeout handling
- `apps/worker/lib/__tests__/code-manifest.test.ts` — binding-scoped manifests across mixed commit rows
- `apps/worker/workflows/sync-repository-graph.test.ts` — changed-only file insertion, delete/rename handling, and no-op supported-code delta handling
- `apps/worker/workflows/process-file.test.ts` — repository batch finalization still requires all child workflows to succeed
- `apps/api/src/lib/__tests__/graph-file-proxy.test.ts` and/or `source-reference.test.ts` — unchanged active rows with older commit metadata still resolve content correctly

Then run the verification commands from the table above.

## STOP conditions

Stop and report instead of improvising if any of these occur:

1. Provider compare responses cannot safely enumerate changed paths for one of the supported providers.
2. A live repository binding can contain multiple non-deleted rows for the same path, and no existing invariant guarantees which one is current.
3. Binding-scoped manifests break public URL repository imports instead of staying connector-only.
4. The targeted invalidation change would require broad source/citation semantics beyond connector-backed repository files.
5. A safe incremental path for GitHub and GitLab diverges so much that the shared provider contract becomes misleading.

## Acceptance checklist

Do not mark this plan done until all are true:

- Subsequent connector syncs no longer load full branch snapshots for routine updates.
- A one-file change on a bound branch processes only that file plus any delete/rename counterpart, not every active file in the binding.
- Changes outside supported code paths do not create a process run.
- Unchanged active files remain available to the changed-file code manifest.
- Removed/replaced paths invalidate only their own current sources.
- Normal document uploads and public URL repository imports still behave the same as before.
- Tests and `bun run lint` pass with no new warnings/errors.

## Notes for the follow-up executor

The hard part is not the provider compare call; it is the cutover invariant:

- changed files must see unchanged siblings in the manifest
- failed incremental batches must leave the previous active snapshot intact
- unchanged files must not churn just because branch HEAD moved

Favor small helper modules over growing `sync-repository-graph.ts` into a second monolith. Keep provider compare logic in `packages/connectors`, binding snapshot logic in worker helpers, and public URL import behavior separate from connector-specific incremental semantics.
