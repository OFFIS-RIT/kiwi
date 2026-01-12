import { betterAuth } from 'better-auth';
import { jwt, admin as adminPlugin } from 'better-auth/plugins';
import { ac, admin, manager, user as userRole } from './permissions';
import { Pool } from 'pg';
import { env } from 'bun';

// Custom resources to include in JWT (excludes admin/user inherited permissions)
const customResources = ['group', 'project'] as const;

// Map role names to their permission statements
const rolePermissions: Record<string, Record<string, readonly string[]>> = {
    admin: admin.statements,
    manager: manager.statements,
    user: userRole.statements,
};

// Flatten permissions into "resource.action" format
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
        enabled: true,
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
            }
        }),
        adminPlugin({
            ac: ac,
            roles: {
                admin,
                user: userRole,
                manager,
            },
        }),
    ],
});
