---
name: better-auth
description: "Framework-agnostic TypeScript authentication: configure Better Auth server/client, manage sessions, set up plugins (email/password, OAuth, 2FA, organization), and harden security."
progressive_disclosure:
  entry_point:
    summary: "Better Auth setup, plugins, and security hardening for TypeScript apps."
    when_to_use: "When configuring Better Auth, adding providers/plugins (email/password, OAuth, 2FA, organization), securing auth, or debugging auth.ts."
    quick_start: "1. Identify the area (setup, email/password, organization, 2FA, security). 2. Load the matching reference below. 3. Apply patterns to your auth config."
  references:
    - best-practices.md
    - create-auth.md
    - email-and-password.md
    - organization.md
    - two-factor.md
    - security.md
---
# Better Auth

Framework-agnostic, plugin-based authentication library for TypeScript.

**Always consult [better-auth.com/docs](https://better-auth.com/docs) for the latest API.**

## Quick Start

### Installation

```bash
npm install better-auth
```

### Environment Variables

- `BETTER_AUTH_SECRET` — encryption secret (min 32 chars). Generate: `openssl rand -base64 32`
- `BETTER_AUTH_URL` — base URL (e.g., `https://example.com`)

Only set `baseURL`/`secret` in config if env vars are not present.

### Minimal Server Setup

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { enabled: true },
});
```

### Verify

```bash
curl http://localhost:3000/api/auth/ok
# { "status": "ok" }
```

## Navigation

### Detailed References

- **[Best Practices](./references/best-practices.md)** — server/client config, database adapters, session management, plugin loading, env vars. Load when wiring up a new Better Auth instance or auditing an existing one.

- **[Create Auth](./references/create-auth.md)** — phased workflow for scaffolding auth in a new project: framework detection, adapter choice, route handlers, OAuth providers, auth UI pages. Load when adding Better Auth to a project that doesn't have it yet.

- **[Email & Password](./references/email-and-password.md)** — email verification, password reset flows, password policies, custom hashing. Load when configuring credential-based auth.

- **[Organization](./references/organization.md)** — multi-tenant organizations, members, invitations, custom roles, teams, RBAC via the `organization` plugin. Load when adding org/team features.

- **[Two-Factor](./references/two-factor.md)** — TOTP (authenticator apps), OTP via email/SMS, backup codes, trusted devices, MFA sign-in flows. Load when adding 2FA.

- **[Security](./references/security.md)** — rate limiting, secret rotation, CSRF, trusted origins, secure cookies, OAuth token encryption, IP tracking, audit logging. Load when hardening a Better Auth deployment.

## Red Flags

**Stop and reconsider if:**
- Storing secrets in source rather than env vars
- Defining `baseURL`/`secret` in config while env vars are also set (config wins, surprises follow)
- Disabling CSRF or trusted origins to "make CORS work"
- Skipping rate limiting on credential endpoints
- Adding 2FA without backup codes or recovery flow

## Related Skills

- **drizzle-orm** — database adapter and schema patterns
- **next-best-practices** — route handler integration in Next.js
- **elysiajs** — route handler integration in Elysia
