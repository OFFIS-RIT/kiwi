# Kiwi Frontend - Agent Guidelines

Next.js 16 App Router SPA for knowledge management. Uses TanStack Query for
server state, React Context for client state, Radix UI + Tailwind CSS for
components.

## Build Commands

```bash
# Development (Turbopack)
bun run dev

# Production build
bun run build

# Lint & format
bun run lint
bun run lint:fix
bun run format
bun run format:check
```

## Code Style

### Formatting (Oxfmt enforced)

- Double quotes, semicolons, 2-space indentation
- Trailing commas: ES5
- Run `bun run format` before committing

### Imports

- Use `@/` path alias for absolute imports
- Group: React → external deps → internal (`@/...`)

```typescript
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useData } from "@/providers";
```

### Naming Conventions

| Element           | Convention                    | Example                                    |
| ----------------- | ----------------------------- | ------------------------------------------ |
| Component files   | PascalCase                    | `ProjectCard.tsx`, `CreateGroupDialog.tsx` |
| Hook files        | kebab-case with `use-` prefix | `use-data.ts`, `use-local-storage.ts`      |
| Component exports | Named function                | `export function ProjectCard()`            |
| Page/Layout files | Default export                | `export default function Page()`           |
| Types             | PascalCase                    | `Group`, `Project`, `ApiError`             |

### Component Structure

- Feature-based folders under `components/`
- Each folder has `index.ts` barrel export
- Add new components to both local and root `index.ts`

```
components/
├── admin/          # User management (UserTable, CreateUserDialog, UserManagementSheet)
├── auth/           # Login/Register UI (AuthPage, LoginForm, RegisterForm)
├── chat/           # Chat feature
├── groups/         # Group CRUD dialogs, cards
├── projects/       # Project CRUD dialogs, cards
├── header/         # App header components (UserNav with auth integration)
├── sidebar/        # Navigation sidebar
├── common/         # Shared utilities (StateDisplay, LoadingFallback)
├── ui/             # Primitives (Radix + Tailwind) - DO NOT EDIT directly
└── index.ts        # Root barrel export
```

## Project Structure

```
app/
  layout.tsx        # Root layout (fonts, metadata, Toaster)
  page.tsx          # Single-page dashboard (state-driven routing)
  globals.css       # Tailwind styles

components/         # Feature-based component folders

hooks/
  use-data.ts       # TanStack Query hooks (groups, projects, files)
  use-local-storage.ts

lib/
  api/
    client.ts       # Centralized fetch wrapper with ApiError + auth token injection
    groups.ts       # Group/project API functions
  auth-client.ts    # better-auth React client (JWT, Admin, Credentials plugins)
  auth-permissions.ts  # Role/permission definitions (local copy of auth/src/permissions.ts)
  utils.ts          # cn() utility for Tailwind classes

providers/
  AppProviders.tsx  # Composes all providers
  AuthProvider.tsx  # Auth session gate + useAuth() hook (role, permissions, signOut)
  DataProvider.tsx  # Groups/projects data context
  NavigationProvider.tsx  # Selected group/project state (persisted)
  LanguageProvider.tsx    # i18n context
  ThemeProvider.tsx       # Dark/light mode
  QueryProvider.tsx       # TanStack Query client

types/
  api.ts            # API response types
  domain.ts         # Domain types (Group, Project)
```

## State Management

### Server State (TanStack Query)

All API interactions go through hooks in `hooks/use-data.ts`:

```typescript
// Fetching
const { data: groups, isLoading } = useGroupsWithProjects();

// Mutations with optimistic updates
const updateProject = useUpdateProject();
await updateProject.mutateAsync({ projectId, name });
```

Query keys defined in `queryKeys` object for cache invalidation.

### Client State (React Context)

- `useAuth()` - session, user, role, permissions, `hasPermission()`, `signOut()`, `getToken()`
- `useNavigation()` - selected group/project, persisted to localStorage
- `useLanguage()` - i18n with `t("key")` function
- `useData()` - groups data and mutations
- `useTheme()` - dark/light mode

