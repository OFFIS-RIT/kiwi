import type { Group } from "@/types";

type RoleContext = {
    isAdmin: boolean;
};

type SystemRoleContext = {
    isSystemAdmin: boolean;
};

function hasTeamGraphWriteRole(group: Group) {
    return group.scope === "team" && (group.role === "admin" || group.role === "moderator");
}

function hasTeamGraphAdminRole(group: Group) {
    return group.scope === "team" && (group.role === "admin" || group.role === "moderator");
}

export function canCreateTeam({ isAdmin }: RoleContext) {
    return isAdmin;
}

export function canManageTeam(group: Group, { isAdmin }: RoleContext) {
    return group.scope === "team" && (isAdmin || group.role === "admin");
}

export function canRenameTeam(group: Group, { isAdmin }: RoleContext) {
    return group.scope === "team" && isAdmin;
}

export function canRemoveTeamMember(group: Group, { isAdmin }: RoleContext) {
    return canManageTeam(group, { isAdmin });
}

export function canChangeTeamAdminRole(group: Group, { isAdmin }: RoleContext) {
    return group.scope === "team" && isAdmin;
}

export function canDeleteTeam(group: Group, { isAdmin }: RoleContext) {
    return group.scope === "team" && isAdmin;
}

export function canCreateProjectInGroup(group: Group, context: RoleContext) {
    if (group.scope === "organization") {
        return context.isAdmin;
    }

    return context.isAdmin || hasTeamGraphAdminRole(group);
}

export function canCreateOrganizationProject({ isAdmin }: RoleContext) {
    return isAdmin;
}

export function canCreatePersonalProject(_context: RoleContext) {
    return false;
}

export function canCreateAnyProject(groups: Group[], context: RoleContext) {
    return (
        canCreateOrganizationProject(context) ||
        canCreatePersonalProject(context) ||
        groups.some((group) => canCreateProjectInGroup(group, context))
    );
}

export function canMutateProjectInGroup(group: Group, context: RoleContext) {
    return canCreateProjectInGroup(group, context);
}

export function canOpenProjectEditorInGroup(group: Group, context: RoleContext) {
    return canMutateProjectInGroup(group, context) || canManageProjectFilesInGroup(group, context);
}

export function canManageProjectFilesInGroup(group: Group, context: RoleContext) {
    if (group.scope === "organization") {
        return context.isAdmin;
    }

    return context.isAdmin || hasTeamGraphWriteRole(group);
}

export function canViewProjectFilesInGroup() {
    return true;
}

// Mirrors the API's assertCanManageGraphSuggestions: org graphs need an org
// admin, team graphs accept team admins/moderators too. User-owned graphs are
// excluded server-side and never appear in the Group domain model.
export function canManageGraphSuggestionsInGroup(group: Group, context: RoleContext) {
    if (group.scope === "organization") {
        return context.isAdmin;
    }

    return context.isAdmin || hasTeamGraphAdminRole(group);
}

export function canAccessSystemAdmin({ isSystemAdmin }: SystemRoleContext) {
    return isSystemAdmin;
}
