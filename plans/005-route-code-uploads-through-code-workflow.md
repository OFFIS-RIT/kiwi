# Plan 005: Route direct code uploads through the code workflow

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1dea5eb77..HEAD -- packages/graph/src/file-type.ts apps/api/src/lib/graph-upload-file-type.ts apps/api/src/routes/graph.ts apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts apps/worker/workflows/process-file.ts apps/worker/workflows/process-files-spec.ts apps/worker/workflows/process-code-file.ts packages/graph/src/code/file-path.ts packages/graph/src/__tests__`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1dea5eb77`, 2026-06-13

## Why this matters

The branch adds a `code` graph file type and a dedicated `process-code-file` workflow, but ordinary uploads and archive-expanded source files still infer `.ts/.tsx/.js/.jsx/.mts/.cts` as `text`. Even if inference is fixed, the parent workflow currently routes all children through the code workflow only when the whole batch has `input.code`. Users uploading source files directly would miss code-specific graph extraction, while mixed batches risk being routed all-code or all-generic.

## Current state

Relevant files:

- `packages/graph/src/file-type.ts` — declares `code` but does not infer code extensions.
- `packages/graph/src/code/file-path.ts` — existing supported-code path predicate used by repository URL imports.
- `apps/api/src/lib/graph-upload-file-type.ts` — direct upload type inference.
- `apps/api/src/routes/graph.ts` — file and repository URL routes enqueue `processFilesSpec`.
- `apps/worker/workflows/process-file.ts` — parent workflow chooses child workflow.
- `apps/worker/workflows/process-code-file.ts` — code-file workflow already handles rows without repository metadata using fallbacks.

Current file type state:

```ts
// packages/graph/src/file-type.ts:1-21
export const GRAPH_FILE_TYPES = [
    "pdf",
    ...
    "toml",
    "code",
    "text",
] as const;
```

```ts
// packages/graph/src/file-type.ts:52-187
export function inferGraphFileType(file: Pick<File, "name" | "type">): GraphFileType {
    ...
    if (mime === "application/toml" || mime === "text/toml" || ext === "toml") {
        return "toml";
    }

    return "text";
}
```

Direct upload caller:

```ts
// apps/api/src/lib/graph-upload-file-type.ts:23-31
export function inferSupportedUploadedFiles(files: FileWithChecksum[]): UploadFileTypeCheck {
    const typedFiles: SupportedFileWithChecksum[] = [];

    for (const fileWithChecksum of files) {
        const type = inferGraphFileType(fileWithChecksum.file);
        typedFiles.push({ ...fileWithChecksum, type });
    }

    return { ok: true, files: typedFiles };
}
```

Current workflow routing is batch-wide:

```ts
// apps/worker/workflows/process-file.ts:47-56
function fileProcessingWorkflow(input: { graphId: string; code?: { kind: "repository" } }, fileId: string, codeManifestKey?: string) {
    return input.code
        ? {
              spec: processCodeFile.spec,
              input: {
                  graphId: input.graphId,
                  fileId,
                  ...(codeManifestKey ? { codeManifestKey } : {}),
              },
          }
```

Code workflow fallback for non-repository metadata:

```ts
// apps/worker/workflows/process-code-file.ts:34-40
return {
    fileId: file.id,
    repositoryUrl: metadata?.repositoryUrl ?? `graph:${file.graphId}`,
    repositoryName: metadata?.repositoryName ?? "code",
    commitSha: metadata?.commitSha ?? "unknown",
    path: metadata?.path ?? file.name,
    content,
};
```

Repo conventions:

- Keep changes minimal and local.
- Use existing `isSupportedCodePath` rather than duplicating extension lists.
- API route tests assert workflow inputs using arrays in `graph-archive-upload-route.test.ts`.
- Root verification commands available: `bun run test`, `bun run lint`. `bun run test` passed at planning time; `bun run lint` exited 0 with one existing frontend warning.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Graph tests | `bun test packages/graph/src` | exit 0 |
| API route tests | `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` | exit 0 |
| Worker tests | `bun test apps/worker` | exit 0 |
| Workspace tests | `bun run test` | exit 0 |
| Lint | `bun run lint` | exit 0; no new errors |

## Scope

**In scope**:

