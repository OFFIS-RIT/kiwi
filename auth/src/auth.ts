import { betterAuth } from 'better-auth';
import { credentials } from 'better-auth-credentials-plugin';
import { jwt, admin as adminPlugin } from 'better-auth/plugins';
import { authenticate } from 'ldap-authentication';
import { Pool } from 'pg';
import { z } from 'zod';
import { ac, admin, manager, user as userRole } from './permissions';
import { env } from 'bun';

const customResources = ['group', 'project'] as const;

const rolePermissions: Record<string, Record<string, readonly string[]>> = {
    admin: admin.statements,
    manager: manager.statements,
    user: userRole.statements,
};

function getPermissionStrings(role: string | undefined): string[] {
    const statements = rolePermissions[role ?? 'user'] ?? {};
    const permissions: string[] = [];
    for (const resource of customResources) {
        const actions = statements[resource];
        if (actions) {
            for (const action of actions) {
                permissions.push(`${resource}.${action}`);
            }
        }
    }
    return permissions;
}

const ldapEnabled = Boolean(
    env.LDAP_URL &&
        env.LDAP_BIND_DN &&
        env.LDAP_PASSW &&
        env.LDAP_BASE_DN &&
        env.LDAP_SEARCH_ATTR,
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
    secret: env.AUTH_SECRET as string,
    baseURL: env.AUTH_URL as string,
    database: new Pool({
        connectionString: env.DATABASE_URL as string,
    }),
    user: {
        modelName: 'users',
    },
    emailAndPassword: {
        enabled: !ldapEnabled,
    },
    socialProviders: {
        ...(env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET
            ? {
                  apple: {
                      clientId: env.APPLE_CLIENT_ID as string,
                      clientSecret: env.APPLE_CLIENT_SECRET as string,
                      appBundleIdentifier: env.APPLE_BUNDLE_ID ? env.APPLE_BUNDLE_ID : undefined,
                  },
              }
            : {}),
        ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
            ? {
                  google: {
                      clientId: env.GOOGLE_CLIENT_ID as string,
                      clientSecret: env.GOOGLE_CLIENT_SECRET as string,
                  },
              }
            : {}),
        ...(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
            ? {
                  microsoft: {
                      clientId: env.MICROSOFT_CLIENT_ID as string,
                      clientSecret: env.MICROSOFT_CLIENT_SECRET as string,
                      tenantId: env.MICROSOFT_TENANT_ID ? env.MICROSOFT_TENANT_ID : undefined,
                      authority: env.MICROSOFT_AUTHORITY_URL
                          ? env.MICORSOFT_AUTHORITY_URL
                          : undefined,
                      prompt: 'select_account',
                  },
              }
            : {}),
    },
    plugins: [
        jwt({
            jwt: {
                definePayload: ({ user }) => ({
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    permissions: getPermissionStrings(user.role),
                }),
            },
        }),
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
                      providerId: 'ldap',
                      inputSchema: ldapCredentialsSchema,
                      async callback(_ctx, parsed) {
                          const ldapUrl = env.LDAP_URL as string;
                          const bindDn = env.LDAP_BIND_DN as string;
                          const bindPassword = env.LDAP_PASSW as string;
                          const searchBase = env.LDAP_BASE_DN as string;
                          const searchAttr = env.LDAP_SEARCH_ATTR as string;
                          const secure = ldapUrl.startsWith('ldaps://');
                          const ldapResult = (await authenticate({
                              ldapOpts: {
                                  url: ldapUrl,
                                  connectTimeout: 5000,
                                  strictDN: true,
                                  ...(secure ? { tlsOptions: { minVersion: 'TLSv1.2' } } : {}),
                              },
                              adminDn: bindDn,
                              adminPassword: bindPassword,
                              userSearchBase: searchBase,
                              usernameAttribute: searchAttr,
                              explicitBufferAttributes: ['jpegPhoto'],
                              username: parsed.credential,
                              userPassword: parsed.password,
                          })) as LdapResult;
                          const uidValue = ldapResult[searchAttr];
                          const uid = Array.isArray(uidValue) ? uidValue[0] : uidValue;
                          const uidString = uid ? String(uid) : parsed.credential;
                          const mailValue = Array.isArray(ldapResult.mail)
                              ? ldapResult.mail[0]
                              : ldapResult.mail;
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
                              ldap_dn: ldapResult.dn ? String(ldapResult.dn) : '',
                              name: displayName ? String(displayName) : uidString,
                              description: ldapResult.description ? String(ldapResult.description) : '',
                              groups,
                          };
                      },
                  }),
              ]
            : []),
    ],
});
