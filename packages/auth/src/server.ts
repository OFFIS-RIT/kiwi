import { betterAuth } from "better-auth";
import { credentials } from "better-auth-credentials-plugin";
import { admin as adminPlugin } from "better-auth/plugins";
import { authenticate } from "ldap-authentication";
import { z } from "zod";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@kiwi/db";
import { ac, admin, manager, user as userRole } from "./permissions";

const ldapEnabled = Boolean(
    process.env.LDAP_URL &&
    process.env.LDAP_BIND_DN &&
    process.env.LDAP_PASSW &&
    process.env.LDAP_BASE_DN &&
    process.env.LDAP_SEARCH_ATTR
);

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
    }),
    user: {
        modelName: "users",
    },
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
                          try {
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
                          } catch (error) {
                              console.error("LDAP authentication failed", error);
                              throw new Error("Invalid credentials");
                          }
                      },
                  }),
              ]
            : []),
    ],
});
