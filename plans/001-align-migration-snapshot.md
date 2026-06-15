# Plan 001: Align the relationship migration snapshot with the schema

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1dea5eb77..HEAD -- packages/db/src/tables/graph.ts migrations/20260613184716_sturdy_triton packages/db/src/__tests__/migration-compat.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `1dea5eb77`, 2026-06-13

## Why this matters

The branch adds `relationships.kind` and `relationships.directed` in both the Drizzle schema and the SQL migration, but the migration snapshot does not contain those columns. Drizzle uses snapshots as migration-generation state. If this lands stale, the next generated migration can diff from the wrong schema state and re-emit already-applied relationship column changes.

## Current state

Relevant files:

- `packages/db/src/tables/graph.ts` — source Drizzle schema for `relationships`.
- `migrations/20260613184716_sturdy_triton/migration.sql` — SQL migration for the branch.
- `migrations/20260613184716_sturdy_triton/snapshot.json` — generated Drizzle snapshot that is currently stale.
- `packages/db/src/__tests__/migration-compat.test.ts` — migration compatibility tests.

Current schema excerpt:

```ts
// packages/db/src/tables/graph.ts:245-250
graphId: text("graph_id")
    .notNull()
    .references(() => graphTable.id, { onDelete: "cascade" }),
kind: text("kind").notNull().default("RELATED"),
directed: boolean("directed").notNull().default(false),
rank: doublePrecision("rank").notNull().default(0),
```

Current migration excerpt:

```sql
-- migrations/20260613184716_sturdy_triton/migration.sql:1-2
ALTER TABLE "relationships" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'RELATED' NOT NULL;
ALTER TABLE "relationships" ADD COLUMN IF NOT EXISTS "directed" boolean DEFAULT false NOT NULL;
```

Current stale snapshot excerpt:

```json
// migrations/20260613184716_sturdy_triton/snapshot.json:3008-3021
"name": "graph_id",
"entityType": "columns",
"schema": "public",
"table": "relationships"
},
{
"type": "double precision",
"notNull": true,
"default": "0",
"name": "rank",
"table": "relationships"
```

Repo conventions:

- Use Bun from the repo root.
- Do not run `bun run db:migrate`.
- Do not hand-create a new migration. This plan fixes the existing branch migration metadata.
- Root verification commands available: `bun run test`, `bun run lint`. `bun run test` passed at planning time; `bun run lint` exited 0 with one existing frontend warning in `apps/frontend/components/theme/ThemePresetScript.tsx`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | `bun run test` | exit 0; all workspace tests pass |
| Lint | `bun run lint` | exit 0; existing warning may remain, no new errors |

## Scope

**In scope**:

- `migrations/20260613184716_sturdy_triton/snapshot.json`
- `packages/db/src/__tests__/migration-compat.test.ts`

**Out of scope**:

- Creating another migration directory.
- Running `bun run db:migrate`.
- Changing relationship application code.
- Editing older migration snapshots.

## Git workflow

- Branch name suggestion: `advisor/001-align-migration-snapshot`.
- Commit message style from repo history: Conventional Commits, e.g. `fix(db): align relationship migration snapshot`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add the missing snapshot columns

Update `migrations/20260613184716_sturdy_triton/snapshot.json` so the `relationships` table has both columns between `graph_id` and `rank`, matching schema/migration semantics:

- `kind`: type `text`, `notNull: true`, default `'RELATED'` in the snapshot's existing default representation for string defaults.
- `directed`: type `boolean`, `notNull: true`, default `false` in the snapshot's existing default representation for boolean defaults.

Prefer regenerating the snapshot with the repo's Drizzle workflow if that produces only this snapshot correction. If regeneration wants to create another migration or broad unrelated changes, stop and hand-edit only these two column entries to match the snapshot format around nearby columns.

**Verify**: `bun run test --filter @kiwi/db` → exit 0; DB package tests pass.

### Step 2: Add a compatibility assertion for the snapshot

In `packages/db/src/__tests__/migration-compat.test.ts`, extend the existing migration compatibility coverage for `20260613184716_sturdy_triton` so it checks that `snapshot.json` contains `relationships.kind` and `relationships.directed`. Keep this as a metadata regression test; do not assert fragile line numbers.

**Verify**: `bun run test --filter @kiwi/db` → exit 0; the new assertion fails before Step 1 and passes after Step 1.

### Step 3: Run repo checks

Run the standard read-only checks from the repo root.

**Verify**: `bun run test` → exit 0; all tests pass.

**Verify**: `bun run lint` → exit 0; no new errors.

## Test plan

- Extend `packages/db/src/__tests__/migration-compat.test.ts`.
- Cover both new relationship columns in `snapshot.json`.
- Do not add a migration execution test; this is a snapshot/schema parity regression.

## Done criteria

- [ ] `migrations/20260613184716_sturdy_triton/snapshot.json` contains `relationships.kind` and `relationships.directed` with defaults/nullability matching `graph.ts` and `migration.sql`.
- [ ] `bun run test --filter @kiwi/db` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- Regenerating the snapshot creates a new migration directory or changes unrelated snapshots.
- The live schema/migration excerpts no longer match the current-state snippets above.
- The snapshot format for defaults is unclear after comparing nearby string/boolean defaults.

## Maintenance notes

Reviewers should check this before any follow-up Drizzle migration is generated. A stale snapshot is cheap to fix now and expensive to unwind after another migration is generated on top of it.
