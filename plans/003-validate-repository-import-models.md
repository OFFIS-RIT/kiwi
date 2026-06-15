# Plan 003: Validate repository import models before upload and enqueue

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1dea5eb77..HEAD -- apps/api/src/routes/graph.ts apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts apps/api/src/lib/graph-upload-file-type.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1dea5eb77`, 2026-06-13

## Why this matters

The regular file-upload route validates required processing models before writing files to S3 or inserting DB rows. The new repository URL route skips that validation and can create code file rows plus enqueue a workflow that later fails in the worker if required graph processing models are unavailable. Repository imports should fail before side effects, just like normal uploads.

## Current state

Relevant files:

- `apps/api/src/routes/graph.ts` — repository URL route and regular file upload route.
- `apps/api/src/lib/graph-upload-file-type.ts` — existing upload model assertion helper.
- `apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` — route tests with mocked uploads/workflows.

Repository route currently proceeds directly to uploads:

```ts
// apps/api/src/routes/graph.ts:632-646
if (repositorySources.length === 0) {
    return status(200, { ... });
}

const uploadedFiles: UploadedFile[] = [];
try {
    for (const source of repositorySources) {
        const fileId = ulid();
```

Regular upload path validates first:

```ts
// apps/api/src/routes/graph.ts:847-858
const uploadModelResult = await Result.tryPromise(async () => {
    await assertConfiguredUploadModels({
        organizationId: await getGraphOwnerModelOrganizationId({
            ownerMode: "graph",
            graphId: existingGraph.id,
        }),
        files: supportedUpload.files,
        secret: env.AUTH_SECRET,
    });
});
if (uploadModelResult.isErr()) {
    return mapGraphError(status, uploadModelResult.error);
}
```

Existing repository route test expectations:

```ts
// apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts:398-424
expect(response.status).toBe(200);
expect(insertedFileValues.map((file) => file.type)).toEqual(["code", "code"]);
expect(workflowInputs).toEqual([
    {
        graphId: "graph-1",
        fileIds: body.data.addedFiles.map((file: { id: string }) => file.id),
        processRunId: "process-run-1",
        code: { kind: "repository" },
    },
]);
```

Repo conventions:

- API routes use `Result.tryPromise` and `mapGraphError` for expected async errors.
- Tests use `bun:test` and module-level arrays to assert no side effects.
- Root verification commands available: `bun run test`, `bun run lint`. `bun run test` passed at planning time; `bun run lint` exited 0 with one existing frontend warning.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Targeted API tests | `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` | exit 0; graph route upload tests pass |
| Workspace tests | `bun run test` | exit 0; all workspace tests pass |
| Lint | `bun run lint` | exit 0; no new errors |

## Scope

**In scope**:

- `apps/api/src/routes/graph.ts`
- `apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts`
- `apps/api/src/lib/graph-upload-file-type.ts` only if a tiny shared type/helper is needed

**Out of scope**:

- Worker model resolution.
- Repository cloning limits.
- Changing normal file upload behavior.
- Creating compatibility shims for old repository import behavior.

## Git workflow

- Branch name suggestion: `advisor/003-validate-repository-import-models`.
- Commit message style: `fix(api): validate repository import models`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add a failing route test for validation-before-side-effects

In `apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts`, extend the mocks so `assertConfiguredUploadModels` can be forced to fail for the repository URL route. Add a test that:

- Sets the model assertion mock to reject with an error that `mapGraphError` can convert consistently.
- Calls `POST /graphs/graph-1/urls` with a valid repository URL.
- Asserts the response is an error.
- Asserts `uploadedFiles`, `insertedFileValues`, and `workflowInputs` are still empty.

Use the existing arrays at lines 4-21 as the side-effect oracle.

**Verify**: `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` → the new test fails before Step 2.

### Step 2: Validate repository code imports before upload

In `apps/api/src/routes/graph.ts`, after `repositorySources.length > 0` and before the `uploadedFiles` loop:

- Build a minimal list of supported upload descriptors for the repository sources with `type: "code"`.
- Call `assertConfiguredUploadModels` with `organizationId` from `getGraphOwnerModelOrganizationId({ ownerMode: "graph", graphId: existingGraph.id })` and `secret: env.AUTH_SECRET`.
- Wrap with `Result.tryPromise` and return `mapGraphError(status, error)` on failure, matching the regular upload path.

If `assertConfiguredUploadModels` intentionally only checks audio/video today, still add the call. It keeps repository imports aligned when code/text model requirements are added.

**Verify**: `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` → exit 0.

### Step 3: Run repo checks

**Verify**: `bun run test` → exit 0.

**Verify**: `bun run lint` → exit 0; no new errors.

## Test plan

- New route test for repository URL model-validation failure before upload/DB/workflow side effects.
- Existing repository URL success, duplicate, no-enqueue, and limit tests must continue passing.

## Done criteria

- [ ] Repository URL imports call the same model validation path before S3 upload and DB insert.
- [ ] Validation failure leaves `uploadedFiles`, `insertedFileValues`, and `workflowInputs` empty in the route test.
- [ ] `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- `assertConfiguredUploadModels` has been removed or changed to require browser `File` instances specifically.
- `getGraphOwnerModelOrganizationId` no longer accepts graph-owned uploads.
- The test harness cannot observe upload/DB/workflow side effects without broad rewrites.

## Maintenance notes

This keeps all graph file ingestion paths consistent. If code imports later require a text model explicitly, this route will already have the right pre-side-effect validation point.
