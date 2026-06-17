import { error as logError, warn as logWarn } from "@kiwi/logger";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { credentials } from "better-auth-credentials-plugin";
import { admin as adminPlugin, organization } from "better-auth/plugins";
import * as Effect from "effect/Effect";
import { authenticate } from "ldap-authentication";
import { z } from "zod";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@kiwi/db";
import { ac, admin as organizationAdmin, member, roleIncludes } from "./permissions";
import { deriveAuthMode, getLdapConfigState } from "./mode";
import { DEFAULT_ORGANIZATION_SLUG } from "./organization";
import { apiKey } from "@better-auth/api-key";
import * as authTables from "@kiwi/db/tables/auth";
import { and, asc, eq, ne, sql } from "drizzle-orm";

function parseBooleanEnv(value?: string) {
    if (!value) {
        return false;
    }

    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseOriginList(value?: string) {
    if (!value) {
        return [];
    }

    return [
        ...new Set(
            value
                .split(",")
                .map((origin) => origin.trim())
                .filter(Boolean)
        ),
    ];
}

const ldapConfigState = getLdapConfigState(process.env);

if (ldapConfigState.partial) {
    logWarn("LDAP configuration is incomplete; falling back to credentials auth mode", {
        missingKeys: ldapConfigState.missingKeys,
        blankKeys: ldapConfigState.blankKeys,
    });
}

export const authMode = deriveAuthMode(process.env);
const ldapEnabled = authMode === "ldap";
const trustedOrigins = parseOriginList(process.env.TRUSTED_ORIGINS);
const internalServiceOrigins = ["http://server:4321", "http://frontend:3000"];
const allTrustedOrigins = trustedOrigins.length > 0 ? [...trustedOrigins, ...internalServiceOrigins] : undefined;
const crossSubDomainCookiesEnabled = parseBooleanEnv(process.env.AUTH_CROSS_SUBDOMAIN_COOKIES);
const crossSubDomainCookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim() || undefined;

export const API_KEY_RATE_LIMIT_TIME_WINDOW = 60_000;
export const API_KEY_RATE_LIMIT_MAX_REQUESTS = 60;
const SYSTEM_ADMIN_ROLE = "admin";

let defaultOrganizationIdPromise: Promise<string> | null = null;

const ldapCredentialsSchema = z.object({
    credential: z.string().min(1),
    password: z.string().min(1),
});
type LdapCredentials = z.infer<typeof ldapCredentialsSchema>;


type LdapResult = {
    mail?: string | string[];
    displayName?: string | string[];
    description?: string | string[];
    dn?: string | string[];
    objectClass?: string | string[];
    [key: string]: unknown;
};

type AdminMembershipInput = {
    organizationId: string;
    userId: string;
};

function loadDefaultOrganizationId(): Effect.Effect<string, unknown> {
    return Effect.tryPromise(async () => {
        const [organization] = await db
            .select({ id: authTables.organizationTable.id })
            .from(authTables.organizationTable)
            .orderBy(
                sql`CASE WHEN ${authTables.organizationTable.slug} = ${DEFAULT_ORGANIZATION_SLUG} THEN 0 ELSE 1 END`,
                authTables.organizationTable.createdAt
            )
            .limit(1);

        if (!organization) {
            throw new Error("Expected a default organization");
        }

        return organization.id;
    });
}

export function getDefaultOrganizationId(): Effect.Effect<string, unknown> {
    return Effect.tryPromise(() => {
        defaultOrganizationIdPromise ??= Effect.runPromise(loadDefaultOrganizationId()).catch((error) => {
            defaultOrganizationIdPromise = null;
            throw error;
        });

        return defaultOrganizationIdPromise;
    });
}

function getInitialOrganizationId(userId: string): Effect.Effect<string, unknown> {
    return Effect.gen(function* () {
        const [membership] = yield* Effect.tryPromise(() =>
            db
                .select({ organizationId: authTables.memberTable.organizationId })
                .from(authTables.memberTable)
                .innerJoin(
                    authTables.organizationTable,
                    eq(authTables.organizationTable.id, authTables.memberTable.organizationId)
                )
                .where(eq(authTables.memberTable.userId, userId))
                .orderBy(
                    asc(authTables.memberTable.createdAt),
                    asc(authTables.organizationTable.createdAt),
                    asc(authTables.organizationTable.id)
                )
                .limit(1)
        );

        return membership?.organizationId ?? (yield* getDefaultOrganizationId());
    });
}

export function isSystemAdminRole(role: unknown) {
    return typeof role === "string" && roleIncludes(role, SYSTEM_ADMIN_ROLE);
}

function requireSystemAdminRole(user: unknown) {
    const role = user && typeof user === "object" && "role" in user ? (user as { role?: unknown }).role : null;

    if (!isSystemAdminRole(role)) {
        throw new APIError("FORBIDDEN", { message: "Only system admins can manage organizations" });
    }
}

function ensureAdminMemberships(members: AdminMembershipInput[]): Effect.Effect<void, unknown> {
    if (members.length === 0) {
        return Effect.void;
    }

    return Effect.asVoid(
        Effect.tryPromise(() =>
            db
                .insert(authTables.memberTable)
                .values(
                    members.map((member) => ({
                        ...member,
                        role: "admin",
                        systemRoleProvisioned: true,
                    }))
                )
                .onConflictDoUpdate({
                    target: [authTables.memberTable.organizationId, authTables.memberTable.userId],
                    set: {
                        role: "admin",
                        systemRoleProvisioned: true,
                    },
                    setWhere: eq(authTables.memberTable.systemRoleProvisioned, true),
                })
        )
    );
}

export function ensureSystemAdminOrganizationMemberships(userId: string): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
        const organizations = yield* Effect.tryPromise(() =>
            db.select({ id: authTables.organizationTable.id }).from(authTables.organizationTable)
        );

        yield* ensureAdminMemberships(organizations.map((organization) => ({ organizationId: organization.id, userId })));
    });
}

