# Plan 007: Version code sources with `validUntil` so graph tools use only the latest repository snapshot

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1dea5eb77..HEAD -- packages/db/src/tables/graph.ts apps/api/src/routes/graph.ts apps/api/src/lib/graph-route.ts apps/worker/lib/save-graph.ts apps/worker/lib/regenerate-descriptions.ts apps/worker/workflows/process-file.ts apps/worker/workflows/process-code-file.ts packages/ai/src/tools/source.ts packages/ai/src/tools/entity.ts apps/api/src/lib/source-reference.ts apps/api/src/lib/chat.ts apps/api/src/lib/team-chat.ts apps/api/src/lib/graph-file-proxy.ts packages/graph/src/code/identity.ts packages/graph/src/code/repository.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `005-route-code-uploads-through-code-workflow`, `006-support-external-github-code-files`
- **Category**: correctness / source history
- **Planned at**: commit `1dea5eb77`, 2026-06-13

## Why this matters

Repository code imports are snapshots. Re-uploading the same repository at a newer commit should make the graph represent the latest code, not append new snippets to the old function evidence forever.

Today source rows are append-only. When a function changes, the canonical deduped entity receives both old and new sources; description regeneration reads all sources for the entity, so the function description can mix stale and latest code. When a function is removed, the old entity can remain active because nothing invalidates its sources.

The target invariant: **code entities and relationships use only current valid sources; historical sources stay in the database with `validUntil` for future change-history features.**

## Current state

Relevant files:

- `packages/db/src/tables/graph.ts` — `sources` has `active` but no validity window.
- `apps/worker/lib/save-graph.ts` — inserts new sources and dedupes entities/relationships, but does not invalidate old sources.
- `apps/worker/lib/regenerate-descriptions.ts` — regenerates descriptions from every linked source, not only current sources.
- `packages/ai/src/tools/source.ts` — graph source tools filter `sources.active = true` but not source validity.
- `packages/ai/src/tools/entity.ts` — file-scoped entity listing checks for any linked source, not only valid sources.
- `apps/api/src/lib/source-reference.ts`, `apps/api/src/lib/chat.ts`, `apps/api/src/lib/team-chat.ts` — source ID lookup paths do not reject invalid sources.
- `apps/api/src/routes/graph.ts` and `apps/api/src/lib/graph-route.ts` — repository imports insert files by checksum and do not model a repository update/supersession.

Current source schema:

```ts
// packages/db/src/tables/graph.ts:291-314
export const sourcesTable = pgTable.withRLS(
    "sources",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        entityId: text("entity_id").references(() => entityTable.id, { onDelete: "cascade" }),
        relationshipId: text("relationship_id").references(() => relationshipTable.id, { onDelete: "cascade" }),
        textUnitId: text("text_unit_id")
            .notNull()
            .references(() => textUnitTable.id, { onDelete: "cascade" }),
        active: boolean("active").notNull().default(false),
        description: text("description").notNull(),
        sourceChunkIds: json("source_chunk_ids")
            .$type<number[]>()
            .notNull()
            .default(sql`'[]'::json`),
        embedding: vector("embedding", { dimensions: 4096 }).notNull(),
        searchTsv: tsvector("search_tsv").generatedAlwaysAs(() => weightedTsvectorGenerated(["description"])),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
```

Current save behavior:

```ts
// apps/worker/lib/save-graph.ts:118-143
const sourceRows = [
    ...graph.entities.flatMap((entity) =>
        entity.sources.map((source) => ({
            id: source.id,
            entityId: entity.id,
            relationshipId: null,
            textUnitId: source.unitId,
            active: false,
            description: source.description,
            sourceChunkIds: source.sourceChunkIds ?? [],
            embedding: EMPTY_VECTOR_SQL,
        }))
    ),
    ...graph.relationships.flatMap((relationship) =>
        relationship.sources.map((source) => ({
            id: source.id,
            entityId: null,
            relationshipId: relationship.id,
            textUnitId: source.unitId,
            active: false,
            description: source.description,
            sourceChunkIds: source.sourceChunkIds ?? [],
            embedding: EMPTY_VECTOR_SQL,
        }))
    ),
];
```

```ts
// apps/worker/lib/save-graph.ts:199-200
for (const chunk of chunkItems(rows.sourceRows)) {
    await tx.insert(sourcesTable).values(chunk).onConflictDoNothing();
}
```

Current description regeneration uses stale sources too:

```ts
// apps/worker/lib/regenerate-descriptions.ts:148-163
const sources = await db
    .select({
        id: sourcesTable.id,
        entityId: sourcesTable.entityId,
        description: sourcesTable.description,
    })
    .from(sourcesTable)
    .where(
        and(
            inArray(
                sourcesTable.entityId,
                entities.map((entity) => entity.id)
            ),
            isNotNull(sourcesTable.entityId)
        )
    );
```

