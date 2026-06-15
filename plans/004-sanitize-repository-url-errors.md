# Plan 004: Sanitize repository URL loader errors returned to clients

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1dea5eb77..HEAD -- apps/api/src/lib/repository-url.ts apps/api/src/routes/graph.ts apps/api/src/lib/__tests__/repository-url.test.ts apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `1dea5eb77`, 2026-06-13

## Why this matters

The repository URL loader rejects failed git commands with raw stderr. The route then returns `error.message` verbatim to the client. That leaks implementation-specific git/provider output and makes the API contract depend on git wording instead of stable KIWI error codes/messages.

## Current state

Relevant files:

- `apps/api/src/lib/repository-url.ts` — URL normalization, git clone, file loading.
- `apps/api/src/routes/graph.ts` — maps repository loader errors to HTTP responses.
- `apps/api/src/lib/__tests__/repository-url.test.ts` — URL helper unit tests.
- `apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` — route tests for repository URL error mapping.

Raw git stderr source:

```ts
// apps/api/src/lib/repository-url.ts:194-197
finish(() => {
    const stderrText = Buffer.concat(stderr).toString("utf8").trim();
    reject(new Error(stderrText || "Repository git command failed"));
});
```

Verbatim HTTP response mapping:

```ts
// apps/api/src/routes/graph.ts:109-116
function repositoryUrlErrorResponse(statusFn: (code: number, body: unknown) => unknown, error: unknown) {
    const message = error instanceof Error ? error.message : "Unsupported repository URL";

    if (message.includes("too many") || message.includes("too much")) {
        return statusFn(413, errorResponse(message, API_ERROR_CODES.UPLOAD_LIMIT_EXCEEDED));
    }

    return statusFn(400, errorResponse(message, API_ERROR_CODES.UNSUPPORTED_FILE_TYPE));
}
```

Existing tests cover limits but not generic git failures:

```ts
// apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts:478-493
test("maps repository loader limits to upload limit responses", async () => {
    repositoryLoadMode = "limit-error";
    ...
    expect(response.status).toBe(413);
    expect(body.code).toBe("UPLOAD_LIMIT_EXCEEDED");
    expect(uploadedFiles).toEqual([]);
    expect(workflowInputs).toEqual([]);
});
```

Repo conventions:

- API error responses use `errorResponse(message, API_ERROR_CODES.X)`.
- Keep raw operational details in server logs, not response bodies.
- Never reproduce secret values in tests or fixtures.
- Root verification commands available: `bun run test`, `bun run lint`. `bun run test` passed at planning time; `bun run lint` exited 0 with one existing frontend warning.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Repository helper tests | `bun test apps/api/src/lib/__tests__/repository-url.test.ts` | exit 0 |
| Route tests | `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` | exit 0 |
| Workspace tests | `bun run test` | exit 0 |
| Lint | `bun run lint` | exit 0; no new errors |

## Scope

**In scope**:

- `apps/api/src/lib/repository-url.ts`
- `apps/api/src/routes/graph.ts`
- `apps/api/src/lib/__tests__/repository-url.test.ts`
- `apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts`

**Out of scope**:

- Changing allowed hosts or clone strategy.
- Adding aggregate repository import budgets.
- Logging secret values or raw credentials.
- Changing 413 behavior for known file/byte/count limits.

## Git workflow

- Branch name suggestion: `advisor/004-sanitize-repository-url-errors`.
- Commit message style: `fix(api): sanitize repository import errors`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Introduce typed repository loader errors

In `apps/api/src/lib/repository-url.ts`, add a small exported error class or discriminated helper so callers can distinguish:

- validation errors with safe messages (`Repository URL must use HTTPS`, unsupported host, credentials, non-root URL),
- limit errors with safe messages (`too many`, `too much`),
- git/load failures with a generic safe client message.

Do not expose raw stderr via `.message` for git command failures. If retaining stderr for logs, store it in a non-enumerable field or `cause`, and do not serialize it into responses.

**Verify**: `bun test apps/api/src/lib/__tests__/repository-url.test.ts` → exit 0.

### Step 2: Map only safe messages to responses

Update `repositoryUrlErrorResponse` in `apps/api/src/routes/graph.ts`:

- Return 413 only for typed limit errors.
- Return 400 and `UNSUPPORTED_FILE_TYPE` for invalid/unsupported repository inputs with safe validation messages.
- Return 400 and a generic message such as `Repository could not be loaded` for git/provider/load failures.
- If raw stderr is logged, log server-side only and keep values out of tests/plans.

**Verify**: `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` → existing limit test still passes.

### Step 3: Add route coverage for generic git failure sanitization

Extend `apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` with a repository loader mode that throws an error representing raw git stderr. Assert:

- Response status is 400.
- Response code is `UNSUPPORTED_FILE_TYPE`.
- Response message is the generic sanitized text.
- The raw stderr string does not appear in the response body.
- `uploadedFiles` and `workflowInputs` stay empty.

**Verify**: `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` → exit 0.

### Step 4: Run repo checks

**Verify**: `bun run test` → exit 0.

**Verify**: `bun run lint` → exit 0; no new errors.

## Test plan

- Unit tests for repository URL validation should keep safe validation messages.
- Route test for generic git failure must prove raw stderr is not returned.
- Existing limit-error route test must continue returning 413.

## Done criteria

- [ ] Raw git stderr cannot flow into `error.message` returned by `repositoryUrlErrorResponse`.
- [ ] Limit errors still return `UPLOAD_LIMIT_EXCEEDED` with safe limit text.
- [ ] Generic clone/load failures return a stable sanitized client message.
- [ ] `bun test apps/api/src/lib/__tests__/repository-url.test.ts` exits 0.
- [ ] `bun test apps/api/src/routes/__tests__/graph-archive-upload-route.test.ts` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- Existing clients/tests intentionally depend on exact raw git stderr in the HTTP response.
- Typed error handling requires changing shared API error contracts outside the in-scope files.
- You encounter credentials in logs or tests; do not copy them, report the location only.

## Maintenance notes

Keep provider and git diagnostics observable in server logs, but keep client responses stable. This makes future clone strategy changes possible without breaking API consumers.
