import { createAccessControl } from "better-auth/plugins/access";
import {
    adminAc as organizationAdminAc,
    defaultStatements as organizationDefaultStatements,
    memberAc,
} from "better-auth/plugins/organization/access";
import {
    adminAc as systemAdminAc,
    defaultStatements as systemDefaultStatements,
    userAc,
} from "better-auth/plugins/admin/access";

export const permissionStatements = {
    ...systemDefaultStatements,
    ...organizationDefaultStatements,
    group: ["create", "update", "delete", "view:all", "view", "add:user", "remove:user", "list:user"],
    graph: ["view", "create", "update", "delete", "add:file", "delete:file", "list:file"],
    chat: ["create"],
} as const;

export type KiwiPermissions = {
    [Resource in keyof typeof permissionStatements]?: Array<(typeof permissionStatements)[Resource][number]>;
};

export const ac = createAccessControl(permissionStatements);

export const admin = ac.newRole({
    ...organizationAdminAc.statements,
    group: [...permissionStatements.group],
    graph: [...permissionStatements.graph],
    chat: [...permissionStatements.chat],
});

export const member = ac.newRole({
    ...memberAc.statements,
    graph: ["view", "list:file"],
    chat: ["create"],
});

export const systemAdmin = ac.newRole({
    ...systemAdminAc.statements,
    group: [...permissionStatements.group],
    graph: [...permissionStatements.graph],
    chat: [...permissionStatements.chat],
});

export const manager = ac.newRole({
    ...userAc.statements,
    group: ["view"],
    graph: [...permissionStatements.graph],
    chat: [...permissionStatements.chat],
});

export const user = ac.newRole({
    ...userAc.statements,
    group: ["view"],
    graph: ["view", "list:file"],
});

export function getUserRoles(role?: string | null) {
    if (!role) {
        return [];
    }

    return [
        ...new Set(
            role
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
        ),
    ];
}

export function hasRole(role: string | null | undefined, expectedRole: string) {
    return getUserRoles(role).includes(expectedRole);
}

export function roleIncludes(role: string | null | undefined, expectedRole: string) {
    if (!role) {
        return false;
    }

    return hasRole(role, expectedRole);
}