function removeSystemAdminOrganizationMemberships(userId: string): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
        const defaultOrganizationId = yield* getDefaultOrganizationId();

        yield* Effect.tryPromise(() =>
            db.transaction(async (tx) => {
                await tx
                    .update(authTables.memberTable)
                    .set({
                        role: "member",
                        systemRoleProvisioned: false,
                    })
                    .where(
                        and(
                            eq(authTables.memberTable.userId, userId),
                            eq(authTables.memberTable.organizationId, defaultOrganizationId),
                            eq(authTables.memberTable.systemRoleProvisioned, true)
                        )
                    );

                await tx
                    .delete(authTables.memberTable)
                    .where(
                        and(
                            eq(authTables.memberTable.userId, userId),
                            ne(authTables.memberTable.organizationId, defaultOrganizationId),
                            eq(authTables.memberTable.systemRoleProvisioned, true)
                        )
                    );
            })
        );
    });
}

function ensureOrganizationSystemAdminMembers(organizationId: string): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
        const systemAdmins = yield* Effect.tryPromise(() =>
            db
                .select({ id: authTables.userTable.id })
                .from(authTables.userTable)
                .where(
                    sql`${SYSTEM_ADMIN_ROLE} = ANY(regexp_split_to_array(btrim(COALESCE(${authTables.userTable.role}, '')), '[[:space:]]*,[[:space:]]*'))`
                )
        );

        yield* ensureAdminMemberships(systemAdmins.map((user) => ({ organizationId, userId: user.id })));
    });
}