Current source tool validity is only `active`:

```ts
// packages/ai/src/tools/source.ts:205-207
if (terms.length === 0) {
    const clauses = [eq(sourcesTable.active, true), eq(filesTable.graphId, graphId)];
```

```ts
// packages/ai/src/tools/source.ts:306-310
from sources source
inner join text_units text_unit on text_unit.id = source.text_unit_id
inner join files file on file.id = text_unit.file_id
where source.active = true
  and file.graph_id = ${graphId}
```

Current code identity makes dedupe necessary across commits:

```ts
// packages/graph/src/code/identity.ts:8-13
export function fileEntityName(file: Pick<CodeRepositoryFile, "repositoryUrl" | "path">): string {
    return `${file.repositoryUrl}:${file.path}`;
}

export function fileEntityId(repositoryUrl: string, commitSha: string, filePath: string): string {
    return stableId("code_file", repositoryUrl, commitSha, filePath);
}
```

The entity name excludes commit, but the generated ID includes commit. `save-graph.ts` dedupes entities by graph/type/normalized name and rewrites new sources to the canonical active entity, so changed functions append new sources to the old canonical entity unless old sources are invalidated.

Repo conventions:

- Run commands from the repo root.
- Do not run `bun run db:migrate`.
- Do not hand-create migrations first; for custom/manual migrations run `bun run db:generate --custom` before editing.
- Use Drizzle schema + migration compatibility tests for schema changes.
- Keep changes local; prefer shared helpers for repeated validity predicates.
- Root verification commands available: `bun run test`, `bun run lint`. At planning time, `bun run test` passed; `bun run lint` exited 0 with one existing frontend warning.

## Design decision

Add `sources.valid_until` as the history boundary. Do not delete old code sources.

Definition:

- A **current source** is `sources.active = true AND sources.valid_until IS NULL`.
- A **pending current source** is `sources.active = false AND sources.valid_until IS NULL` and exists only between graph save and description/embedding activation.
- An **historical source** has `sources.valid_until IS NOT NULL`. Historical rows keep their text unit, chunk IDs, description, embedding, and active flag for future history queries, but current graph tools ignore them.

This plan keeps `entities` and `relationships` as the current graph surface:

- If a subject has one or more current sources, regenerate its description from current sources only and keep it active.
- If a code subject has no current sources after a repository update, deactivate it so graph tools stop returning removed functions/edges.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Generate migration scaffold | `bun run db:generate --custom` | creates a new migration scaffold to edit |
| DB migration tests | `bun test packages/db/src/__tests__/migration-compat.test.ts` | exit 0 |
| Worker focused tests | `bun test apps/worker/lib apps/worker/workflows` | exit 0 |
| AI tool tests | `bun test packages/ai/src/__tests__` | exit 0 |
| API source tests | `bun test apps/api/src/lib/__tests__ apps/api/src/routes/__tests__` | exit 0 |
| Workspace tests | `bun run test` | exit 0 |
| Lint | `bun run lint` | exit 0; no new errors |

## Scope

**In scope**:

- `packages/db/src/tables/graph.ts`
- New migration under `migrations/` created by `bun run db:generate --custom`
- `packages/db/src/__tests__/migration-compat.test.ts`
- `apps/worker/lib/save-graph.ts`
- `apps/worker/lib/regenerate-descriptions.ts`
- `apps/worker/workflows/process-file.ts`
- `apps/worker/workflows/process-code-file.ts`
- `apps/api/src/routes/graph.ts`
- `apps/api/src/lib/graph-route.ts`
- `packages/ai/src/tools/source.ts`
- `packages/ai/src/tools/entity.ts`
- `packages/ai/src/tools/correction.ts` if corrections can target stale source IDs
- `apps/api/src/lib/source-reference.ts`
- `apps/api/src/lib/chat.ts`
- `apps/api/src/lib/team-chat.ts`
- Tests for the touched modules

**Out of scope**:

- Building the webhook integration.
- Building a user-facing history UI.
- Arbitrary non-code document source versioning.
- Changing source IDs already emitted in old chat messages beyond making invalid IDs no longer resolve as current citations.
- Rewriting code entity identity to remove commit SHA from IDs. Dedupe by name remains the current bridge across commits.

## Git workflow

- Branch name suggestion: `advisor/007-version-code-sources-valid-until`.
- Commit message style: `feat(graph): version code sources with validUntil`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add `sources.valid_until`

Run `bun run db:generate --custom` from the repo root. Edit the generated migration to add:

```sql
ALTER TABLE "sources" ADD COLUMN "valid_until" timestamp with time zone;
```

Update `packages/db/src/tables/graph.ts`:

