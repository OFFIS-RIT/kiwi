# Plan 008: Provider connectors for private repository graphs and webhook-driven updates

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1dea5eb77..HEAD -- packages/db/src/tables apps/api/src/server.ts apps/api/src/routes apps/api/src/lib apps/worker/workflows apps/worker/lib packages/contracts/src apps/frontend/app apps/frontend/components apps/frontend/lib`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: `006-support-external-github-code-files`, `007-version-code-sources-with-valid-until`
- **Category**: feature / integrations / repository sync
- **Planned at**: commit `1dea5eb77`, 2026-06-13

## Why this matters

The URL import path still starts from a public HTTPS repository URL and historically used `git clone`. That cannot cover private repositories cleanly and cannot keep a selected branch up to date. The product needs first-class provider connectors:

1. A system admin creates an instance-level connector app for GitHub/GitLab.
2. A graph manager (organization admin, team admin, or team moderator) connects that app to repositories they control.
3. KIWI lists accessible repositories and branches through the provider API.
4. The user creates a graph from a selected repo + branch.
5. Provider push webhooks enqueue rebuilds when that branch moves, so the graph stays current.

Plan 007 supplies the source invalidation model (`validUntil`) needed to replace old function evidence with latest-branch evidence instead of accumulating stale snippets.

## Current state

Relevant files:

- `packages/auth/src/permissions.ts` — graph management permission vocabulary.
- `apps/api/src/lib/team-access.ts` — organization admins, team admins, and team moderators can create/manage team graphs.
- `apps/api/src/lib/graph-access.ts` — graph create/file-manage authorization helpers.
- `apps/api/src/routes/graph.ts` — graph creation and URL-based repository import.
- `apps/api/src/lib/repository-url.ts` — public URL repo loader, external GitHub URL helper, still provider-agnostic by URL.
- `apps/api/src/server.ts` — all current routes are mounted after `authMiddleware`; webhooks need a verified unauthenticated route before auth.
- `apps/worker/workflows/process-files-spec.ts` — parent workflow already accepts `code: { kind: "repository" }`.
- `apps/worker/worker.ts` — workflow registration point.
- `packages/db/src/tables/graph.ts` and `packages/db/src/tables/auth.ts` — graph/team/user schema.
- `packages/ai/src/models.ts` — existing AES-GCM-style encrypted credential storage pattern to reuse for connector secrets.
- `apps/frontend/app/(app)/settings/page.tsx` and `apps/frontend/components/settings/sections.tsx` — system-admin UI guard pattern.
- `apps/frontend/lib/api/client.ts` and `apps/frontend/lib/api/projects.ts` — frontend API client conventions.

Current permission model:

```ts
// packages/auth/src/permissions.ts:16-18
group: ["create", "update", "delete", "view:all", "view", "add:user", "remove:user", "list:user"],
graph: ["view", "create", "update", "delete", "add:file", "delete:file", "list:file"],
chat: ["create"],
```

Current team graph manager rule:

```ts
// apps/api/src/lib/team-access.ts:140-147
export async function requireTeamGraphCreateAccess(user: AuthUser, teamId: string) {
    const access = await requireTeamAccess(user, teamId);
    if (access.organizationAdmin || access.role === "admin" || access.role === "moderator") {
        return access;
    }

    throw new Error(API_ERROR_CODES.FORBIDDEN);
}
```

Current graph creation owner resolution:

```ts
// apps/api/src/routes/graph.ts:267-289
const ownerResult = await Result.tryPromise(async () => {
    if (body.teamId) {
        const access = await assertCanCreateTeamGraph(user, body.teamId);
        return {
            ownerMode: "team" as const,
            organizationId: access.team.organizationId,
            teamId: body.teamId,
        };
    }

    if (body.graphId) {
        await assertCanCreateUnderParentGraph(user, body.graphId);
        return {
            ownerMode: "graph" as const,
            graphId: body.graphId,
        };
    }

    const access = await assertCanCreateTopLevelGraph(user);
    return {
        ownerMode: "organization" as const,
        organizationId: access.organizationId,
    };
});
```

Current URL repository add path enqueues code processing:

```ts
// apps/api/src/routes/graph.ts:807-812
const handle = await ow.runWorkflow(processFilesSpec, {
    graphId: existingGraph.id,
    fileIds: result.addedFiles.map((file) => file.id),
    processRunId: result.processRunId,
    code: { kind: "repository" },
});
```

Current repository loader still starts with a clone:

```ts
// apps/api/src/lib/repository-url.ts:161-169
export async function loadRepositoryFromUrl(input: string): Promise<LoadedRepository> {
    const repository = normalizeRepositoryUrl(input);
    const tempDir = await mkdtemp(path.join(tmpdir(), "kiwi-repository-"));
    const repoPath = path.join(tempDir, "repo");

    try {
        await runGit(["clone", "--depth", "1", "--", repository.url, repoPath], tempDir);
        const commitSha = (await runGit(["rev-parse", "HEAD"], repoPath)).trim();
```

Current route mount order means webhook routes must be special-cased:

```ts
// apps/api/src/server.ts:53-61
.use(mcpRoute)
.use(authMiddleware)
.use(authRoute)
.use(chatRoute)
...
.use(graphRoute)
```

Existing encryption pattern:

```ts
// packages/ai/src/models.ts:162-174
export function encryptModelCredentials(credentials: ModelCredentials, secret: string): string {
    const iv = randomBytes(IV_BYTE_LENGTH);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, deriveEncryptionKey(secret), iv, {
        authTagLength: AUTH_TAG_BYTE_LENGTH,
    });
    ...
}

export function decryptModelCredentials(value: string, secret: string): ModelCredentials {
```

Provider docs observed during planning:

- GitHub Apps create installation access tokens with `POST /app/installations/{installation_id}/access_tokens`; tokens expire and can be scoped to repositories and permissions. `contents: read` is the critical permission for reading repository files.
- GitHub Apps list accessible repositories with `GET /installation/repositories` using an installation token.
- GitHub push webhooks include delivery IDs and push ref/after commit data; verify `X-Hub-Signature-256` with the app webhook secret.
- GitLab push hooks include `event_name: "push"`, `ref: "refs/heads/<branch>"`, `after`, project path/id, and headers such as `X-Gitlab-Event`, `X-Gitlab-Webhook-UUID`, and `X-Gitlab-Token`.

Repo conventions:

- Run commands from the repo root.
- Do not run `bun run db:migrate`.
- Do not hand-create migrations first; for custom/manual migrations run `bun run db:generate --custom` before editing.
- Use `Result.tryPromise` in API routes for expected async errors.
- Keep comments rare; prefer small helper modules over duplicated provider logic.
- Root verification commands available: `bun run test`, `bun run lint`. At planning time, `bun run test` passed; `bun run lint` exited 0 with one existing frontend warning.

## Design decision

Build a provider connector layer rather than extending the public URL import path.

Core concepts:

- **Connector**: instance-level provider app config created by a system admin. Example: one GitHub App for this KIWI instance.
- **Connector installation/account**: a provider authorization connected by a graph manager to a KIWI owner scope. GitHub installation ID; GitLab OAuth account/project-token context.
- **Repository binding**: one KIWI graph tracks one provider repository + one branch. This binding drives manual sync and webhook sync.
- **Webhook event ledger**: stores delivery IDs and enqueue results so retries are idempotent.

Provider support for this plan:

- GitHub: full end-to-end implementation with GitHub App manifest/create flow, installation flow, repo/branch listing, content fetch, and push webhook sync.
- GitLab: implement the same DB/API/provider interface and manual sysadmin connector config, plus OAuth/project listing and webhook verification if feasible. If GitLab project webhook creation needs a broader `api` scope or self-managed-instance behavior diverges, finish GitHub and leave GitLab behind a `disabled` connector state with explicit STOP/report rather than inventing an unsafe token flow.

Security invariants:

- Connector secrets, private keys, OAuth client secrets, webhook secrets, and refresh tokens are encrypted at rest with the existing `AUTH_SECRET`-derived pattern. Never log them.
- Webhook endpoints are unauthenticated but must verify provider signatures/tokens before reading business fields or enqueueing work.
- Users can only create repository graphs in scopes where they can already manage graphs: organization admin, team admin, team moderator.
- Do not accept arbitrary raw URLs from users. Repository content comes from provider API clients using stored connector authorization.
- Webhook processing is idempotent by provider delivery ID and by `(repositoryBindingId, commitSha)`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Generate migration scaffold | `bun run db:generate --custom` | creates a new migration scaffold to edit |
| DB migration tests | `bun test packages/db/src/__tests__/migration-compat.test.ts` | exit 0 |
| API connector tests | `bun test apps/api/src/routes/__tests__ apps/api/src/lib/__tests__` | exit 0 |
| Worker connector tests | `bun test apps/worker/lib apps/worker/workflows` | exit 0 |
| Frontend tests | `bun test apps/frontend` | exit 0 |
| Workspace tests | `bun run test` | exit 0 |
| Lint | `bun run lint` | exit 0; no new errors |

## Scope

**In scope**:

- New connector DB tables and migration.
- Shared provider client/helpers, preferably a new `packages/connectors` workspace package if both API and worker need provider logic.
- New API routes under `/connectors` plus public webhook routes under `/connectors/:id/webhooks/:provider` mounted before auth middleware.
- GitHub App manifest setup UI at `/connectors/github/new` for system admins.
- Connector installation/connect UI at `/connectors/:id/connect` for graph managers.
- Repository/branch list endpoints.
- Graph creation from repository + branch.
- Worker workflow to sync a connector repository snapshot and enqueue/process code files without `git clone`.
- Push webhook handling that enqueues updates for matching branch bindings.
- Contract/frontend types and minimal UI to select connector, repo, branch, and owner scope.

**Out of scope**:

- Pull request preview graphs.
- User-facing history UI for old function versions.
- Write access to repositories.
- GitHub Checks/Statuses.
- Fine-grained per-file incremental graph updates; rebuild the selected branch snapshot and rely on plan 007 source invalidation.
- Supporting arbitrary provider URLs or Bitbucket.
- Moving existing URL import users to connectors automatically.

## Git workflow

- Branch name suggestion: `advisor/008-provider-connectors-repository-sync`.
- Commit message style: `feat(connectors): add repository graph sync`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add connector schema

Run `bun run db:generate --custom` from the repo root. Add Drizzle tables in `packages/db/src/tables/connectors.ts` or the repo's preferred table module. Export them from the package index if needed.

Suggested tables:

#### `connectors`

- `id text primary key`
- `provider text not null` enum-like: `github | gitlab`
- `name text not null`
- `slug text not null unique`
- `status text not null default 'active'` enum-like: `draft | active | disabled`
- `app_id text` — GitHub App ID or GitLab application ID.
- `client_id text`
- `encrypted_credentials text not null` — provider secrets; shape validated in code.
- `webhook_secret_encrypted text not null`
- `created_by_user_id text references user(id) on delete set null`
- timestamps

#### `connector_installations`

- `id text primary key`
- `connector_id text not null references connectors(id) on delete cascade`
- `provider text not null`
- `provider_installation_id text not null` — GitHub installation ID; GitLab account/project auth identifier.
- `provider_account_login text not null`
- `provider_account_type text` — `user | organization | group`.
- `organization_id text references organization(id) on delete cascade`
- `team_id text references team(id) on delete cascade`
- `installed_by_user_id text references user(id) on delete set null`
- `encrypted_credentials text` — GitLab OAuth refresh/access token if needed; null for GitHub App installations.
- `repository_selection text` — `all | selected | unknown`.
- `status text not null default 'active'`
- timestamps
- unique `(connector_id, provider_installation_id, organization_id, team_id)`
- check: either organization scope or team scope is present, not both unless team requires organization. For teams, require organization too if that matches existing graph team ownership.

#### `repository_graph_bindings`

- `id text primary key`
- `graph_id text not null references graphs(id) on delete cascade unique`
- `connector_installation_id text not null references connector_installations(id) on delete restrict`
- `provider text not null`
- `provider_repository_id text not null`
- `repository_full_name text not null` — `owner/repo` or GitLab `namespace/project`.
- `repository_html_url text not null`
- `branch text not null`
- `last_seen_commit_sha text`
- `last_synced_commit_sha text`
- `sync_status text not null default 'pending'` — `pending | syncing | synced | failed`.
- `sync_error_code text`
- `webhook_enabled boolean not null default true`
- timestamps
- unique `(connector_installation_id, provider_repository_id, branch)` if one branch graph per installation is desired; otherwise unique only on `graph_id` and let multiple graphs track the same branch.

#### `connector_webhook_events`

- `id text primary key`
- `connector_id text not null references connectors(id) on delete cascade`
- `provider text not null`
- `delivery_id text not null`
- `event_name text not null`
- `provider_repository_id text`
- `branch text`
- `commit_sha text`
- `status text not null` — `ignored | enqueued | duplicate | failed`.
- `error_code text`
- `created_at timestamp not null default now()`
- unique `(connector_id, provider, delivery_id)`

Add migration compatibility tests for table/column/check/index presence.

**Verify**: `bun test packages/db/src/__tests__/migration-compat.test.ts` → exit 0.

### Step 2: Add encrypted connector credential helpers

Create a small helper module, ideally in a new shared package if both API and worker consume it:

- Reuse the `packages/ai/src/models.ts` encryption approach: HKDF from `AUTH_SECRET`, random IV, auth tag, versioned string.
- Supported secret shapes:
  - GitHub connector credentials: `{ appId: string; privateKeyPem: string; clientId?: string; clientSecret?: string }`
  - GitHub webhook secret: store separately or inside credentials, but keep a dedicated accessor for verification.
  - GitLab connector credentials: `{ baseUrl: string; clientId: string; clientSecret: string }`
  - GitLab installation credentials: `{ accessToken: string; refreshToken?: string; expiresAt?: string }`
- Validate decrypted shape before returning it.

Do not export raw decrypted credentials beyond provider client factories.

**Verify**: add unit tests for encrypt/decrypt, invalid version, invalid shape, and wrong secret failure. Run the new test file.

### Step 3: Add provider client interfaces

Create provider-neutral interfaces. Suggested package: `packages/connectors/src`.

Types:

```ts
export type ConnectorProvider = "github" | "gitlab";

export type ProviderRepository = {
  provider: ConnectorProvider;
  id: string;
  fullName: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string | null;
  private: boolean;
};

export type ProviderBranch = {
  name: string;
  commitSha: string;
};

export type ProviderCodeFile = {
  path: string;
  size: number;
  checksum: string;
  htmlUrl: string;
  rawUrl?: string;
  content: string;
};
```

Client methods:

- `listRepositories(installationOrAccount)`
- `listBranches(repository)`
- `loadRepositorySnapshot(repository, branch)` returning commit SHA + supported code files.
- `verifyWebhook(request)` returning normalized event fields.
- `createOrRefreshInstallationToken(...)` for GitHub.

GitHub implementation requirements:

- Generate a GitHub App JWT with RS256 using Node/Bun crypto and the stored private key.
- Create installation tokens with `POST /app/installations/{installation_id}/access_tokens` and request at most `contents: read` plus metadata. Do not request write permissions.
- List repositories with `GET /installation/repositories` using the installation token.
- List branches with `GET /repos/{owner}/{repo}/branches`.
- Resolve the selected branch to an immutable commit SHA before loading files.
- List tree recursively via provider API; filter with existing `isSupportedCodePath` and skipped generated directories from `repository-url.ts`.
- Fetch contents via provider API using the installation token so private repositories work. Do not use unauthenticated `git clone`.
- Enforce existing repository code limits: max files, max total bytes, max per-file bytes.

GitLab implementation requirements:

- Normalize `baseUrl` and use `/api/v4`.
- Use OAuth token with the minimal workable scopes. Prefer `read_api read_repository`; if project webhook creation requires `api`, make that explicit in the connector UI and plan tests.
- List projects for the connected user/account.
- List branches and repository tree/files through GitLab API.
- Verify GitLab push webhooks with `X-Gitlab-Token` against the encrypted connector webhook secret.

**Verify**: provider unit tests with mocked `fetch` for GitHub token creation, repo listing, branch listing, content loading, and webhook verification.

### Step 4: Add system-admin connector creation routes and UI

Add an authenticated connector route module under `apps/api/src/routes/connectors.ts` and mount it after `authMiddleware`.

System-admin endpoints:

- `GET /connectors` — list active connectors visible to the current user; system admins see full config metadata but never secrets.
- `POST /connectors/github/manifest/start` — system admin only. Creates a short-lived signed state and returns a GitHub App manifest URL.
- `GET /connectors/github/manifest/callback?code&state` — system admin only. Exchanges the manifest `code` for app credentials and stores a connector.
- `POST /connectors/gitlab` — system admin only. Stores manually-created GitLab application config and webhook secret.
- `PATCH /connectors/:id` — system admin only, enable/disable/rename/rotate secrets.

GitHub App manifest defaults:

- App name: include KIWI instance name/host to avoid collisions.
- Homepage URL: configured frontend/base URL.
- Webhook URL: `${API_URL}/connectors/webhooks/github` or `${API_URL}/connectors/:id/webhooks/github` if known after creation. If connector ID is not known before creation, use provider-level route and resolve by app ID in the payload.
- Callback/setup URLs:
  - Manifest callback: `/connectors/github/callback`.
  - Installation setup URL: `/connectors/github/setup`.
- Repository permissions: `Contents: read`, `Metadata: read`.
- Events: `push`, and optionally `installation` / `installation_repositories` to keep repository access state fresh.

Frontend:

- Add `/connectors` page for listing connectors.
- Add `/connectors/github/new` page for system admins. It should show what permissions/events will be requested and a "Create GitHub App" button that calls the manifest-start endpoint then redirects to GitHub.
- Add `/connectors/gitlab/new` page for system admins with base URL, application ID, client secret, and webhook secret fields.
- Reuse the settings admin guard pattern from `apps/frontend/app/(app)/settings/page.tsx` for server-side system-admin protection.
- Add a system-admin settings link/section only if it does not duplicate the top-level `/connectors` page.

**Verify**: API tests prove non-admins get 403 for creation/patch routes and system admins can create listable connectors without secrets in responses. Frontend tests cover visibility/guard helpers if added.

### Step 5: Add graph-manager installation/connect flow

Endpoints:

- `GET /connectors/:id/connect?organizationId=...&teamId=...` — checks graph-management rights for the requested owner scope, creates signed state, redirects to provider installation/OAuth flow.
- GitHub callback/setup route: records `installation_id`, provider account, repository selection, and owner scope into `connector_installations`.
- GitLab OAuth callback: exchanges code for token, stores encrypted token under `connector_installations` for the owner scope.
- `GET /connectors/:id/installations` — list installations/accounts available to the current user for owner scopes they can manage.

Authorization rules:

- Organization scope: require organization admin.
- Team scope: require `requireTeamGraphCreateAccess`; this allows organization admin, team admin, and team moderator, matching graph creation.
- User/private graph scope is out of scope for connectors unless product explicitly asks; private provider apps create ownership ambiguity.

GitHub redirect target:

- Use the GitHub App installation URL for the connector app, e.g. `https://github.com/apps/<app-slug>/installations/new?state=<signed-state>` after the connector stores the app slug/name.
- On callback, verify state and ensure the KIWI user still has graph-management rights for the requested scope.

**Verify**: route tests cover org admin, team admin, team moderator allowed; team member denied; stale/invalid state denied; connector disabled denied.

### Step 6: Add repository and branch selection endpoints

Endpoints:

- `GET /connectors/:id/repositories?installationId=...` — list provider repositories visible through that installation/account.
- `GET /connectors/:id/repositories/:providerRepositoryId/branches?installationId=...` — list branches.

Requirements:

- Check the current user can manage the installation owner scope before listing.
- Return stable provider repository IDs, full names, default branch, private flag, and HTML URL.
- Never return provider access tokens.
- Cache repository/branch lists only if cache invalidation is clear; otherwise fetch live and paginate.
- Handle provider pagination deterministically.

Frontend:

- Add a repository picker page under `/connectors/:id/connect` after installation completes.
- Let the user choose owner scope, installation/account, repository, and branch.
- Default branch should be preselected.

**Verify**: mocked API tests for pagination, denied installation access, empty repositories, and branches. Frontend component tests for default branch preselection and disabled submit without repo/branch.

### Step 7: Create graphs from selected repository branches

Add an endpoint:

```http
POST /connectors/:id/repository-graphs
{
  "installationId": "...",
  "providerRepositoryId": "...",
  "branch": "main",
  "name": "optional display name",
  "description": "optional",
  "teamId": "optional"
}
```

Behavior:

1. Authorize the requested owner scope using the same rules as graph creation.
2. Resolve repository and branch through the provider API.
3. Insert a graph row with `state = 'updating'`, organization/team owner fields matching existing graph creation semantics.
4. Insert `repository_graph_bindings` with the selected branch and latest branch commit SHA as `last_seen_commit_sha`.
5. Enqueue a new worker workflow, e.g. `syncRepositoryGraphSpec`, with `{ bindingId, reason: 'initial', commitSha }`.
6. Return graph, binding, and workflow run ID.

Do not create all file rows synchronously in the API route. The provider API may be slow and large; the worker should load the snapshot and commit file rows/process runs.

**Verify**: API tests prove graph row + binding transactionality, owner authorization, and enqueue failure rollback/failed state behavior.

### Step 8: Add repository sync worker workflow

Add `syncRepositoryGraphSpec` and implementation in `apps/worker/workflows/sync-repository-graph.ts`. Register it in `apps/worker/worker.ts`.

Workflow input:

```ts
{
  bindingId: string;
  reason: "initial" | "webhook" | "manual";
  commitSha?: string;
  deliveryId?: string;
}
```

Workflow behavior:

1. Load binding, connector installation, connector credentials, and graph.
2. If binding/webhook disabled or graph missing, exit without side effects.
3. Resolve selected branch to commit SHA unless input already supplies one from a verified webhook.
4. If `lastSyncedCommitSha === commitSha`, mark webhook event duplicate/synced and exit.
5. Load repository snapshot through provider API, not `git clone`.
6. Convert each supported code file into an external `files` row:
   - `storageKind: 'external'`
   - `externalProvider: provider`
   - `externalUrl`: provider HTML URL or raw API URL, whichever plan 006's proxy/content-source layer supports after extension.
   - metadata: provider, repository full name/id, branch, commit SHA, path, html URL, and any API raw URL needed for worker reads.
   - checksum: provider blob SHA/content hash.
7. Use or extend `commitGraphFileUploads` so it can create file rows + process run for these external files without S3 cleanup.
8. Mark superseded file rows for this binding as deleted only after new rows/process run commit.
9. Run `processFilesSpec` with `code: { kind: 'repository' }` or direct child workflows according to plan 005.
10. Update binding `lastSeenCommitSha`, `syncStatus`, and eventually `lastSyncedCommitSha` after processing succeeds.

Integration with plan 007:

- On successful full snapshot processing, old code sources for the same binding/repository/branch must get `validUntil` and stop appearing in graph tools.
- If processing fails terminally, keep previous sources current and set binding `syncStatus = 'failed'`.

**Verify**: worker tests with mocked provider client prove no `git` process is spawned, file rows are external, older binding files are marked deleted after commit, duplicate SHA exits, and failure leaves previous binding state intact.

### Step 9: Extend external file content/proxy handling for private providers

Plan 006 introduced external GitHub files. Private connector repositories need credentialed reads.

Update content-source handling:

- Internal S3 files keep current behavior.
- Public external GitHub URL files from URL imports can keep allowlisted raw fetch behavior.
- Connector-backed external files must read through provider API using `repository_graph_bindings` + connector installation credentials, not unauthenticated raw URLs.

Add metadata or DB columns needed to locate the binding from a file row. Preferred explicit column:

- `files.repository_binding_id text references repository_graph_bindings(id) on delete set null`

If adding this column, include it in the same migration or a new migration and update file insert/select helpers.

Proxy behavior:

- For private files, do not redirect to provider raw URLs that may leak or fail.
- Either redirect to provider HTML URL for humans or proxy raw content through KIWI after graph access checks.
- If proxying bytes, preserve size limits and content type; do not stream arbitrary provider responses without host/API validation.

**Verify**: API proxy tests for public URL-import external file, private connector-backed external file, missing binding, disabled connector, and unauthorized graph access.

### Step 10: Add webhook endpoint before auth middleware

In `apps/api/src/server.ts`, mount a public webhook route before `.use(authMiddleware)`, e.g.:

```ts
.use(connectorWebhookRoute)
.use(authMiddleware)
.use(connectorRoute)
```

Webhook route requirements:

- Route: `POST /connectors/webhooks/github` and `POST /connectors/webhooks/gitlab`, or connector-specific paths if the provider can include connector ID safely.
- Read raw body for signature verification before JSON business logic.
- GitHub: verify `X-Hub-Signature-256` HMAC SHA-256 using connector webhook secret. Use `timingSafeEqual`.
- GitHub: use `X-GitHub-Event` and `X-GitHub-Delivery` for event/dedupe.
- GitLab: verify `X-Gitlab-Token` against connector webhook secret. Use `timingSafeEqual` for token bytes.
- Store a row in `connector_webhook_events` before enqueueing. Duplicate delivery returns 202 without enqueue.
- Ignore non-push events with status `ignored`.
- For push events, normalize branch from `refs/heads/<branch>` and commit from `after`; ignore branch deletes where commit is all zeroes.
- Find active bindings for `(provider repository id/full name, branch)` and enqueue `syncRepositoryGraphSpec` once per binding.
- Return 202 quickly; do not process repository contents in the API request.

**Verify**: webhook route tests cover valid signature enqueue, invalid signature 401/403 with no DB writes, duplicate delivery no duplicate enqueue, wrong branch ignored, branch delete ignored, and multiple graph bindings enqueue separately.

### Step 11: Add manual resync and status endpoints

Endpoints:

- `POST /repository-graph-bindings/:id/sync` — graph manager only; enqueue sync for current branch head.
- `GET /repository-graph-bindings/:id` — graph viewer can see sync status, provider, repo full name, branch, last seen/synced commit.
- Include binding summary in graph detail response if graph is connector-backed.

This gives operators a recovery path when provider webhook delivery fails.

**Verify**: API tests for allowed manager sync, viewer status, member denied sync, disabled binding denied.

### Step 12: Update contracts and frontend API client

Update `packages/contracts/src/routes.ts` with connector records/responses:

- Connector list/create/update responses.
- Installation list response.
- Repository list response.
- Branch list response.
- Repository graph create response.
- Binding status response.

Update `apps/frontend/lib/api` with typed functions:

- `fetchConnectors`
- `startGitHubConnectorManifest`
- `createGitLabConnector`
- `fetchConnectorInstallations`
- `fetchConnectorRepositories`
- `fetchConnectorBranches`
- `createRepositoryGraph`
- `syncRepositoryGraphBinding`

Keep API errors using existing `ApiError`/`unwrapApiResponse` patterns.

**Verify**: frontend API client unit tests with mocked `fetch` for success and error paths.

### Step 13: Add frontend pages

Add pages under `apps/frontend/app/(app)/connectors`:

- `/connectors` — connector list. System admins see create/manage actions; graph managers see connect/use actions for active connectors.
- `/connectors/github/new` — system-admin GitHub App manifest starter, with permission/event explanation.
- `/connectors/gitlab/new` — system-admin manual GitLab application config.
- `/connectors/[connectorId]/connect` — owner scope selection, provider installation/OAuth status, repository picker, branch picker, create graph button.
- Optional `/connectors/[connectorId]/repositories/new-graph` if the connect page becomes too large.

UI requirements:

- Reuse existing shadcn components from `components/ui`.
- Use existing `useAuth`, query hooks, and API client patterns.
- Never render secrets after submit.
- Show provider-specific permission copy:
  - GitHub: Contents read, Metadata read, Push webhook.
  - GitLab: read repository/API scopes needed, Push webhook token.
- After graph creation, navigate to the new project route using existing group/project routing patterns.

**Verify**: component tests for guard/visibility, disabled submit states, default branch preselection, and successful navigation callback if existing test utilities support it.

### Step 14: Update route/server tests and workflow registration tests

Add/extend tests so the new public webhook route remains before auth middleware. A regression test should prove a valid webhook without a session reaches the webhook handler while invalid signatures are rejected.

Add a worker registration test or static import test if the repo has a pattern for workflow registration; otherwise the workspace test/build will catch missing exports.

**Verify**: `bun test apps/api/src/routes/__tests__ apps/worker` → exit 0.

### Step 15: Run repo checks

**Verify**: `bun run test` → exit 0.

**Verify**: `bun run lint` → exit 0; no new errors.

## Test plan

Minimum focused tests before full checks:

1. DB schema/migration tests for connector tables, binding table, webhook event ledger, and optional `files.repository_binding_id`.
2. Credential encryption tests: no plaintext secrets in selected API responses.
3. GitHub provider client tests with mocked `fetch`:
   - app JWT/token request,
   - installation repositories,
   - branches,
   - snapshot load with limits,
   - push webhook signature verification.
4. GitLab provider client tests with mocked `fetch`:
   - OAuth token use/refresh if implemented,
   - project/branch/tree/raw file calls,
   - webhook token verification.
5. Connector route authorization tests:
   - system admin can create connector,
   - non-admin cannot,
   - org admin/team admin/team moderator can connect/install/use connector,
   - team member cannot.
6. Repository graph creation tests:
   - creates graph + binding + sync workflow atomically,
   - enqueue failure leaves a recoverable failed graph/binding state or rolls back cleanly.
7. Webhook tests:
   - valid push to selected branch enqueues sync,
   - wrong branch ignored,
   - duplicate delivery ignored,
   - invalid signature rejected before payload trust.
8. Worker sync tests:
   - no git clone,
   - external code file rows created,
   - private content read through provider API,
   - duplicate commit exits,
   - failed sync does not invalidate current sources.
9. Frontend tests for connector create/connect/repo-select forms.

## Done criteria

- [ ] System admins can create at least GitHub connectors from `/connectors/github/new` with prefilled app permissions/events and no secret exposure after creation.
- [ ] System admins can configure GitLab connector metadata or GitLab is explicitly disabled with a clear STOP/report if safe implementation is blocked.
- [ ] Org admins, team admins, and team moderators can connect a connector installation/account for scopes they manage.
- [ ] Team members and ordinary org members cannot connect/use repository connectors for graph creation.
- [ ] Users can list provider repos and branches through connector endpoints.
- [ ] Users can create a graph from selected repo + branch.
- [ ] Repository sync loads code through provider APIs, not `git clone`, and supports private GitHub repositories.
- [ ] Provider push webhooks enqueue sync only for matching active branch bindings.
- [ ] Webhook delivery handling is signature-verified and idempotent.
- [ ] Plan 007 source invalidation is used so rebuilds keep graph answers on the latest branch state.
- [ ] Manual resync endpoint exists for recovery.
- [ ] `bun test packages/db/src/__tests__/migration-compat.test.ts` exits 0.
- [ ] API, worker, frontend focused tests exit 0.
- [ ] `bun run test` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- Plan 007 is not implemented; webhook rebuilds without source invalidation will accumulate stale function evidence.
- GitHub App manifest flow cannot produce/store the private key and webhook secret for this instance; do not ask sysadmins to paste secrets into random logs or responses.
- GitLab requires broad write/admin scopes to create webhooks and the product owner has not accepted that scope.
- Elysia cannot expose raw request bodies for signature verification on the webhook route. Do not verify signatures against re-serialized JSON.
- Private repository content cannot be fetched through provider APIs within existing size/rate limits.
- Provider rate limits require queueing/backoff beyond OpenWorkflow's current retry policy; report before shipping a loop that can hammer provider APIs.
- Any test fixture includes a real provider token/private key/webhook secret. Use synthetic values only.

## Maintenance notes

Keep URL imports and connectors separate. URL imports are convenient public one-offs; connectors are authenticated, owner-scoped, branch-bound sync sources. Future providers should implement the provider interface and webhook verifier, not special-case graph routes. History features should query invalidated sources from plan 007 explicitly; current graph tools must remain latest-only.