- `packages/graph/src/file-type.ts`
- `packages/graph/src/code/file-path.ts` only if exporting/reusing a helper requires a small adjustment
- `apps/api/src/lib/graph-upload-file-type.ts`
- `apps/api/src/routes/graph.ts`
- `apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts`
- `apps/worker/workflows/process-file.ts`
- `apps/worker/workflows/process-files-spec.ts`
- `apps/worker/workflows/process-code-file.ts` only if its input schema needs a small metadata/manfiest adjustment
- Existing tests under `packages/graph/src/__tests__` or `packages/graph/src/code/__tests__`

**Out of scope**:

- Adding support for languages beyond the existing `isSupportedCodePath` set.
- Changing repository URL cloning/loading behavior.
- Changing code graph AST extraction semantics.
- Rewriting process run status handling.

## Git workflow

- Branch name suggestion: `advisor/005-route-code-uploads-through-code-workflow`.
- Commit message style: `fix(graph): route code uploads through code workflow`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Classify supported source files as `code`

Update `inferGraphFileType` so paths accepted by `isSupportedCodePath` return `code` before falling back to `text`. Keep structured data formats (`json`, `csv`, `xml`, `yaml`, `toml`) classified as their existing types, not code.

Add tests for at least:

- `src/index.ts` → `code`
- `src/component.tsx` → `code`
- `src/script.js` → `code`
- `README.md` → `text` or existing behavior
- `data.json` remains `json`

**Verify**: `bun test packages/graph/src` → exit 0; file type tests pass.

### Step 2: Route child workflows by actual file type, not a batch-wide flag

Change `apps/worker/workflows/process-file.ts` so `processFiles` can process mixed batches safely:

- Query the selected file IDs and their `type` once near the start of the parent workflow, or inside `fileProcessingWorkflow` via a small precomputed map.
- Use `processCodeFile` only for files whose DB `type` is `code`.
- Use `processFile` for all other file types.
- Keep `codeManifestKey` optional and pass it only to code-file child workflows.
- Preserve repository URL behavior: repository imports still prepare a shared manifest and code files still receive it.

Avoid a batch-wide `input.code` switch for child selection. Keeping the `code` field as a hint for manifest preparation is acceptable; removing it is acceptable only if all API callers and tests are migrated cleanly.

**Verify**: `bun test apps/worker` → exit 0.

### Step 3: Enqueue direct code uploads without breaking mixed file batches

Update `apps/api/src/routes/graph.ts` only if needed after Step 2:

- Direct file uploads should continue enqueueing `processFilesSpec` with all added file IDs.
- Repository URL uploads should continue passing enough information to prepare a repository manifest.
- Mixed upload batches containing one `.ts` file and one non-code file must not route the non-code file through `processCodeFile`.

Add or extend route tests in `apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` for direct or archive-expanded code files. Assert code files are inserted with `type: "code"`. If the test harness can observe child workflow selection only at parent input level, cover the worker selection in worker tests instead.

**Verify**: `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` → exit 0.

### Step 4: Run repo checks

**Verify**: `bun run test` → exit 0.

**Verify**: `bun run lint` → exit 0; no new errors.

## Test plan

- Graph/file-type test for supported code extensions and structured-format precedence.
- Worker test for mixed batch child workflow selection: code file uses `processCodeFile`, text/PDF/etc. file uses `processFile`.
- API route test that direct or archive-expanded `.ts` files are stored as `code`.
- Existing repository URL tests must still assert `code: { kind: "repository" }` or the new equivalent manifest hint.

## Done criteria

- [ ] Supported TypeScript/JavaScript source paths infer `GraphFileType` `code`.
- [ ] Direct and archive-expanded code uploads are inserted with `type: "code"`.
- [ ] Mixed batches route code files to `processCodeFile` and non-code files to `processFile`.
- [ ] Repository URL imports still build repository metadata and shared manifests.
- [ ] `bun test packages/graph/src` exits 0.
- [ ] `bun test apps/worker` exits 0.
- [ ] `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- `isSupportedCodePath` accepts extensions that should remain structured document types in product behavior.
- OpenWorkflow cannot dispatch child workflows dynamically based on a precomputed type map.
- Fixing mixed-batch routing requires changing process-run schema or adding new persistent status values.

## Maintenance notes

The important invariant after this plan: file type decides child workflow, repository metadata only improves cross-file code graph quality. Do not reintroduce a batch-wide switch that assumes every file in one upload batch has the same processing path.