- Add `validUntil: timestamp("valid_until", { withTimezone: true, mode: "date" })` to `sourcesTable`.
- Keep existing `active` semantics; do not replace it with `validUntil`.
- Add indexes for current source lookups. Suggested indexes:
  - `sources_entity_current_id_idx` on `(entity_id, active, id)` where `valid_until IS NULL`.
  - `sources_relationship_current_id_idx` on `(relationship_id, active, id)` where `valid_until IS NULL`.
  - `sources_current_id_idx` on `(active, id)` where `valid_until IS NULL`.

Extend `packages/db/src/__tests__/migration-compat.test.ts` so the migration and snapshot include `sources.valid_until` and the current-source indexes.

**Verify**: `bun test packages/db/src/__tests__/migration-compat.test.ts` → exit 0.

### Step 2: Centralize the current-source predicate

Add a tiny helper where it can be imported without cycles. Preferred options:

- `packages/db/src/source-validity.ts`, exporting Drizzle predicates/helpers, or
- local helpers in each package if the DB package should avoid query helpers.

The helper must express:

```ts
source.active = true AND source.validUntil IS NULL
```

For raw SQL in `packages/ai/src/tools/source.ts`, use the exact SQL predicate:

```sql
source.active = true AND source.valid_until IS NULL
```

Do not use only `active` in any current source query after this plan.

**Verify**: no command yet; this step is covered by later tests.

### Step 3: Make repository imports represent a latest snapshot

Update the repository URL add flow so uploading the same repository is an update, not an append-only import.

In `apps/api/src/routes/graph.ts` / `apps/api/src/lib/graph-route.ts`:

- Detect repository scope by normalized `repository.url`.
- For repository imports, do not skip files solely because their checksum already exists from a previous commit of the same repository. Latest snapshots need rows for unchanged files too, especially because external GitHub URLs include the latest commit SHA.
- Create a new file row for every supported file in the latest repository snapshot.
- Keep current duplicate protection for repeated URLs within the same request.
- Mark older non-deleted code file rows for the same graph + repository URL as `deleted = true` only after the new file rows and process run have been committed successfully. Do not call the delete-file workflow; old text units and sources must remain for history.
- If a DB transaction fails, do not mark old files deleted and clean up only internal S3 uploads.

Implementation hint: repository URL is currently only inside `files.metadata`. If querying JSON text is too brittle, add a small repository import manifest table or include a stable repository scope field in code file metadata parsing before building the SQL. Keep this plan scoped to repository code imports only.

**Verify**: route tests should prove a second import of `https://github.com/acme/widgets` creates new file rows for the latest commit and marks previous repository file rows deleted without deleting their text units/sources.

### Step 4: Invalidate superseded sources when a code subject is refreshed

Update `apps/worker/lib/save-graph.ts` after inserts and dedupe have rewritten new sources to canonical entity/relationship IDs:

- Capture inserted source IDs from `rows.sourceRows`.
- Query those inserted source rows after dedupe to get their canonical `entityId` / `relationshipId` and the file metadata of their text unit.
- For inserted sources whose file is `type = 'code'`, set `valid_until = NOW()` on older current code sources for the same canonical `entityId` or `relationshipId`, excluding the newly inserted source IDs.
- Scope invalidation to code sources only by joining `sources -> text_units -> files` and requiring `files.file_type = 'code'`.
- Do not invalidate sources from PDFs/docs/manual suggestions that happen to mention the same entity.

This handles the main case: same function or relationship appears in a changed file. The new source becomes the only current source for that function/edge; old snippets remain historical.

**Verify**: add a worker/lib test that saves two code graphs for the same function with different snippets. After the second save + description activation, the first source has `validUntil` set and the second source remains current.

### Step 5: Invalidate removed functions/edges at repository update finalization

A function removed from the latest repository snapshot has no new source, so Step 4 will not touch it. Add a repository update finalizer in the parent code batch flow (`apps/worker/workflows/process-file.ts`) after all child code workflows for a repository snapshot complete successfully:

- Identify repository URL and commit SHA for the current batch from code file metadata.
- Identify the latest file IDs in this process run.
- Find current code sources for the same graph + repository URL whose text unit belongs to older file rows not in the latest file ID set.
- Set `valid_until = NOW()` for those sources.
- Collect affected entity and relationship IDs.
- Trigger `updateDescriptionsSpec` for affected IDs so removed functions/edges are deactivated or descriptions rebuilt from remaining current sources.

If any child code workflow fails terminally, do not run the repository finalizer. Keep old sources current until a complete latest snapshot is available.

**Verify**: add a process-files workflow test or lower-level finalizer test covering a repository update where `old.ts#removedFunction` has no counterpart in the new file set; after finalization its source is invalid and the entity is inactive or absent from source tools.

### Step 6: Regenerate descriptions from current sources only

Update `apps/worker/lib/regenerate-descriptions.ts`:

