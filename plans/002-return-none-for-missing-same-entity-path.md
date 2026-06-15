# Plan 002: Return no path for missing same-entity path requests

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1dea5eb77..HEAD -- packages/ai/src/tools/relationship.ts packages/ai/src/__tests__/relationship-tools.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1dea5eb77`, 2026-06-13

## Why this matters

`get_path_between_entities` special-cases identical source and target IDs. It correctly queries the current graph for that entity, but when the entity is absent it still returns a one-line path with the caller-supplied ID and `Unknown` fields. That lets an invalid, deleted, or cross-graph ID look like a valid zero-hop path to the model.

## Current state

Relevant files:

- `packages/ai/src/tools/relationship.ts` — relationship graph tools.
- `packages/ai/src/__tests__/relationship-tools.test.ts` — current mocked DB tests for path/neighbour behavior.

Current behavior:

```ts
// packages/ai/src/tools/relationship.ts:449-463
if (sourceEntityId === targetEntityId) {
    const [entity] = await db
        .select({
            id: entityTable.id,
            name: entityTable.name,
            type: entityTable.type,
        })
        .from(entityTable)
        .where(and(eq(entityTable.graphId, graphId), eq(entityTable.id, sourceEntityId)))
        .limit(1);

    return [
        "## Path",
        `- ${entity?.id ?? sourceEntityId}, ${entity?.name ?? "Unknown"}, ${entity?.type ?? "Unknown"}`,
    ].join("\n");
}
```

Existing test style:

```ts
// packages/ai/src/__tests__/relationship-tools.test.ts:44-52
const { getNeighboursTool, getPathBetweenTool } = await import("../tools/relationship");

async function executeTool(tool: { execute?: (input: unknown) => Promise<string> }, input: unknown) {
    if (!tool.execute) {
        throw new Error("Tool has no execute function");
    }

    return tool.execute(input);
}
```

Repo conventions:

- Tests use `bun:test`, module mocks, and result text assertions.
- Keep tool output stable and compact; existing no-path wording is `## Path\n- none found within 5 hops`.
- Root verification commands available: `bun run test`, `bun run lint`. `bun run test` passed at planning time; `bun run lint` exited 0 with one existing frontend warning.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Targeted tests | `bun test packages/ai/src/__tests__/relationship-tools.test.ts` | exit 0; relationship tool tests pass |
| Workspace tests | `bun run test` | exit 0; all workspace tests pass |
| Lint | `bun run lint` | exit 0; no new errors |

## Scope

**In scope**:

- `packages/ai/src/tools/relationship.ts`
- `packages/ai/src/__tests__/relationship-tools.test.ts`

**Out of scope**:

- Changing BFS path depth or direction semantics.
- Changing relationship/neighbour output formats outside this missing-entity branch.
- Adding DB constraints; that is a separate pre-existing finding.

## Git workflow

- Branch name suggestion: `advisor/002-same-entity-path-not-found`.
- Commit message style: `fix(ai): return no path for missing entity`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add the failing test

Add a test in `packages/ai/src/__tests__/relationship-tools.test.ts` for `sourceEntityId === targetEntityId` where the entity lookup returns no rows:

- Push one empty select result into `selectResults`.
- Execute `getPathBetweenTool("graph-1")` with identical IDs.
- Assert the output does not contain the requested ID as a path line.
- Assert it returns a no-path response. Prefer reusing the existing wording `## Path\n- none found within 5 hops` unless you first introduce a small helper for no-path text.

**Verify**: `bun test packages/ai/src/__tests__/relationship-tools.test.ts` → the new test fails before Step 2.

### Step 2: Return no path when the graph-scoped entity is absent

In `packages/ai/src/tools/relationship.ts`, change only the same-entity branch:

- Keep the existing graph-scoped entity query.
- If `entity` is undefined, return the same no-path wording used by the normal not-found branch.
- If `entity` exists, keep the existing zero-hop output.

**Verify**: `bun test packages/ai/src/__tests__/relationship-tools.test.ts` → exit 0; new and existing relationship tests pass.

### Step 3: Run repo checks

**Verify**: `bun run test` → exit 0.

**Verify**: `bun run lint` → exit 0; no new errors.

## Test plan

- New unit test in `packages/ai/src/__tests__/relationship-tools.test.ts` for missing same-ID entity.
- Existing directed/undirected path tests must still pass.

## Done criteria

- [ ] Missing same-ID entity returns no path, not `Unknown` entity output.
- [ ] Existing same-ID entity still returns a one-line zero-hop path.
- [ ] `bun test packages/ai/src/__tests__/relationship-tools.test.ts` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- The relationship tool test harness no longer uses `selectResults` or `executeTool` as shown above.
- The tool output contract for no-path responses has changed elsewhere.
- Fixing this requires changing graph access or authorization code.

## Maintenance notes

This is defense-in-depth for model-facing tool output. Future graph tools should never turn missing graph-scoped DB rows into `Unknown` entities unless the caller explicitly requested a best-effort external ID echo.
