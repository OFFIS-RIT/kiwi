# Plan 006: Support external GitHub code files without copying them to S3

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1dea5eb77..HEAD -- packages/db/src/tables/graph.ts apps/api/src/routes/graph.ts apps/api/src/lib/repository-url.ts apps/api/src/lib/graph-file-proxy.ts apps/worker/workflows/process-code-file.ts apps/worker/lib/code-manifest.ts packages/graph/src/code/metadata.ts packages/files/src`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `003-validate-repository-import-models`, `004-sanitize-repository-url-errors`, ideally `005-route-code-uploads-through-code-workflow`
- **Category**: feature / storage architecture
- **Planned at**: commit `1dea5eb77`, 2026-06-13

## Why this matters

Repository code imports currently create one `files` row per source file and upload every selected source file into S3. For GitHub repositories this is unnecessary: code content has a stable external origin when addressed by commit SHA and path. The product needs files that can be external so code imports can link to GitHub directly, avoid S3 duplication, and still feed the worker/code graph pipeline.

The target invariant: **internal uploaded files use S3; external GitHub code files use immutable GitHub commit+path references and are fetched only when processing/proxying requires bytes.**

## Current state

Relevant files:

- `packages/db/src/tables/graph.ts` — `files` table assumes every file has a non-null S3 key.
- `apps/api/src/routes/graph.ts` — repository URL route uploads each repository source to S3 before inserting DB rows.
- `apps/api/src/lib/repository-url.ts` — clones repository, enumerates supported files, returns content.
- `packages/graph/src/code/metadata.ts` — code metadata only stores repository URL/name/commit/path.
- `apps/worker/workflows/process-code-file.ts` — code workflow reads code content from S3 using `fileData.key`.
- `apps/worker/lib/code-manifest.ts` — repository manifest preparation reads every matching code file from S3.
- `apps/api/src/lib/graph-file-proxy.ts` — file proxy streams only S3 objects.

Current `files` schema excerpt:

```ts
// packages/db/src/tables/graph.ts:136-148
name: text("name").notNull(),
size: integer("file_size").notNull(),
type: text("file_type").notNull(),
mimeType: text("mime_type").notNull(),
key: text("file_key").notNull(),
checksum: text("checksum"),
deleted: boolean("deleted").default(false),
status: text("status", { enum: FILE_PROCESS_STATUS_VALUES }).notNull().default("processing"),
processStep: text("process_step", { enum: FILE_PROCESS_STEP_VALUES }).notNull().default("pending"),
processErrorCode: text("process_error_code").$type<FileProcessErrorCode | null>(),
tokenCount: integer("token_count").notNull().default(0),
metadata: text("metadata"),
```

Current repository URL route copies to S3:

```ts
// apps/api/src/routes/graph.ts:652-667
const upload = await putGraphFile(existingGraph.id, fileId, source.file, env.S3_BUCKET);
uploadedFiles.push({
    graphId: existingGraph.id,
    fileId,
    name: source.name,
    size: source.size,
    type: "code",
    mimeType: "text/plain",
    key: upload.key,
    checksum: source.checksum,
    metadata: serializeCodeFileMetadata({
        repositoryUrl: source.repository.url,
        repositoryName: source.repository.name,
        commitSha: source.repository.commitSha,
        path: source.path,
    }),
});
```

Current code workflow reads S3:

```ts
// apps/worker/workflows/process-code-file.ts:79-93
const paths = getGraphFileArtifactPaths({
    graphId: input.graphId,
    fileId: input.fileId,
    fileKey: fileData.key,
});
...
const source = await getFile(fileData.key, env.S3_BUCKET, "text");
if (!source) {
    throw new Error("File content not found");
}
```

Current code metadata:

```ts
// packages/graph/src/code/metadata.ts:3-30
export type CodeFileMetadata = Omit<CodeRepositoryFile, "fileId" | "content">;
...
return {
    repositoryUrl: parsed.repositoryUrl,
    repositoryName: parsed.repositoryName,
    commitSha: parsed.commitSha,
    path: parsed.path,
};
```

Repo conventions:

- Run commands from the repo root.
- Do not run `bun run db:migrate`.
- Do not hand-create migrations first; for custom/manual migrations run `bun run db:generate --custom` before editing.
- Use `better-result` / `Result.tryPromise` in routes when mapping expected async errors.
- Keep changes minimal and local; no compatibility shims unless explicitly required.
- Root verification commands available: `bun run test`, `bun run lint`. At planning time, `bun run test` passed; `bun run lint` exited 0 with one existing frontend warning.

## Design decision

Use explicit file storage origin columns instead of overloading `file_key` or only `metadata`.

Add these concepts:

- `files.storage_kind`: enum-like text, `"internal" | "external"`, default `"internal"`, not null.
- `files.external_url`: nullable text. Canonical immutable raw-content URL for external files.
- `files.external_provider`: nullable text, initially only `"github"`.
- Keep `files.file_key` non-null for now, but for external GitHub code set it to a deterministic synthetic key: `external:github:<owner>/<repo>@<commitSha>:<path>`. This preserves existing key-based DB lookups, dedupe UI references, and unique indexes while making it clear the key is not an S3 key.

External GitHub code metadata must include enough to rebuild safe URLs without trusting arbitrary user input:

```ts
type CodeFileMetadata = {
  repositoryUrl: string;
  repositoryName: string;
  commitSha: string;
  path: string;
  external?: {
    provider: "github";
    rawUrl: string;   // https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>
    htmlUrl: string;  // https://github.com/<owner>/<repo>/blob/<sha>/<path>
  };
};
```

Security invariant: external URLs are generated by server-side normalization from allowed GitHub repository URL + commit SHA + supported code path. Never accept arbitrary external URLs from request bodies in this plan.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Generate migration scaffold | `bun run db:generate --custom` | creates a new migration scaffold to edit |
| DB tests | `bun test packages/db/src/__tests__/migration-compat.test.ts` | exit 0 |
| API repository tests | `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts apps/api/src/lib/__tests__/repository-url.test.ts` | exit 0 |
| Worker code tests | `bun test apps/worker/lib/__tests__/code-manifest.test.ts packages/graph/src/code/__tests__/repository.test.ts` | exit 0 |
| Workspace tests | `bun run test` | exit 0 |
| Lint | `bun run lint` | exit 0; no new errors |

## Scope

**In scope**:

- `packages/db/src/tables/graph.ts`
- New migration under `migrations/` created by `bun run db:generate --custom`
- `packages/db/src/__tests__/migration-compat.test.ts`
- `packages/graph/src/code/metadata.ts`
- `apps/api/src/lib/repository-url.ts`
- `apps/api/src/routes/graph.ts`
- `apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts`
- `apps/api/src/lib/__tests__/repository-url.test.ts`
- `apps/api/src/lib/graph-file-proxy.ts`
- `apps/worker/workflows/process-code-file.ts`
- `apps/worker/lib/code-manifest.ts`
- `apps/worker/lib/__tests__/code-manifest.test.ts`
- A small shared helper module if needed for external file access, preferably near existing file/code helpers.

**Out of scope**:

- Accepting arbitrary external URLs from users.
- Supporting private GitHub repositories or GitHub API tokens.
- Supporting GitLab/Bitbucket external raw links. Keep existing non-GitHub behavior internal/S3 unless product explicitly expands scope.
- Externalizing PDFs/images/audio/video/documents.
- Removing S3 support for normal uploads.
- Solving repository clone budget limits; plan 006 can coexist with later partial-clone/no-clone work.

## Git workflow

- Branch name suggestion: `advisor/006-external-github-code-files`.
- Commit message style: `feat(files): support external github code files`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add file storage origin columns

Run `bun run db:generate --custom` from the repo root. Edit the generated migration to add:

- `storage_kind text NOT NULL DEFAULT 'internal'` on `files`.
- `external_url text` on `files`.
- `external_provider text` on `files`.
- A check constraint requiring internal files to have no external URL/provider and external files to have both. Suggested shape:
  - internal: `storage_kind = 'internal' AND external_url IS NULL AND external_provider IS NULL`
  - external: `storage_kind = 'external' AND external_url IS NOT NULL AND external_provider IS NOT NULL`
- A provider check limiting `external_provider` to `github` when not null.

Update `packages/db/src/tables/graph.ts` with matching columns and checks. Keep `key` non-null.

Add migration compatibility tests in `packages/db/src/__tests__/migration-compat.test.ts` for the new columns and checks.

**Verify**: `bun test packages/db/src/__tests__/migration-compat.test.ts` → exit 0.

### Step 2: Extend code metadata and GitHub URL helpers

In `packages/graph/src/code/metadata.ts`, extend `CodeFileMetadata` parsing/serialization to preserve optional external GitHub link metadata. Validate all external fields strictly:

- `provider === "github"`
- `rawUrl` is HTTPS, host `raw.githubusercontent.com`
- `htmlUrl` is HTTPS, host `github.com`

In `apps/api/src/lib/repository-url.ts`, add helpers that only emit external links for GitHub repository URLs:

- Parse normalized repo URL `https://github.com/<owner>/<repo>.git`.
- Build immutable raw URL: `https://raw.githubusercontent.com/<owner>/<repo>/<commitSha>/<path>`.
- Build immutable HTML URL: `https://github.com/<owner>/<repo>/blob/<commitSha>/<path>`.
- Build synthetic key: `external:github:<owner>/<repo>@<commitSha>:<path>`.