export function ensureDefaultOrganizationMember(
    userId: string,
    role: "admin" | "member" = "member"
): Effect.Effect<string, unknown> {
    return Effect.gen(function* () {
        const organizationId = yield* getDefaultOrganizationId();

        yield* Effect.tryPromise(() =>
            db
                .insert(authTables.memberTable)
                .values({
                    organizationId,
                    userId,
                    role,
                })
                .onConflictDoUpdate({
                    target: [authTables.memberTable.organizationId, authTables.memberTable.userId],
                    set: {
                        role: sql`CASE WHEN ${authTables.memberTable.role} = 'admin' THEN ${authTables.memberTable.role} ELSE ${role} END`,
                    },
                })
        );

        return organizationId;
    });
}

function authenticateLdapCredentials(parsed: LdapCredentials) {
    return Effect.tryPromise(async () => {
        const ldapUrl = process.env.LDAP_URL as string;
        const bindDn = process.env.LDAP_BIND_DN as string;
        const bindPassword = process.env.LDAP_PASSW as string;
        const searchBase = process.env.LDAP_BASE_DN as string;
        const searchAttr = process.env.LDAP_SEARCH_ATTR as string;
        const secure = ldapUrl.startsWith("ldaps://");
        const ldapResult = (await authenticate({
            ldapOpts: {
                url: ldapUrl,
                connectTimeout: 5000,
                strictDN: true,
                ...(secure ? { tlsOptions: { minVersion: "TLSv1.2" } } : {}),
            },
            adminDn: bindDn,
            adminPassword: bindPassword,
            userSearchBase: searchBase,
            usernameAttribute: searchAttr,
            explicitBufferAttributes: ["jpegPhoto"],
            username: parsed.credential,
            userPassword: parsed.password,
        })) as LdapResult;
        const uidValue = ldapResult[searchAttr];
        const uid = Array.isArray(uidValue) ? uidValue[0] : uidValue;
        const uidString = uid ? String(uid) : parsed.credential;
        const mailValue = Array.isArray(ldapResult.mail) ? ldapResult.mail[0] : ldapResult.mail;
        const email = mailValue ? String(mailValue) : `${uidString}@local`;
        const displayName = Array.isArray(ldapResult.displayName) ? ldapResult.displayName[0] : ldapResult.displayName;
        const groups = Array.isArray(ldapResult.objectClass)
            ? ldapResult.objectClass
            : ldapResult.objectClass
              ? [ldapResult.objectClass]
              : [];

        return {
            email,
            ldap_dn: ldapResult.dn ? String(ldapResult.dn) : "",
            name: displayName ? String(displayName) : uidString,
            description: ldapResult.description ? String(ldapResult.description) : "",
            groups,
        };
    });
}

