# Kiwi

Kiwi turns uploaded files into a queryable knowledge graph. Users upload files to a project; each file is processed through a pipeline that extracts text, chunks it, and builds graph entities and relationships that power chat and retrieval.

## Language

### Core structure

**Organization**:
The top-level tenant. Every deployment runs around a single auto-created Default Organization (slug `default-org`) that every user joins automatically on creation; only System Admins may create, rename, or delete Organizations. Multi-organization support exists in the schema but is not a designed-for product scenario.
_Avoid_: designing UI that assumes users choose between Organizations.

**Team**:
A unit within exactly one Organization, with its own membership roles (Team Admin, Team Moderator, Team Member). The UI labels Teams as "Groups" / „Gruppen" — the sidebar's "Groups" are Teams. Only Organization Admins and System Admins may create a Team (and rename or delete it); Team Admins manage membership and Team-scoped Projects but cannot create, rename, or delete the Team.
_Avoid_: "Group" in domain docs (UI label only); confusing Team membership with Organization membership.

**Graph**:
The knowledge graph that holds a Project's Files, entities, and relationships. One Project = one graph: the UI says "Project" / „Projekt", code and API say graph — the same object. Every graph is owned by exactly one of: a user (personal Project), a Team (shown under that "Group"), or the Organization directly (shown under the "Organization" pseudo-group).
_Avoid_: "Project" in domain docs when the data object is meant; "graph" in visible UI copy.

### Files & processing

**File**:
A user-uploaded document (PDF, DOCX, etc.) belonging to a project's graph. The unit users see, upload, retry, and delete.
_Avoid_: document (reserved for the parsed internal representation), attachment, upload.

**File Type**:
A supported processing category assigned to a File, such as PDF, spreadsheet, image, email, JSON, or text. Users may see extension examples for clarity, but the category is the unit whose processing behavior is configured.
_Avoid_: GraphFileType in visible UI copy; document type.

**Extraction Mode**:
The File Type processing choice that determines whether readable content is extracted as text, with OCR as needed, or through OCR. German UI: „Extraktionsmodus".
_Avoid_: Document Mode in visible UI copy; Dokumentenmodus.

**Chunk Size**:
The maximum target size, in tokens, for chunks produced during File processing when a File Type supports configurable chunking. German UI: „Chunk-Größe".
_Avoid_: character count; Abschnittsgröße.

**Processing Status**:
The coarse lifecycle state of a File, used to group files in the UI. Exactly three values: `processing`, `processed`, `failed`. A freshly-added file is `processing`.
_Avoid_: "ready", "pending", "queued" as _status_ values — these are not statuses (see Process Step).

**Process Step**:
The fine-grained pipeline cursor within a File that is `processing`: `pending → preprocessing → metadata → chunking → extracting → deduplicating → saving → completed` (plus `failed`). Surfaced as sub-detail under the Processing group; not a top-level grouping.
_Avoid_: "stage", "phase".

**Retry**:
Re-submitting a `failed` File for processing. Creates a new Process Run for that single file and re-enqueues the processing workflow; it does not re-upload the file.
_Avoid_: reprocess, re-upload, restart.

**Process Run**:
One execution of the processing workflow over a set of files, recorded for tracking. A Retry produces a new Process Run scoped to the one retried file.

**Failure reason**:
The user-facing explanation of why a File reached `failed` status, drawn from a fixed set of process error codes (e.g. unsupported file type, password protected, no readable text). Always shown alongside a failed File so the user knows what needs attention.
_Avoid_: error message (the raw exception text is internal; the reason is the classified, human-readable category).

### Suggestions

**Suggestion**:
A pending change to graph data proposed from chat — when a user corrects an answer or contributes missing facts, the chat stores a Suggestion instead of changing the graph. Reviewed by whoever may manage the Project; never applied automatically. Two kinds: Source Correction and Entity Addition. Personal (user-owned) Projects have no suggestion management — nobody, not even an Organization Admin, may review them.
_Avoid_: "correction" as the umbrella term (that is one kind), "proposal", "feedback".

**Source Correction**:
The Suggestion kind that, when applied, rewrites an existing source's description. German UI: „Quellen-Korrektur".

**Entity Addition**:
The Suggestion kind that, when applied, records new factual information about an existing entity as a manual source. German UI: „Ergänzung".

**Apply (a Suggestion)**:
Accepting a Suggestion and writing its change into the graph. Irreversible. German UI: „Annehmen".
_Avoid_: "accept", "approve", "merge".

**Dismiss (a Suggestion)**:
Rejecting a Suggestion. Permanently removes it — there is no "rejected" state and no undo. German UI: „Ablehnen".
_Avoid_: "delete" (it is a review decision, not housekeeping), "archive".

### Prompts

