import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc, userAc } from "better-auth/plugins/admin/access";

const statement = { 
    ...defaultStatements,
    group: ["create", "update", "delete", "view:all", "view", "add:user", "remove:user", "list:user"],
    project: ["create", "update", "delete", "add:file", "delete:file", "list:file"], 
} as const; 

export const ac = createAccessControl(statement); 

export const admin = ac.newRole({
    project: [...statement.project],
    group: [...statement.group],
    ...adminAc.statements,
});

export const manager = ac.newRole({
    group: ["view"],
    project: [...statement.project],
    ...userAc.statements,
});

export const user = ac.newRole({
    group: ["view"],
    ...userAc.statements,
});
