import { betterAuth } from "better-auth";
import { credentials } from "better-auth-credentials-plugin";
import { admin as adminPlugin } from "better-auth/plugins";
import { Result } from "better-result";
import { authenticate } from "ldap-authentication";
import { z } from "zod";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@kiwi/db";
import { ac, admin, manager, user as userRole } from "./permissions";
import * as authTables from "@kiwi/db/tables/auth";

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

    return [...new Set(value.split(",").map((origin) => origin.trim()).filter(Boolean))];
}

const ldapEnabled = Boolean(
    process.env.LDAP_URL &&
    process.env.LDAP_BIND_DN &&
    process.env.LDAP_PASSW &&
    process.env.LDAP_BASE_DN &&
    process.env.LDAP_SEARCH_ATTR
);
const trustedOrigins = parseOriginList(process.env.TRUSTED_ORIGINS);
const crossSubDomainCookiesEnabled = parseBooleanEnv(process.env.AUTH_CROSS_SUBDOMAIN_COOKIES);
const crossSubDomainCookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim() || undefined;

const ldapCredentialsSchema = z.object({
    credential: z.string().min(1),
    password: z.string().min(1),
});

type LdapResult = {
    mail?: string | string[];
    displayName?: string | string[];
    description?: string | string[];
    dn?: string | string[];
    objectClass?: string | string[];
    [key: string]: unknown;
};

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
        },
    }),
    trustedOrigins: trustedOrigins.length > 0 ? trustedOrigins : undefined,
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
        adminPlugin({
            ac: ac,
            roles: {
                admin,
                user: userRole,
                manager,
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
                          const ldapAuthResult = await Result.tryPromise(async () => {
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
                              const displayName = Array.isArray(ldapResult.displayName)
                                  ? ldapResult.displayName[0]
                                  : ldapResult.displayName;
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

                          if (ldapAuthResult.isErr()) {
                              console.error("LDAP authentication failed", ldapAuthResult.error);
                              throw new Error("Invalid credentials");
                          }

                          return ldapAuthResult.value;
                      },
                  }),
              ]
            : []),
    ],
});