## API Integration

### Client (`lib/api/client.ts`)

```typescript
import { apiClient, streamSSERequest, ApiError } from "@/lib/api";

// Standard requests
const data = await apiClient.get<ResponseType>("/endpoint");
await apiClient.post("/endpoint", body);
await apiClient.patch("/endpoint", body);
await apiClient.delete("/endpoint");

// File uploads
await apiClient.postFormData("/endpoint", formData);

// Streaming (SSE for chat)
await streamSSERequest("/projects/1/stream", body, onEvent, onError);
```

### Error Handling

```typescript
try {
  await apiClient.post("/endpoint", data);
} catch (err) {
  if (err instanceof ApiError) {
    console.error(err.status, err.body);
  }
}
```

## Authentication & Authorization

### Auth Flow

The `AuthProvider` wraps the app and gates access:

- No session → renders login/register page (`AuthPage`)
- Session exists → renders dashboard (children)
- `useAuth()` provides role, permissions, and `hasPermission()` for RBAC

### Role-Based Visibility

UI elements are hidden (not disabled) based on permissions:

```typescript
const { hasPermission } = useAuth();
{hasPermission("group.create") && <CreateGroupButton />}
```

Roles: `admin` (full access), `manager` (projects + files), `user` (read-only + chat).

### Token Management

- `lib/auth-client.ts` provides `getToken()` which caches JWTs for 4 minutes
- `lib/api/client.ts` calls `getToken()` before every request (fetch, XHR, SSE)
- On 401 response: token cache is cleared and user is signed out

### Permissions Sync

`lib/auth-permissions.ts` is a local copy of `auth/src/permissions.ts` (Turbopack
cannot resolve imports outside the project root). Keep these files in sync when
changing role definitions.

## Testing

```bash
# Run frontend tests
bun run test

# Run tests in watch mode
bun run test:watch
```

Tests use Vitest + React Testing Library + MSW. Config: `vitest.config.ts`,
setup: `vitest.setup.tsx`. Test files are co-located: `*.test.tsx` / `*.test.ts`.

## Patterns

### Dynamic Imports for Dialogs

Large dialogs are lazy-loaded to reduce bundle size:

```typescript
const EditGroupDialog = lazy(() =>
  import("@/components/groups").then((mod) => ({
    default: mod.EditGroupDialog,
  }))
);

// Usage
<Suspense fallback={null}>
  <EditGroupDialog open={open} onOpenChange={setOpen} />
</Suspense>
```

### Client Components

Interactive components require the directive:

```typescript
"use client";

import { useState } from "react";
// ...
```

### Internationalization

Wrap user-facing text with translation function:

```typescript
const { t } = useLanguage();
return <p>{t("no.group.selected")}</p>;
```

## Anti-Patterns

| Do NOT                         | Do Instead                                   |
| ------------------------------ | -------------------------------------------- |
| Edit `components/ui/` directly | Use Shadcn CLI or create wrapper             |
| Use `fetch()` directly         | Use `apiClient` from `@/lib/api`             |
| Store server state in useState | Use TanStack Query hooks                     |
| Create new routes in `app/`    | Add navigation state to `NavigationProvider` |
| Skip barrel exports            | Add to `index.ts` in component folder        |

## Key Dependencies

| Package                  | Purpose                              |
| ------------------------ | ------------------------------------ |
| `@tanstack/react-query`  | Server state management              |
| `next-themes`            | Theme switching                      |
| `sonner`                 | Toast notifications                  |
| `lucide-react`           | Icons                                |
| `recharts`               | Charts                               |
| `better-auth`            | Auth client SDK (JWT, Admin plugins) |
| `fuse.js`                | Client-side fuzzy search             |
| `react-markdown`         | Markdown rendering in chat           |
| `remark-math`            | Math syntax (`$` / `$$`) in markdown |
| `rehype-katex` / `katex` | LaTeX math rendering in chat         |