Use `encodeURIComponent` only where URL path construction requires it; do not double-encode slashes in repository file paths. Add unit tests for paths with spaces and nested directories.

**Verify**: `bun test apps/api/src/lib/__tests__/repository-url.test.ts` → exit 0.

### Step 3: Stop uploading GitHub repository code files to S3

In `apps/api/src/routes/graph.ts`, change only the repository URL add path:

- For GitHub repository sources, skip `putGraphFile`.
- Insert `files` rows with:
  - `type: "code"`
  - `mimeType: "text/plain"`
  - `key: synthetic external key`
  - `storageKind: "external"`
  - `externalProvider: "github"`
  - `externalUrl: raw GitHub URL`
  - `checksum: source.checksum` if content was available during repository enumeration
  - `metadata` including `external.rawUrl` and `external.htmlUrl`
- For non-GitHub providers, keep existing S3 upload behavior unless Step 2 chose to reject externalization for them explicitly.
- Ensure cleanup code does not call `deleteFile` for external synthetic keys.

Update `apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts`:

- Existing repository URL test should expect zero S3 uploads for GitHub imports.
- Inserted file values should include `storageKind: "external"`, external provider/url, synthetic key, and code metadata with GitHub links.
- Workflow input should still enqueue `processFilesSpec` with `code: { kind: "repository" }` unless plan 005 already changed this contract.
- Duplicate checksum behavior should still skip already-present code files.