- Select only `sources.validUntil IS NULL` for entity and relationship source lists.
- `updateSourceEmbeddingsBatch` should only activate source IDs that still have `validUntil IS NULL`.
- If an entity/relationship has zero current sources:
  - Set `active = false`.
  - Clear or retain description consistently. Prefer clearing to `""` and setting embedding to `EMPTY_VECTOR_SQL` if the schema requires a non-null vector.
  - Do not call the LLM for it.
- If it has current sources, regenerate from those current sources only and set active true.

**Verify**: add tests for:

- Entity description after update includes only the new source description.
- Entity with only invalidated sources becomes inactive.
- Relationship equivalent behavior.

### Step 7: Filter graph tools and citation lookups to current sources

Update current-source consumers:

- `packages/ai/src/tools/source.ts`
  - `get_entity_sources`, `get_relationship_sources`, semantic source search, and `get_source_file_metadata` must require `source.valid_until IS NULL` plus `source.active = true`.
  - Add `file.deleted = false` where appropriate so superseded repository file rows do not leak through current tools.
- `packages/ai/src/tools/entity.ts`
  - File-scoped `list_entities` subquery must require current sources, not any historical source.
- `packages/ai/src/tools/correction.ts`
  - Reject correction suggestions for historical sources.
- `apps/api/src/lib/source-reference.ts`
  - `loadSourceReference` and batch loading must reject historical sources for normal citation resolution.
- `apps/api/src/lib/chat.ts` and `apps/api/src/lib/team-chat.ts`
  - Source ID lookups used by chat citation normalization must reject historical sources.

Do not add history-query behavior in this plan. Historical sources should be retained but invisible to current tools.

**Verify**: add/extend tests proving an invalidated source ID is not returned by source tools and does not resolve as a current citation.

### Step 8: Keep history rows intact

Confirm invalidation does not delete:

- `sources`
- `text_units`
- old `files` rows for code snapshots

Older file rows may be marked `deleted = true` for current file-list behavior, but text/source rows stay available for future history. Do not call `deleteProjectFile` for superseded repository snapshots.

**Verify**: in tests, after repository update, old source/text unit rows still exist with `validUntil` set.

### Step 9: Run repo checks

**Verify**: `bun run test` → exit 0.

**Verify**: `bun run lint` → exit 0; no new errors.

## Test plan

Add focused tests before broad checks:

1. DB migration compatibility:
   - `sources.valid_until` exists in migration and snapshot.
   - Current-source indexes exist.
2. Save graph source invalidation:
   - Same code function, changed snippet → old source `validUntil` set, new source current.
   - Same relationship, changed snippet → old source `validUntil` set, new source current.
3. Repository update finalization:
   - Removed function's only source is invalidated when a full newer snapshot succeeds.
   - Finalizer does not run when any child workflow fails.
4. Description regeneration:
   - Descriptions use only current sources.
   - Entity/relationship with no current sources becomes inactive.
5. Tool filtering:
   - `get_entity_sources` and `get_relationship_sources` never return invalidated sources.
   - `get_source_file_metadata` ignores invalidated source IDs.
   - File-scoped entity listing ignores invalidated sources.
6. API citation/source reference:
   - Invalidated source IDs do not resolve as current citations.

## Done criteria

- [ ] `sources.valid_until` exists in Drizzle schema, migration SQL, and snapshot.
- [ ] Current-source queries require `active = true AND valid_until IS NULL`.
- [ ] Re-uploading a repository creates a latest snapshot rather than deduping away unchanged files by checksum alone.
- [ ] Changed functions invalidate previous code sources for the canonical function entity and store new current sources.
- [ ] Removed functions/edges from a successful latest repository snapshot stop appearing in graph tools.
- [ ] Entity/relationship descriptions are regenerated from current sources only.
- [ ] Historical source/text rows remain in the database for future history features.
- [ ] Current graph source tools and citation resolvers ignore invalidated sources.
- [ ] `bun test packages/db/src/__tests__/migration-compat.test.ts` exits 0.
- [ ] Worker focused tests exit 0.
- [ ] AI/API source focused tests exit 0.
- [ ] `bun run test` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- Source history must preserve old GitHub commit URLs per source but the current schema only stores repository metadata on `files`. That may require source-level metadata before this plan is safe.
- Repository update processing cannot reliably know when a full snapshot has succeeded. Do not invalidate removed functions on partial success.
- Drizzle migration generation produces broad unrelated schema changes.
- Existing UI/API contracts require old source IDs from previous chat messages to remain resolvable as current citations.
- Any implementation would delete old sources/text units instead of marking `validUntil`.

## Maintenance notes

`active` means “embedded/generated and eligible if otherwise current.” `validUntil` means “superseded by a newer code snapshot.” Future history features should query `validUntil IS NOT NULL` explicitly and should not overload current source tools with historical data.