export const auth = betterAuth({
    secret: process.env.AUTH_SECRET as string,
    baseURL: process.env.AUTH_URL as string,
    database: drizzleAdapter(db, {
        provider: "pg",
        schema: {
            user: authTables.userTable,
            account: authTables.accountTable,
            verification: authTables.verificationTable,
            session: authTables.sessionTable,
            apikey: authTables.apikey,
            organization: authTables.organizationTable,
            member: authTables.memberTable,
            invitation: authTables.invitationTable,
            team: authTables.teamTable,
            teamMember: authTables.teamMemberTable,
        },
    }),
    databaseHooks: {
        user: {
            create: {
                after: async (user) => {
                    await Effect.runPromise(
                        Effect.gen(function* () {
                            yield* ensureDefaultOrganizationMember(user.id, "member");

                            if (isSystemAdminRole(user.role)) {
                                yield* ensureSystemAdminOrganizationMemberships(user.id);
                            }
                        })
                    );
                },
            },
            update: {
                after: async (user) => {
                    await Effect.runPromise(
                        isSystemAdminRole(user.role)
                            ? ensureSystemAdminOrganizationMemberships(user.id)
                            : removeSystemAdminOrganizationMemberships(user.id)
                    );
                },
            },
        },
        session: {
            create: {
                before: async (session) => {
                    const organizationId = await Effect.runPromise(getInitialOrganizationId(session.userId));

                    return {
                        data: {
                            ...session,
                            activeOrganizationId: organizationId,
                            activeTeamId: null,
                        },
                    };
                },
            },
        },
    },
    trustedOrigins: allTrustedOrigins,
    session: {
        cookieCache: {
            enabled: true,
            maxAge: 5 * 60,
        },
    },
    advanced:
        crossSubDomainCookiesEnabled || crossSubDomainCookieDomain
            ? {
                  crossSubDomainCookies: {
                      enabled: true,
                      ...(crossSubDomainCookieDomain ? { domain: crossSubDomainCookieDomain } : {}),
                  },
              }
            : undefined,
    emailAndPassword: {
        enabled: !ldapEnabled,
    },
    user: {
        // Allow users to change their own email from the Account settings Section.
        // No verification flow is configured, so the change applies immediately;
        // the Account Section is hidden entirely in LDAP mode where identity is
        // owned by the directory.
        changeEmail: {
            enabled: !ldapEnabled,
        },
    },
    socialProviders: {
        ...(process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET
            ? {
                  apple: {
                      clientId: process.env.APPLE_CLIENT_ID as string,
                      clientSecret: process.env.APPLE_CLIENT_SECRET as string,
                      appBundleIdentifier: process.env.APPLE_BUNDLE_ID ? process.env.APPLE_BUNDLE_ID : undefined,
                  },
              }
            : {}),
        ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
            ? {
                  google: {
                      clientId: process.env.GOOGLE_CLIENT_ID as string,
                      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
                  },
              }
            : {}),
        ...(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
            ? {
                  microsoft: {
                      clientId: process.env.MICROSOFT_CLIENT_ID as string,
                      clientSecret: process.env.MICROSOFT_CLIENT_SECRET as string,
                      tenantId: process.env.MICROSOFT_TENANT_ID ? process.env.MICROSOFT_TENANT_ID : undefined,
                      authority: process.env.MICROSOFT_AUTHORITY_URL ? process.env.MICROSOFT_AUTHORITY_URL : undefined,
                      prompt: "select_account",
                  },
              }
            : {}),
    },
    plugins: [
        apiKey({
            defaultPrefix: "kiwi_",
            enableSessionForAPIKeys: true,
            rateLimit: {
                enabled: true,
                timeWindow: API_KEY_RATE_LIMIT_TIME_WINDOW,
                maxRequests: API_KEY_RATE_LIMIT_MAX_REQUESTS,
            },
        }),
        adminPlugin(),
        organization({
            ac,
            allowUserToCreateOrganization: (user) => isSystemAdminRole(user.role),
            creatorRole: "admin",
            organizationHooks: {
                beforeUpdateOrganization: async ({ user }) => {
                    requireSystemAdminRole(user);
                },
                beforeDeleteOrganization: async ({ organization, user }) => {
                    requireSystemAdminRole(user);

                    if (organization.id === (await Effect.runPromise(getDefaultOrganizationId()))) {
                        throw new APIError("FORBIDDEN", { message: "The default organization cannot be deleted" });
                    }
                },
                afterCreateOrganization: async ({ organization }) => {
                    await Effect.runPromise(ensureOrganizationSystemAdminMembers(organization.id));
                },
            },
            roles: {
                admin: organizationAdmin,
                member,
            },
        }),
        ...(ldapEnabled
            ? [
                  credentials({
                      autoSignUp: true,
                      linkAccountIfExisting: true,
                      providerId: "ldap",
                      inputSchema: ldapCredentialsSchema,
                      async callback(_ctx, parsed) {
                          return Effect.runPromise(
                              Effect.catch(authenticateLdapCredentials(parsed), (error) =>
                                  Effect.gen(function* () {
                                      yield* Effect.sync(() => logError("LDAP authentication failed", { error }));
                                      return yield* Effect.fail(new Error("Invalid credentials"));
                                  })
                              )
                          );
                      },
                  }),
              ]
            : []),
    ],
});