**Verify**: `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` → exit 0.

### Step 4: Add a safe external content reader for workers

Add a small helper used by `process-code-file` and `code-manifest`:

```ts
type FileContentSource =
  | { kind: "internal"; key: string }
  | { kind: "external"; provider: "github"; url: string };
```

Behavior:

- Internal source: use existing `getFile(key, env.S3_BUCKET, "text")`.
- External GitHub source: fetch `external_url` with `fetch` only after validating HTTPS host `raw.githubusercontent.com`.
- Enforce a hard response size limit consistent with repository code limits. Do not read unbounded responses.
- Require `2xx` status and text content; classify failures as file processing failures.
- Do not follow redirects to non-allowlisted hosts. If the runtime follows redirects automatically, set redirect handling explicitly and validate the final URL if the Fetch API exposes it.

Use this helper in:

- `apps/worker/workflows/process-code-file.ts` instead of direct `getFile(fileData.key, ...)`.
- `apps/worker/lib/code-manifest.ts` instead of direct `getFile(row.key, ...)`.

Add tests for:

- Internal S3 path still works.
- External GitHub URL is fetched and returned.
- Non-GitHub external URL is rejected before network fetch.
- Oversized external response is rejected.

**Verify**: `bun test apps/worker/lib/__tests__/code-manifest.test.ts` → exit 0.