**Prompt**:
A persistent, user-authored guidance text that Kiwi injects invisibly into chat context — not the message a user types into chat. Scoped to exactly one of: the Organization, a user, a Team, or a graph; in the product each scope holds at most one Prompt (the storage layer's capacity for several per scope is latent and not exposed). German UI: „Prompt" (used verbatim, not translated).
_Avoid_: "instruction", "guidance", "custom instruction" as the product term; using "prompt" for the chat input message when Prompts (this concept) are in scope; designing UI around multiple Prompts per scope.

**Organization Prompt**:
A Prompt scoped to the Organization — the most general layer, injected into every chat in the deployment, including chats on personal Projects. Managed by System Admins only.
_Avoid_: confusing it with the Graph Prompts of organization-owned Projects (those apply to one Project each).

**User Prompt**:
A Prompt owned by a single user, applying to all of that user's chats. Managed by the user themselves; Organization Admins and System Admins may also manage other users' Prompts.

**Team Prompt**:
A Prompt scoped to a Team, applying to chats on that Team's Projects. Managed by Team Admins, Organization Admins, and System Admins.

**Graph Prompt**:
A Prompt scoped to one graph, applying to chats on that Project. In UI copy this surfaces as a Project prompt (graphs are labeled "Projects" in the UI). Management follows the graph's owner: user-owned → only the owner; team-owned → Team Admin and up; organization-owned → Organization Admin and up.
_Avoid_: "Project Prompt" in domain docs (the domain object is the graph), "Graph-Prompt" in visible German UI copy (say „Projekt").

### AI Models

**AI Model**:
A configured record that makes a provider's model usable in Kiwi — display name, model type, adapter, Provider Model, write-only credentials, and a per-type default flag. The unit System Admins create, edit, delete, and set as default, and the unit users pick in the chat model selector. Two AI Models may point to the same Provider Model via different adapters or credentials. German UI: „KI-Modell".
_Avoid_: "Model" unqualified (ambiguous with database models and Provider Models), "LLM" (model types include embedding, audio, and video).

**Provider Model**:
The provider-side identifier an AI Model points to (e.g. `gpt-5.5`) — a field within an AI Model, not a standalone object. Distinct from `model_id`, which is Kiwi's own canonical identifier for the AI Model record; `model_id` stays out of list views and is shown only in the edit dialog. UI label: "Provider model name" / „Provider-Modell-Name".
_Avoid_: "model name" unqualified (ambiguous with display name).

### Settings

**Settings Section**:
One individual settings item the user navigates to and configures — e.g. Appearance, API Keys, User Management. The leaf the user clicks in the settings sidebar; each Section renders its own panel.
_Avoid_: "tab", "page" (a Section is not a separate page — see Settings below), "setting" (singular, ambiguous with an individual field).

**Settings Category**:
A grouping/heading that holds related Sections in the settings sidebar — e.g. General, Administration, System Admin. Purely organizational; the user does not navigate _to_ a Category. A Category is hidden entirely when the user lacks the rights for all of its Sections (e.g. System Admin is invisible to non-system-admins).
_Avoid_: "Group" (reserved for a Team — the sidebar's "Groups" are Teams, an unrelated concept), "area".

**Administration (Category)**:
The Settings Category for organization- and team-scoped administration, distinct from the global System Admin Category. Visible to anyone who may see at least one of its Sections; each Section gates its own visibility, so members of the category's audience may see different subsets (e.g. Team Moderators see Suggestions but not the Prompts Section, which requires Team Admin or above).
_Avoid_: "Admin" unqualified (ambiguous with System Admin), "Org Admin settings", assuming everyone who sees the Category sees all its Sections.

**Personalization (Section)**:
The Settings Section in the General Category where a user manages things that shape their own experience — initially their own User Prompts. Visible to every user. German UI: „Personalisierung".
_Avoid_: "My Prompts" as the Section name (Personalization may grow beyond Prompts).

**Prompts (Section)**:
The Settings Section in the Administration Category where all non-personal Prompts are managed: the Organization Prompt (block visible to System Admins only), then per Team its Team Prompt and per Project its Graph Prompt. Visible only to those who may manage at least one of these Prompts — Team Admin and above; Team Moderators do not see it. User-owned (personal) Projects are not managed here. German UI: „Prompts".
_Avoid_: confusing it with Personalization (where users manage their own User Prompt); "Team & Project Prompts" in UI copy (UI says „Gruppen"/"Groups", not Teams).

**AI Models (Section)**:
The Settings Section in the System Admin Category where System Admins manage AI Models: list, create, edit, delete, and set per-type defaults. Backend access is gated per Organization Admin, but like the Organization Prompt this is deployment-wide infrastructure managed by System Admins — it is not designed for the latent standalone Organization Admin persona. German UI: „KI-Modelle".
_Avoid_: placing it in the Administration Category; "Models" unqualified as the section name.

**System Configuration (Section)**:
The Settings Section in the System Admin Category where System Admins manage deployment-wide operational settings. German UI: „Systemkonfiguration".
_Avoid_: "Configuration" unqualified; placing it in the Administration Category; treating it as Team or Organization Member configuration.

**Color Mode**:
The appearance preference that determines whether Kiwi renders the light or dark variant of the selected Theme Preset. Values are light, dark, and system.
German UI: „Farbmodus".
_Avoid_: "theme" when only brightness is meant, "dark mode" as an umbrella term.

**Theme Preset**:
A curated appearance option that changes Kiwi's authenticated app visual style and includes both light and dark variants. In v1, Kiwi offers a small built-in set of Theme Presets, and a user's selection is a personal appearance preference configured in the Appearance Settings Section. Theme Presets do not apply to the Login page; only Color Mode does.
German UI: „Design".
_Avoid_: "user theme" for built-in presets, "color theme", "palette" as the product term.

**Default Theme Preset**:
The neutral baseline Theme Preset from the tweakcn theme language. It is distinct from Kiwi's previous visual style and is selected when a user has not chosen another Theme Preset.
_Avoid_: using "Default" to mean the current Kiwi look.

**Codex + Theme Preset**:
The built-in Theme Preset that starts from Kiwi's previous visual style. Its token values may be refined later without changing the preset's identity.
Internal preset id: `codex-plus`.
_Avoid_: treating Codex + as the fallback/default preset.

### Roles and admin scopes

Kiwi has separate role scopes. The literal value `admin` appears in the system user role, the Organization membership role, and the Team membership role; never write or discuss "admin" unqualified when the scope matters.
_Avoid_: "Super Admin", "Owner", "Group Owner" (not modeled roles), treating Organization and Team roles as global user roles.

**Regular User**:
A user whose `user.role` does not contain `admin`. Has no global administration rights; access comes from Organization and Team memberships. In Better Auth this may appear as the system role `user`, but in product language prefer Regular User unless the raw stored role is relevant.
_Avoid_: "Member" for the global user role (member is an Organization or Team membership role).

**System Admin**:
A user whose `user.role` contains `admin`. Global and cross-organization: manages all users everywhere (create, edit, ban, delete, assign system role) and is the only role that may create/rename/delete Organizations. This is the `isSystemAdmin` flag; it gates the System Admin settings Category.
System Admins are treated as effective Organization Admins for existing Organizations, but the concepts remain distinct.
_Avoid_: conflating with Organization Admin, "Org Admin" as shorthand for System Admin.

**Organization Admin**:
A member whose `member.role` is `admin` _within a given Organization_. Scoped to that one Organization: manages its Teams ("Groups"), Projects, and chats. This is part of the `isAdmin` flag (`isSystemAdmin` OR org-admin). Org-admin powers are exercised inline in the app sidebar and in the Administration settings Category.
In practice this role is only ever held by System Admins: there is no UI or API to assign it, every deployment runs a single auto-created Default Organization, and System Admins are auto-provisioned as org-admin members of every Organization. Treat the standalone Organization Admin as a latent role in the schema, not a persona to design UI for.
_Avoid_: calling this simply "admin" without qualification — unqualified "admin" is ambiguous between the two axes; designing features around a standalone Organization Admin persona.

**Organization Member**:
A member whose `member.role` is `member` within a given Organization. Scoped to that one Organization. Can access organization-scoped content according to membership permissions, but cannot manage Organizations, Teams, Projects, or members unless they also hold a Team role for a Team-scoped Project.
_Avoid_: assuming Organization membership alone grants Team membership.

**Team Admin**:
A Team member whose `team_member_roles.role` is `admin` within a given Team. The UI currently labels Teams as "Groups", so "Group Admin" in UI discussion maps to Team Admin in the domain model. Team Admins can manage Team members and Team-scoped Projects/files. They cannot rename or delete the Team itself; that remains an Organization Admin action.
_Avoid_: "Group Admin" in domain docs unless explicitly referring to visible UI copy.

**Team Moderator**:
A Team member whose `team_member_roles.role` is `moderator` within a given Team. Team Moderators can create and manage Team-scoped Projects/files, but cannot manage Team members, assign Team Admins, rename Teams, or delete Teams.
_Avoid_: treating Moderator as a weaker Organization Admin; it is only a Team-scoped Project management role.

**Team Member**:
A Team member whose `team_member_roles.role` is `member` within a given Team. Team Members can access Team-scoped Projects/chats, but cannot create or manage Team Projects/files or Team membership.
_Avoid_: using "member" without the Organization/Team qualifier when the scope matters.
