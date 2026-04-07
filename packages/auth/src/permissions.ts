import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc, userAc } from "better-auth/plugins/admin/access";

export const permissionStatements = {
    ...defaultStatements,
    group: ["create", "update", "delete", "view:all", "view", "add:user", "remove:user", "list:user"],
    graph: ["view", "create", "update", "delete", "add:file", "delete:file", "list:file"],
} as const;

export type KiwiPermissions = {
    [Resource in keyof typeof permissionStatements]?: Array<(typeof permissionStatements)[Resource][number]>;
};

export const ac = createAccessControl(permissionStatements);

export const admin = ac.newRole({
    graph: [...permissionStatements.graph],
    group: [...permissionStatements.group],
    ...adminAc.statements,
});

export const manager = ac.newRole({
    group: ["view"],
    graph: [...permissionStatements.graph],
    ...userAc.statements,
});

export const user = ac.newRole({
    graph: ["view"],
    group: ["view"],
    ...userAc.statements,
});