### Step 5: Make file proxy external-aware

Update `apps/api/src/lib/graph-file-proxy.ts` so external GitHub files do not call S3 metadata/stream APIs:

- Load `storageKind`, `externalProvider`, `externalUrl`, `size`, `mimeType`, `name` with the file row.
- For `storageKind === "internal"`, keep existing behavior.
- For external GitHub code files, return either:
  - a `302`/`307` redirect to the immutable GitHub HTML URL from metadata for browser viewing, or
  - a proxied raw response fetched from `raw.githubusercontent.com` if current UI expects same-origin bytes.

Prefer redirecting to the GitHub HTML URL for user-facing file open/download behavior. If the existing route requires byte-range preview, use proxied raw bytes for `Range` requests and keep the same headers.

Add focused tests for external proxy behavior. Do not expose arbitrary external URLs.

**Verify**: run the relevant API test file containing graph-file-proxy tests; if no file exists, add a focused test next to existing API lib tests and run it with `bun test <new-or-existing-test-file>`.

### Step 6: Preserve source/citation behavior

Check source references that include `file_key` still work with synthetic external keys:

- `apps/api/src/lib/source-reference-record.ts`
- `apps/api/src/lib/source-reference.ts`
- `apps/api/src/routes/graph-files.ts`

If UI/API output needs an external URL, add it explicitly to the response shape rather than overloading `file_key`. Keep existing `file_key` for backward-compatible identification inside this branch's clean cutover.

**Verify**: run source-reference/graph-files tests if touched.

### Step 7: Run repo checks

**Verify**: `bun run test` → exit 0.

**Verify**: `bun run lint` → exit 0; no new errors.

## Test plan

- DB migration compatibility test for `storage_kind`, `external_url`, `external_provider`, and checks.
- Repository URL helper tests for GitHub raw/html/synthetic-key generation.
- Route test proving GitHub repository code imports insert external file rows without S3 uploads.
- Worker tests for external GitHub content fetch and allowlist rejection.
- Proxy test for external GitHub file behavior.
- Existing repository URL duplicate/checksum tests must still pass.

## Done criteria

- [ ] `files` table supports explicit internal/external origin with constraints.
- [ ] GitHub repository URL imports create external code file rows and do not upload source contents to S3.
- [ ] External rows use immutable commit SHA raw/html GitHub links generated server-side.
- [ ] Worker code processing can read external GitHub code content safely.
- [ ] Code manifest preparation can include external GitHub files without S3 reads.
- [ ] File proxy/source reference behavior is defined for external files.
- [ ] Non-GitHub repository imports keep existing behavior or are explicitly rejected with a safe message; no silent partial externalization.
- [ ] `bun test packages/db/src/__tests__/migration-compat.test.ts` exits 0.
- [ ] `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts apps/api/src/lib/__tests__/repository-url.test.ts` exits 0.
- [ ] Worker/API proxy focused tests exit 0.
- [ ] `bun run test` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- The product needs private GitHub repositories in the first version. This plan intentionally supports public immutable GitHub links only.
- The DB migration generator wants broad unrelated schema changes.
- Existing UI requires same-origin byte streaming for code files and cannot tolerate redirects to GitHub HTML URLs.
- External content fetch cannot enforce host allowlisting and response-size limits in the current runtime.
- Non-GitHub repository support must remain no-S3 in the same release; that expands provider-specific URL generation and needs a separate design decision.

## Maintenance notes

Do not hide external state only in `metadata`. Storage origin is a first-class file invariant because cleanup, proxying, worker reads, and dedupe all branch on it. Future providers should add provider-specific URL builders and allowlists; they should not accept arbitrary URLs from clients.
